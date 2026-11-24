#!/usr/bin/env python3
"""On-demand gate for Truvian's evaluator adapter executors (scorer VPS).

Each registered adapter has its own `adapterexec` process (one package per
process, about 2.1 GB resident), and the node calls them rarely: an empty
liveness check and a scored batch at registration, a batch for the hidden
benchmark, then live scoring once the intent is used. Keeping every executor
resident leaves no memory for training, so the gate starts an executor's
systemd unit when a request for it arrives, waits until it listens, forwards
the request, and stops the unit after IDLE_SECONDS with no request. Starting one
executor first stops any other that is not serving a request, so at most one
is resident beside a training run unless two are called at the same moment.

nginx sends every runnable-URL request here (127.0.0.1:8090). ROUTES maps a
path prefix to a unit and its port; the first match wins, so "/" goes last.
A request the executor cannot be started for is answered 503, never a score.
"""
import http.client
import json
import socket
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROUTES = [
    # (path prefix, systemd unit, executor port, strip the prefix before forwarding)
    ("/oer/", "truvian-scorer-oer", 8082, True),
    ("/lle/", "truvian-scorer-lle", 8083, True),
    ("/coa/", "truvian-scorer-coa", 8084, True),
    ("/crl/", "truvian-scorer-crl", 8085, True),
    ("/", "truvian-scorer", 8080, False),
]
LISTEN = ("127.0.0.1", 8090)
IDLE_SECONDS = 15 * 60
START_TIMEOUT = 120
# A scored batch of 30 texts takes about 6 minutes on this CPU; the node allows 30.
UPSTREAM_TIMEOUT = 1900

state = {unit: {"last": 0.0, "inflight": 0} for _, unit, _, _ in ROUTES}
lock = threading.Lock()
starting = {unit: threading.Lock() for _, unit, _, _ in ROUTES}


def log(msg):
    print(time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), msg, flush=True)


def listening(port):
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=1):
            return True
    except OSError:
        return False


def batch_like(body):
    """True for no body or a JSON object carrying a batch list; the node's
    liveness check may send either, so only a non-empty non-batch body (the
    form posts scanners send) is refused."""
    if not body:
        return True
    try:
        obj = json.loads(body or b"")
    except ValueError:
        return False
    return isinstance(obj, dict) and isinstance(obj.get("batch"), list)


def ensure_running(unit, port):
    if listening(port):
        return True
    with starting[unit]:
        if listening(port):
            return True
        # one resident executor at a time beside training: stop the others that are not serving
        for _, other, oport, _ in ROUTES:
            with lock:
                busy = state[other]["inflight"] > 0
            if other != unit and not busy and listening(oport):
                log(f"stopping {other} to make room for {unit}")
                subprocess.run(["systemctl", "stop", other], check=False)
        log(f"starting {unit}")
        subprocess.run(["systemctl", "start", unit], check=False)
        deadline = time.time() + START_TIMEOUT
        while time.time() < deadline:
            if listening(port):
                log(f"{unit} listening on {port}")
                return True
            time.sleep(1)
    log(f"{unit} did not listen on {port} within {START_TIMEOUT}s")
    return False


def reaper():
    while True:
        time.sleep(30)
        now = time.time()
        for _, unit, port, _ in ROUTES:
            with lock:
                s = state[unit]
                idle = s["inflight"] == 0 and now - s["last"] > IDLE_SECONDS
            if idle and listening(port):
                log(f"stopping {unit}: idle {int(now - state[unit]['last'])}s")
                subprocess.run(["systemctl", "stop", unit], check=False)


class Gate(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def route(self):
        for prefix, unit, port, strip in ROUTES:
            if self.path.startswith(prefix):
                path = "/" + self.path[len(prefix):] if strip else self.path
                return unit, port, path
        return None

    def forward(self):
        r = self.route()
        if r is None:
            return self.reply(404, {"error": "no adapter at this path"})
        unit, port, path = r
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else None
        # scanners POST forms and junk here; only a JSON batch may start an executor
        if not batch_like(body):
            return self.reply(400, {"error": "POST a JSON body with a batch"})
        with lock:
            state[unit]["inflight"] += 1
            state[unit]["last"] = time.time()
        try:
            if not ensure_running(unit, port):
                return self.reply(503, {"error": f"executor {unit} could not be started"})
            conn = http.client.HTTPConnection("127.0.0.1", port, timeout=UPSTREAM_TIMEOUT)
            headers = {k: v for k, v in self.headers.items() if k.lower() not in ("host", "connection", "content-length")}
            conn.request(self.command, path, body=body, headers=headers)
            res = conn.getresponse()
            data = res.read()
            self.send_response(res.status)
            for k, v in res.getheaders():
                if k.lower() not in ("connection", "transfer-encoding", "content-length"):
                    self.send_header(k, v)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            log(f"{self.command} {self.path} -> {unit} {res.status} {len(data)}B")
        except Exception as e:  # the node gets an error, never a made-up score
            log(f"{self.command} {self.path} -> {unit} failed: {e}")
            self.reply(502, {"error": f"executor {unit} failed: {e}"})
        finally:
            with lock:
                state[unit]["inflight"] -= 1
                state[unit]["last"] = time.time()

    def reply(self, status, obj):
        data = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    do_POST = forward

    def do_GET(self):
        # bots probe these URLs all day: answer GETs without starting anything
        self.reply(405, {"error": "POST a batch"})

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    for _, unit, port, _ in ROUTES:
        if listening(port):
            state[unit]["last"] = time.time()
    threading.Thread(target=reaper, daemon=True).start()
    log(f"adapter gate on {LISTEN[0]}:{LISTEN[1]}, idle stop after {IDLE_SECONDS}s")
    ThreadingHTTPServer(LISTEN, Gate).serve_forever()
