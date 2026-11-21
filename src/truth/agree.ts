/**
 * The rule every Truvian truth answer follows: a value is returned only when
 * two endpoints run by different providers read exactly the same thing.
 * Anything less is a real HTTP error, which the Telegraph node treats as "this
 * source gave no value" and leaves out of the median. Never a guess.
 */
import type { RpcClient } from '../config/chains.js';

export class TruthError extends Error {
  constructor(
    /**
     * HTTP status: 400 malformed request, 404 no such record (a transaction
     * both endpoints lack), 422 well formed but unanswerable, 502 sources
     * disagree, 503 not enough sources
     */
    public readonly status: 400 | 404 | 422 | 502 | 503,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'TruthError';
  }
}

export function host(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * Who runs an endpoint, as its host's last two labels: eth.drpc.org and
 * base.drpc.org are both drpc.org, so they never make a pair. Every operator
 * used here serves from a domain of its own.
 */
export function provider(url: string): string {
  return host(url).split('.').slice(-2).join('.');
}

/** One endpoint's own reading. */
export interface Reading<T> {
  endpoint: string;
  value: T;
}

/**
 * Read from the endpoints in order until two from different providers have
 * answered, then accept the reading only if both are the same.
 *
 * `read` throws when the endpoint did not answer (a timeout, a rate limit, a
 * JSON-RPC error, a block it does not have); that endpoint is then skipped
 * for the next. Anything the chain itself says (a contract with no code, a
 * transaction that does not exist) is a reading, and must come back as a
 * value, so that the two endpoints are held to agree on it too.
 *
 * Throws TruthError 503 NOT_ENOUGH_SOURCES with fewer than two readings, 502
 * SOURCES_DISAGREE when `key` differs between them.
 */
export async function twoAgree<T>(
  endpoints: readonly RpcClient[],
  read: (endpoint: RpcClient) => Promise<T>,
  opts: {
    /** What must be identical between the two readings */
    key: (value: T) => string;
    /** A reading as said in the 502 message */
    show: (value: T) => string;
    /** The kind of read, for the 503 message: "archive reads" */
    what: string;
  },
): Promise<{ value: T; agreed_by: [string, string] }> {
  const readings: Reading<T>[] = [];
  const failures: string[] = [];
  for (const endpoint of endpoints) {
    if (readings.length === 2) break;
    if (readings.length === 1 && provider(readings[0]!.endpoint) === provider(endpoint.url)) continue;
    try {
      readings.push({ endpoint: endpoint.url, value: await read(endpoint) });
    } catch (err: any) {
      failures.push(`${host(endpoint.url)}: ${(err?.shortMessage ?? err?.message ?? String(err)).slice(0, 80)}`);
    }
  }
  if (readings.length < 2) {
    throw new TruthError(503, 'NOT_ENOUGH_SOURCES', `need two agreeing ${opts.what}, got ${readings.length} (${failures.join('; ')})`);
  }
  const [a, b] = readings as [Reading<T>, Reading<T>];
  if (opts.key(a.value) !== opts.key(b.value)) {
    throw new TruthError(502, 'SOURCES_DISAGREE',
      `${host(a.endpoint)} says ${opts.show(a.value)}, ${host(b.endpoint)} says ${opts.show(b.value)}`);
  }
  return { value: a.value, agreed_by: [host(a.endpoint), host(b.endpoint)] };
}
