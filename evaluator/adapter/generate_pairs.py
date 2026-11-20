#!/usr/bin/env python3
"""
Training pairs for a SMART_CONTRACT_AUDIT evaluator adapter.

Telegraph scores a judgment intent with a reward model that reads
"### Task:\\n{question}\\n\\n### Answer:\\n{answer}" and must rank a better
answer above a worse one. This script writes preference pairs
(prompt, chosen, rejected) for audit questions about Solidity, in the styles
the public descriptions of the intent's evaluation material give: quote the
exact access-control check of a function, name the SWC weakness a contract
contains, give its DASP category, count findings of one SWC class (including
none), and pick the change that fixes a weakness.

Correct by construction. Each contract is assembled from parts whose
security properties are known, so the better answer is derived from the code.
The worse answer is about the same code, in the same format, and wrong in one
specific way: another function's check, a check that is not about the caller,
"unprotected" for a guarded function, the wrong SWC entry, the wrong
function, a wrong count, or the fix for a different weakness.

No give-aways. Every sentence template is used for better and worse answers
alike: the text of an SWC entry's explanation is the same whether it is the
right entry or a decoy, so neither word choice nor length tells the answers
apart. Only reading the code does. The kit's dataset gate (unique negatives,
length, bag-of-words probe without the prompt) checks this.

Standard library only. Deterministic for a given --seed.

    python3 generate_pairs.py --out pairs.jsonl --n 2400 --seed 7
"""
from __future__ import annotations

import argparse
import json
import random
from dataclasses import dataclass, field

# ---------------------------------------------------------------------------
# vocabulary
# ---------------------------------------------------------------------------

CONTRACTS = [
    "Vault", "Treasury", "StakingPool", "Escrow", "TokenSale", "BridgeGateway", "Lottery", "Auction",
    "Marketplace", "LendingPool", "RewardsDistributor", "FeeCollector", "NFTMinter", "Timelock",
    "Crowdfund", "PaymentSplitter", "InsuranceFund", "Faucet", "VestingWallet", "LiquidityLocker",
    "PriceFeed", "Governor", "Registry", "Airdrop", "SavingsAccount", "CollateralManager", "YieldFarm",
    "Relayer", "Subscription", "Bounty", "Raffle", "Swapper", "Distributor", "Pot", "Jackpot", "Pool",
    "Reserve", "Settlement", "Payroll", "Allowance", "Tipjar", "Kickstarter", "Depository", "Locker",
]
ADMIN_VARS = ["owner", "admin", "governance", "operator", "guardian", "controller", "manager", "treasurer", "curator"]
ROLES = ["MINTER_ROLE", "PAUSER_ROLE", "OPERATOR_ROLE", "MANAGER_ROLE", "UPGRADER_ROLE", "FEE_ROLE", "SWEEPER_ROLE"]
ERRORS = ["Unauthorized", "NotOwner", "NotAdmin", "Forbidden", "CallerNotAllowed", "OnlyGovernance", "AccessDenied"]
MESSAGES = ["not owner", "unauthorized", "only admin", "forbidden", "caller is not allowed", "not authorized",
            "access denied", "only governance", "restricted", "not permitted", "caller rejected"]
BAL_MAPS = ["balances", "deposits", "credits", "stakes", "shares", "pending", "owed", "escrowed", "contributions"]
AMOUNTS = ["amount", "value", "amt", "qty", "wad", "sum"]
RECIPIENTS = ["to", "recipient", "receiver", "dst", "account", "payee"]
PRAGMAS_08 = ["^0.8.20", "^0.8.19", "0.8.24", "^0.8.13", "0.8.26", "^0.8.17", "0.8.21"]

# Admin functions: name -> (state variable, its type). A setter writes one variable.
SETTERS = {
    "setFee": ("fee", "uint256"), "setTreasury": ("treasury", "address"), "setOracle": ("oracle", "address"),
    "setRewardRate": ("rewardRate", "uint256"), "setRouter": ("router", "address"),
    "setFeeRecipient": ("feeRecipient", "address"), "setMaxSupply": ("maxSupply", "uint256"),
    "setDelay": ("delay", "uint256"), "setCap": ("cap", "uint256"), "setDuration": ("duration", "uint256"),
    "setPrice": ("price", "uint256"), "setLimit": ("limit", "uint256"), "setThreshold": ("threshold", "uint256"),
    "setMinDeposit": ("minDeposit", "uint256"), "setBeneficiary": ("beneficiary", "address"),
}
OPEN_ACTIONS = ["deposit", "stake", "contribute", "bid", "buy", "enter", "subscribe", "fund", "lock", "register", "topUp"]


def pick(rng: random.Random, xs):
    return rng.choice(xs)


def cap1(s: str) -> str:
    return s[0].upper() + s[1:]


# ---------------------------------------------------------------------------
# contract model
# ---------------------------------------------------------------------------

@dataclass
class Fn:
    name: str
    lines: list[str]
    sender_check: str | None = None          # the statement in the body that restricts msg.sender
    modifier: str | None = None              # the access modifier on the signature
    other_checks: list[str] = field(default_factory=list)  # requires that do not restrict the caller


@dataclass
class Ctx:
    """One contract under construction."""
    name: str
    admin: str
    bal: str
    mod_name: str
    mod_check: str
    err: str
    msg: str
    role: str
    pragma: str
    uses_role: bool = False
    state: dict[str, str] = field(default_factory=dict)   # extra state variable -> declaration
    fns: list[Fn] = field(default_factory=list)

    def declare(self, var: str, decl: str) -> None:
        self.state.setdefault(var, decl)

    def source(self) -> str:
        head = ["pragma solidity " + self.pragma + ";", ""]
        if self.uses_role:
            head += ['import "@openzeppelin/contracts/access/AccessControl.sol";', ""]
        inherit = " is AccessControl" if self.uses_role else ""
        body = [f"contract {self.name}{inherit} {{"]
        if self.uses_role:
            body.append(f'    bytes32 public constant {self.role} = keccak256("{self.role}");')
        body.append(f"    address public {self.admin};")
        body.append(f"    mapping(address => uint256) public {self.bal};")
        for decl in self.state.values():
            body.append(f"    {decl}")
        body += ["", f"    error {self.err}();", "",
                 f"    modifier {self.mod_name}() {{", f"        {self.mod_check}", "        _;", "    }",
                 "", "    constructor() {", f"        {self.admin} = msg.sender;"]
        if self.uses_role:
            body.append(f"        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);")
        body.append("    }")
        for f in self.fns:
            body.append("")
            body += f.lines
        body.append("}")
        return "\n".join(head + body)


def new_ctx(rng: random.Random, pragma: str | None = None) -> Ctx:
    admin = pick(rng, ADMIN_VARS)
    err = pick(rng, ERRORS)
    msg = pick(rng, MESSAGES)
    mod_check = (f'require(msg.sender == {admin}, "{msg}");' if rng.random() < 0.6
                 else f"if (msg.sender != {admin}) revert {err}();")
    return Ctx(name=pick(rng, CONTRACTS), admin=admin, bal=pick(rng, BAL_MAPS), mod_name="only" + cap1(admin),
               mod_check=mod_check, err=err, msg=msg, role=pick(rng, ROLES), pragma=pragma or pick(rng, PRAGMAS_08))


def admin_fn(rng: random.Random, ctx: Ctx, name: str, mode: str) -> Fn:
    """An admin function guarded by `mode`: require | revert | role | modifier | none."""
    sig_mod = f" {ctx.mod_name}" if mode == "modifier" else ""
    check = None
    if mode == "require":
        check = f'require(msg.sender == {ctx.admin}, "{ctx.msg}");'
    elif mode == "revert":
        check = f"if (msg.sender != {ctx.admin}) revert {ctx.err}();"
    elif mode == "role":
        ctx.uses_role = True
        check = f'require(hasRole({ctx.role}, msg.sender), "{ctx.msg}");'
    other: list[str] = []
    if name in SETTERS:
        var, typ = SETTERS[name]
        ctx.declare(var, f"{typ} public {var};")
        p = "new" + cap1(var)
        sig = f"    function {name}({typ} {p}) external{sig_mod} {{"
        stmts = []
        if rng.random() < 0.6:
            o = (f'require({p} != address(0), "zero address");' if typ == "address"
                 else f'require({p} <= {pick(rng, [100, 500, 1000, 10000, 86400])}, "too high");')
            other.append(o)
            stmts.append(o)
        stmts.append(f"{var} = {p};")
    elif name in ("pause", "unpause"):
        ctx.declare("paused", "bool public paused;")
        sig = f"    function {name}() external{sig_mod} {{"
        stmts = [f"paused = {'true' if name == 'pause' else 'false'};"]
    elif name == "mint":
        ctx.declare("totalSupply", "uint256 public totalSupply;")
        to, amt = pick(rng, RECIPIENTS), pick(rng, AMOUNTS)
        sig = f"    function mint(address {to}, uint256 {amt}) external{sig_mod} {{"
        stmts = []
        if rng.random() < 0.5:
            o = f'require({to} != address(0), "zero address");'
            other.append(o)
            stmts.append(o)
        stmts += [f"{ctx.bal}[{to}] += {amt};", f"totalSupply += {amt};"]
    elif name == "sweep":
        to = pick(rng, RECIPIENTS)
        sig = f"    function sweep(address payable {to}) external{sig_mod} {{"
        stmts = [f"{to}.transfer(address(this).balance);"]
    else:  # setWhitelist
        ctx.declare("whitelist", "mapping(address => bool) public whitelist;")
        sig = f"    function setWhitelist(address account, bool allowed) external{sig_mod} {{"
        stmts = ["whitelist[account] = allowed;"]
    lines = [sig] + ([f"        {check}"] if check else []) + [f"        {s}" for s in stmts] + ["    }"]
    return Fn(name, lines, sender_check=check, modifier=ctx.mod_name if mode == "modifier" else None, other_checks=other)


def open_fn(rng: random.Random, ctx: Ctx, name: str) -> Fn:
    amt = pick(rng, AMOUNTS)
    o = f'require(msg.value == {amt}, "wrong value");' if rng.random() < 0.5 else f'require({amt} > 0, "zero amount");'
    lines = [f"    function {name}(uint256 {amt}) external payable {{", f"        {o}",
             f"        {ctx.bal}[msg.sender] += {amt};", "    }"]
    return Fn(name, lines, other_checks=[o])


ADMIN_NAMES = list(SETTERS) + ["pause", "unpause", "mint", "sweep", "setWhitelist"]


def fill(rng: random.Random, ctx: Ctx, n: int, taken: set[str], modes: list[str], open_share: float) -> None:
    while n > 0:
        if rng.random() < open_share:
            name = pick(rng, OPEN_ACTIONS)
            if name in taken:
                continue
            taken.add(name)
            ctx.fns.append(open_fn(rng, ctx, name))
        else:
            name = pick(rng, ADMIN_NAMES)
            if name in taken:
                continue
            taken.add(name)
            ctx.fns.append(admin_fn(rng, ctx, name, pick(rng, modes)))
        n -= 1


# ---------------------------------------------------------------------------
# task A: quote the access-control check
# ---------------------------------------------------------------------------

A_QUESTIONS = [
    "Audit `{c}`. Quote, exactly as written, the first check that restricts who may call `{f}`. Answer as JSON with keys contract, function and check.",
    "In the contract below, which statement limits the callers of `{f}`? Quote it verbatim and answer as JSON (contract, function, check).",
    "Access-control review of `{c}.{f}`: give the exact require or revert that authorises its caller, as JSON with contract, function and check.",
    "Find the caller restriction on `{f}` in this contract and quote it exactly. Reply in JSON: contract, function, check.",
    "Which line of `{c}` stops an arbitrary account from calling `{f}`? Quote it as JSON with contract, function and check, or check null if nothing does.",
]


def guard_of(ctx: Ctx, f: Fn) -> tuple[str | None, str | None]:
    if f.sender_check:
        return f.sender_check, None
    if f.modifier:
        return ctx.mod_check, f.modifier
    return None, None


def a_answer(ctx: Ctx, f: Fn, check: str | None, via: str | None) -> str:
    d: dict = {"contract": ctx.name, "function": f.name, "check": check}
    if via:
        d["via_modifier"] = via
    d["note"] = (f"no statement reachable from {f.name} restricts msg.sender, so any account can call it"
                 if check is None else f"the first caller restriction that {f.name} runs")
    return json.dumps(d)


def task_access(rng: random.Random) -> dict | None:
    ctx = new_ctx(rng)
    modes = ["require", "revert", "modifier", "modifier"] + (["role"] if rng.random() < 0.4 else [])
    fill(rng, ctx, rng.randint(3, 5), set(), modes, open_share=0.25)
    f = pick(rng, ctx.fns)
    check, via = guard_of(ctx, f)
    chosen = a_answer(ctx, f, check, via)
    options = []
    for g in ctx.fns:
        gc, gv = guard_of(ctx, g)
        if g is not f and gc and (gc, gv) != (check, via):
            options.append(a_answer(ctx, f, gc, gv))                 # another function's guard
    if f.other_checks:
        options.append(a_answer(ctx, f, f.other_checks[0], None))    # a check that is not about the caller
    if check is not None:
        options.append(a_answer(ctx, f, None, None))                 # "unprotected" for a guarded function
    options = [o for o in dict.fromkeys(options) if o != chosen]
    if not options:
        return None
    q = pick(rng, A_QUESTIONS).format(c=ctx.name, f=f.name)
    return {"prompt": f"{q}\n\n```solidity\n{ctx.source()}\n```", "chosen": chosen,
            "rejected": pick(rng, options), "task": "access_quote"}


# ---------------------------------------------------------------------------
# weaknesses: the code, and one shared explanation and fix per SWC entry
# ---------------------------------------------------------------------------

SWC_TITLE = {
    101: "Integer Overflow and Underflow", 104: "Unchecked Call Return Value", 105: "Unprotected Ether Withdrawal",
    106: "Unprotected SELFDESTRUCT Instruction", 107: "Reentrancy", 112: "Delegatecall to Untrusted Callee",
    113: "DoS with Failed Call", 115: "Authorization through tx.origin", 116: "Block values as a proxy for time",
    120: "Weak Sources of Randomness from Chain Attributes", 128: "DoS With Block Gas Limit",
}
DASP = {
    101: "Arithmetic Issues", 104: "Unchecked Return Values For Low Level Calls", 105: "Access Control",
    106: "Access Control", 107: "Reentrancy", 112: "Access Control", 113: "Denial of Service",
    115: "Access Control", 116: "Time Manipulation", 120: "Bad Randomness", 128: "Denial of Service",
}


def reason(swc: int, c: str, f: str, admin: str, bal: str) -> str:
    """Why `f` has the weakness. The same sentence serves as the true explanation and as a decoy."""
    return {
        101: f"`{c}.{f}` updates {bal} with unchecked arithmetic under a compiler older than 0.8, so a balance can wrap around",
        104: f"`{c}.{f}` makes a low-level call and ignores whether it succeeded, so a failed transfer still counts as paid",
        105: f"`{c}.{f}` sends the contract's Ether to whoever calls it, with no check on the caller",
        106: f"`{c}.{f}` reaches selfdestruct with no check on the caller, so any account can destroy the contract",
        107: f"`{c}.{f}` makes an external call before it updates {bal}, so the callee can re-enter and be paid again",
        112: f"`{c}.{f}` delegatecalls an address the caller chooses, so foreign code runs on this contract's storage, {admin} included",
        113: f"`{c}.{f}` pushes Ether to many accounts in one loop, so a single reverting recipient blocks everyone",
        115: f"`{c}.{f}` authorises with tx.origin, so a contract the {admin} interacts with can call it on their behalf",
        116: f"`{c}.{f}` decides a payout from block.timestamp, which the block producer can shift within a window",
        120: f"`{c}.{f}` derives randomness from block values that validators and same-block callers can predict",
        128: f"`{c}.{f}` loops over an array anyone can grow, so the loop eventually exceeds the block gas limit",
    }[swc]


def fix(swc: int, f: str, admin: str, bal: str) -> str:
    """The change that removes the weakness. The same sentence is a decoy fix for other entries."""
    return {
        101: f"check {bal} before subtracting in `{f}`, use SafeMath, or compile with Solidity 0.8 or later",
        104: f"in `{f}`, capture the call's boolean result and require it to be true",
        105: f"restrict `{f}` to the {admin}, or pay out only the caller's own {bal} entry",
        106: f"restrict `{f}` to the {admin}, or remove the selfdestruct",
        107: f"in `{f}`, update {bal} before the external call, or add a reentrancy guard",
        112: f"make `{f}` delegatecall only a fixed trusted implementation, or restrict it to the {admin}",
        113: f"replace the loop in `{f}` with pull payments that each recipient withdraws",
        115: f"in `{f}`, compare msg.sender instead of tx.origin with the {admin}",
        116: f"stop deciding the outcome of `{f}` from block.timestamp; use a verifiable randomness source",
        120: f"take the randomness in `{f}` from a verifiable source such as a VRF or commit-reveal",
        128: f"process the array in `{f}` in bounded batches, or let each holder update their own entry",
    }[swc]


def weak_fn(rng: random.Random, ctx: Ctx, swc: int, taken: set[str]) -> Fn:
    bal, admin = ctx.bal, ctx.admin
    amt, to = pick(rng, AMOUNTS), pick(rng, RECIPIENTS)

    def name_from(options):
        free = [o for o in options if o not in taken]
        n = pick(rng, free or options)
        taken.add(n)
        return n

    if swc == 107:
        n = name_from(["withdraw", "redeem", "claim", "exit", "unstake", "cashOut", "release"])
        call = (f'(bool ok, ) = msg.sender.call{{value: {amt}}}("");' if rng.random() < 0.7
                else f'(bool ok, ) = payable(msg.sender).call{{value: {amt}}}("");')
        lines = [f"    function {n}() external {{", f"        uint256 {amt} = {bal}[msg.sender];",
                 f'        require({amt} > 0, "nothing to withdraw");', f"        {call}",
                 '        require(ok, "transfer failed");', f"        {bal}[msg.sender] = 0;", "    }"]
    elif swc == 115:
        n = name_from(["transferOwnership", "setAdmin", "withdrawAll", "emergencyWithdraw", "changeOperator"])
        act = (f"{admin} = {to};" if n in ("transferOwnership", "setAdmin", "changeOperator")
               else f"payable({to}).transfer(address(this).balance);")
        chk = f'require(tx.origin == {admin}, "{ctx.msg}");'
        return Fn(n, [f"    function {n}(address {to}) external {{", f"        {chk}", f"        {act}", "    }"],
                  sender_check=chk)
    elif swc == 104:
        n = name_from(["payout", "refund", "settle", "sendReward", "disburse"])
        lines = [f"    function {n}(address payable {to}, uint256 {amt}) external {{",
                 f'        require({bal}[{to}] >= {amt}, "insufficient");', f"        {bal}[{to}] -= {amt};",
                 f'        {to}.call{{value: {amt}}}("");', "    }"]
    elif swc == 101:
        n = name_from(["transfer", "credit", "move", "addShares", "shift"])
        lines = [f"    function {n}(address {to}, uint256 {amt}) external {{", f"        {bal}[msg.sender] -= {amt};",
                 f"        {bal}[{to}] += {amt};", "    }"]
    elif swc == 106:
        n = name_from(["close", "shutdown", "destroy", "kill", "retire"])
        lines = [f"    function {n}(address payable {to}) external {{", f"        selfdestruct({to});", "    }"]
    elif swc == 105:
        n = name_from(["withdrawAll", "drain", "collect", "skim", "sweepEther"])
        lines = [f"    function {n}() external {{", "        payable(msg.sender).transfer(address(this).balance);", "    }"]
    elif swc == 112:
        n = name_from(["execute", "forward", "multicall", "run", "proxyCall"])
        t = pick(rng, ["target", "impl", "module", "logic"])
        lines = [f"    function {n}(address {t}, bytes calldata data) external {{",
                 f"        (bool ok, ) = {t}.delegatecall(data);", '        require(ok, "call failed");', "    }"]
    elif swc == 116:
        n = name_from(["play", "spin", "tryLuck", "roll", "draw"])
        m = pick(rng, [7, 10, 15, 30, 60])
        stake = pick(rng, ["1 ether", "0.1 ether", "0.5 ether", "0.01 ether"])
        lines = [f"    function {n}() external payable {{", f'        require(msg.value == {stake}, "wrong stake");',
                 f"        if (block.timestamp % {m} == 0) {{", "            payable(msg.sender).transfer(address(this).balance);",
                 "        }", "    }"]
    elif swc == 120:
        ctx.declare("players", "address[] public players;")
        n = name_from(["pickWinner", "drawWinner", "selectWinner", "settleRound", "rollPrize"])
        parts = rng.sample(["block.prevrandao", "block.timestamp", "block.number", "players.length", "msg.sender"], 3)
        lines = [f"    function {n}() external {{",
                 f"        uint256 r = uint256(keccak256(abi.encodePacked({', '.join(parts)})));",
                 "        address winner = players[r % players.length];",
                 "        payable(winner).transfer(address(this).balance);", "    }"]
    elif swc == 113:
        ctx.declare("recipients", "address[] public recipients;")
        n = name_from(["refundAll", "payWinners", "distribute", "airdropEther", "payAll"])
        lines = [f"    function {n}() external {{", "        for (uint256 i = 0; i < recipients.length; i++) {",
                 f"            payable(recipients[i]).transfer({bal}[recipients[i]]);", "        }", "    }"]
    else:  # 128
        ctx.declare("holders", "address[] public holders;")
        n = name_from(["accrueAll", "updateAll", "rebaseAll", "settleAll", "processQueue"])
        j = "join" if "join" not in taken else "enroll"
        taken.add(j)
        lines = [f"    function {n}() external {{", "        for (uint256 i = 0; i < holders.length; i++) {",
                 f"            {bal}[holders[i]] += 1;", "        }", "    }", "",
                 f"    function {j}() external {{", "        holders.push(msg.sender);", "    }"]
    return Fn(n, lines)


def weak_contract(rng: random.Random) -> tuple[Ctx, Fn, int]:
    swc = pick(rng, list(SWC_TITLE))
    ctx = new_ctx(rng, pragma=pick(rng, ["^0.7.6", "^0.7.0", "^0.6.12", "0.6.12"]) if swc == 101 else None)
    taken: set[str] = set()
    wf = weak_fn(rng, ctx, swc, taken)
    fill(rng, ctx, rng.randint(1, 3), taken, ["modifier", "require", "revert"], open_share=0.35)
    ctx.fns.insert(rng.randint(0, len(ctx.fns)), wf)
    return ctx, wf, swc


def swc_line(swc: int) -> str:
    return f"SWC-{swc} ({SWC_TITLE[swc]})"


def other_swc(rng: random.Random, swc: int) -> int:
    return pick(rng, [s for s in SWC_TITLE if s != swc])


# ---------------------------------------------------------------------------
# task B: name the SWC weakness and its function
# ---------------------------------------------------------------------------

B_QUESTIONS = [
    "This contract contains exactly one weakness from the SWC registry. Identify it: the SWC ID and title, the function, and why.",
    "Security review of `{c}`: which SWC weakness does it contain, in which function, and what makes it exploitable?",
    "Audit the following Solidity. Name the single SWC registry entry it violates, the affected function, and the reason.",
    "Give the SWC classification of the vulnerability in `{c}`, the function it is in, and one sentence on the cause.",
]


def b_answer(swc: int, ctx: Ctx, fname: str) -> str:
    return f"{swc_line(swc)}: {reason(swc, ctx.name, fname, ctx.admin, ctx.bal)}."


def task_swc(rng: random.Random) -> dict | None:
    ctx, wf, swc = weak_contract(rng)
    others = [f for f in ctx.fns if f is not wf]
    roll = rng.random()
    if roll < 0.55 or not others:
        rejected = b_answer(other_swc(rng, swc), ctx, wf.name)              # wrong entry, right function
    elif roll < 0.85:
        rejected = b_answer(swc, ctx, pick(rng, others).name)              # right entry, wrong function
    else:
        rejected = b_answer(other_swc(rng, swc), ctx, pick(rng, others).name)
    q = pick(rng, B_QUESTIONS).format(c=ctx.name)
    return {"prompt": f"{q}\n\n```solidity\n{ctx.source()}\n```", "chosen": b_answer(swc, ctx, wf.name),
            "rejected": rejected, "task": "swc_identify"}


# ---------------------------------------------------------------------------
# task C: DASP category
# ---------------------------------------------------------------------------

C_QUESTIONS = [
    "Which DASP Top 10 category does the vulnerability in `{f}` belong to? Name the category and the SWC entry, and say why.",
    "Classify the flaw in `{c}.{f}` under the DASP Top 10, with the matching SWC ID.",
    "Under the DASP Top 10, what kind of vulnerability does `{f}` have? Give the category, the SWC ID and the cause.",
]


def c_answer(swc: int, ctx: Ctx, fname: str) -> str:
    return f"DASP {DASP[swc]}, {swc_line(swc)}: {reason(swc, ctx.name, fname, ctx.admin, ctx.bal)}."


def task_dasp(rng: random.Random) -> dict | None:
    ctx, wf, swc = weak_contract(rng)
    wrong = pick(rng, [s for s in SWC_TITLE if DASP[s] != DASP[swc]])
    q = pick(rng, C_QUESTIONS).format(c=ctx.name, f=wf.name)
    return {"prompt": f"{q}\n\n```solidity\n{ctx.source()}\n```", "chosen": c_answer(swc, ctx, wf.name),
            "rejected": c_answer(wrong, ctx, wf.name), "task": "dasp"}


# ---------------------------------------------------------------------------
# task D: findings of one SWC class, including none
# ---------------------------------------------------------------------------

D_QUESTIONS = [
    "Check `{c}` for SWC-{s} ({t}) only. How many functions have it? List them, or say none.",
    "Scoped review: does any function in this contract contain SWC-{s} ({t})? Give the count and the function names.",
    "Count the findings of SWC-{s} ({t}) in the contract below and name each affected function.",
]


def d_answer(scope: int, ctx: Ctx, fname: str | None) -> str:
    if fname is None:
        return (f"0 findings of SWC-{scope} in `{ctx.name}`: no function matches this class, "
                f"so nothing in scope needs a change.")
    return f"1 finding of SWC-{scope} in `{ctx.name}`: {reason(scope, ctx.name, fname, ctx.admin, ctx.bal)}."


def task_count(rng: random.Random) -> dict | None:
    ctx, wf, swc = weak_contract(rng)
    if rng.random() < 0.5:
        scope = swc
        chosen = d_answer(scope, ctx, wf.name)
        others = [f for f in ctx.fns if f is not wf]
        rejected = d_answer(scope, ctx, pick(rng, others).name) if others and rng.random() < 0.5 else d_answer(scope, ctx, None)
    else:
        scope = other_swc(rng, swc)
        chosen = d_answer(scope, ctx, None)
        rejected = d_answer(scope, ctx, pick(rng, ctx.fns).name)
    q = pick(rng, D_QUESTIONS).format(c=ctx.name, s=scope, t=SWC_TITLE[scope])
    return {"prompt": f"{q}\n\n```solidity\n{ctx.source()}\n```", "chosen": chosen, "rejected": rejected,
            "task": "scoped_count"}


# ---------------------------------------------------------------------------
# task E: the fix
# ---------------------------------------------------------------------------

E_QUESTIONS = [
    "`{f}` in `{c}` has a weakness from the SWC registry. Which single change removes it?",
    "Recommend the fix for the vulnerability in `{c}.{f}`, and name the weakness it removes.",
    "What is the minimal change that makes `{f}` safe? Name the SWC entry it addresses.",
]


def e_answer(swc: int, ctx: Ctx, fname: str) -> str:
    return f"Fix for {swc_line(swc)}: {fix(swc, fname, ctx.admin, ctx.bal)}."


def task_fix(rng: random.Random) -> dict | None:
    ctx, wf, swc = weak_contract(rng)
    q = pick(rng, E_QUESTIONS).format(c=ctx.name, f=wf.name)
    return {"prompt": f"{q}\n\n```solidity\n{ctx.source()}\n```", "chosen": e_answer(swc, ctx, wf.name),
            "rejected": e_answer(other_swc(rng, swc), ctx, wf.name), "task": "fix"}


# ---------------------------------------------------------------------------

MAX_CHARS = 1500

TASKS = [(task_access, 0.32), (task_swc, 0.26), (task_dasp, 0.12), (task_count, 0.18), (task_fix, 0.12)]


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--out", required=True)
    ap.add_argument("--n", type=int, default=2400)
    ap.add_argument("--seed", type=int, default=7)
    args = ap.parse_args()
    rng = random.Random(args.seed)
    seen: set[str] = set()
    rows: list[dict] = []
    tries = 0
    while len(rows) < args.n and tries < args.n * 30:
        tries += 1
        task = rng.choices([t for t, _ in TASKS], weights=[w for _, w in TASKS])[0]
        row = task(rng)
        if not row or row["prompt"] in seen or row["chosen"] == row["rejected"]:
            continue
        # The node scores at most 512 tokens of "### Task: ... ### Answer: ...". A text
        # cut off before its answer carries no preference. This tokenizer averages about
        # 3.4 characters per token here, so 1,500 characters keeps a margin.
        if len(row["prompt"]) + max(len(row["chosen"]), len(row["rejected"])) > MAX_CHARS:
            continue
        seen.add(row["prompt"])
        rows.append(row)
    with open(args.out, "w", encoding="utf-8") as fh:
        for r in rows:
            fh.write(json.dumps({"prompt": r["prompt"], "chosen": r["chosen"], "rejected": r["rejected"],
                                 "label_kind": "preference_pair"}) + "\n")
    by_task: dict[str, int] = {}
    for r in rows:
        by_task[r["task"]] = by_task.get(r["task"], 0) + 1
    print(json.dumps({"pairs": len(rows), "by_task": by_task}))


if __name__ == "__main__":
    main()
