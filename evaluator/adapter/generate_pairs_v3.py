#!/usr/bin/env python3
"""
Training pairs for a SMART_CONTRACT_AUDIT evaluator adapter, version 3.

v1 and v2 were trained on question and answer formats we wrote ourselves.
The node's public check for registration 182 (2026-11-21) showed the pool
uses three others, so v3 writes those:

1. access   Access control, answered as JSON {"target", "authorization_check"}.
            The prompt names a function in a pinned production source and
            quotes it; the question asks for the definition of the first
            modifier whose name starts with "only", or the first require
            statement that mentions msg.sender. The better answer gives that
            code. The worse one gives other code: a guard from another
            codebase, another modifier of the same codebase, the second
            "only" modifier, or a require that does not mention the caller.
2. legacy   An old Solidity 0.4 contract, with "Line numbers count from the
            first line of the code", answered as "Verdict / Highest severity /
            Finding N: class (severity), line L: `code` explanation Fix: ...".
            The better answer names the class the code really has and quotes
            the line that has it. The worse one names a class the code does
            not have, quotes an unrelated line, waves the issue off as minor,
            or calls the contract safe.
3. address  "Audit the smart contract at address 0x... (Name)." The better
            answer describes that contract. The worse one is a sweeping false
            claim about auditing, or a description of a different contract.

No pool row is copied: every contract, modifier, path and name is generated.
Every text is rendered the way the node renders it: whitespace inside the
prompt and answer collapsed to single spaces, then
"### Task:\\n{prompt}\\n\\n### Answer:\\n{answer}".

Both answers of a pair come from the same template family, so neither style
nor length gives the better one away; the kit's dataset gate checks that.

    python3 generate_pairs_v3.py --out pairs-v3.jsonl --n 1800 --seed 31
"""
from __future__ import annotations

import argparse
import json
import random
import string

# --------------------------------------------------------------------------
# shared vocabulary

ORGS = [
    ("compound-finance", "compound-protocol"), ("Uniswap", "v3-periphery"),
    ("balancer", "balancer-v2-monorepo"), ("sushiswap", "sushiswap"),
    ("curvefi", "curve-dao-contracts"), ("makerdao", "dss"),
    ("lidofinance", "lido-dao"), ("pendle-finance", "pendle-core-v2-public"),
    ("euler-xyz", "euler-contracts"), ("morpho-org", "morpho-blue"),
    ("frax-finance", "frax-solidity"), ("convex-eth", "platform"),
    ("synthetixio", "synthetix"), ("liquity", "dev"),
    ("OlympusDAO", "olympus-contracts"), ("ribbon-finance", "ribbon-v2"),
    ("beefyfinance", "beefy-contracts"), ("harvest-finance", "harvest"),
    ("alchemix-finance", "alchemix-protocol"), ("Badger-Finance", "badger-system"),
    ("dydxprotocol", "solo"), ("perpetual-protocol", "perp-curie-contract"),
    ("Rari-Capital", "vaults"), ("instadapp", "dsa-contracts"),
    ("pooltogether", "v4-core"), ("tokemak", "tokemak-smart-contracts"),
    ("notional-finance", "contracts-v2"), ("idle-labs", "idle-contracts"),
    ("kyberswap", "ks-elastic-sc"), ("stargate-protocol", "stargate"),
    ("across-protocol", "contracts-v2"), ("connext", "monorepo"),
    ("hop-protocol", "contracts"), ("ensdomains", "ens-contracts"),
    ("gnosis", "safe-contracts"), ("ProjectOpenSea", "seaport"),
    ("ondoprotocol", "ondo-v1"), ("angle-protocol", "angle-core"),
    ("threshold-network", "solidity-contracts"), ("goldfinch-eng", "goldfinch-protocol"),
]

DIRS = ["contracts", "contracts/core", "contracts/protocol", "contracts/governance",
        "contracts/vaults", "contracts/staking", "contracts/periphery",
        "contracts/strategies", "contracts/oracle", "contracts/token",
        "contracts/rewards", "contracts/bridge", "src", "src/core", "src/periphery",
        "packages/core/contracts", "packages/protocol/contracts", "contracts/utils",
        "contracts/libraries/logic", "contracts/treasury"]

CONTRACT_WORDS = ["Vault", "Strategy", "Controller", "Pool", "Router", "Staking",
                  "Rewards", "Treasury", "Oracle", "Gauge", "Minter", "Distributor",
                  "Bridge", "Timelock", "Manager", "Registry", "Factory", "Escrow",
                  "Lender", "Comptroller", "Keeper", "Auction", "Farm", "Market",
                  "Converter", "Swapper", "Locker", "Booster", "Vester", "Governor"]
CONTRACT_PREFIX = ["", "Base", "Stable", "Lending", "Fee", "Liquidity", "Yield",
                   "Reward", "Price", "Margin", "Short", "Staked", "Token", "Vote",
                   "Protocol", "Pool", "Collateral", "Debt", "Position", "Swap"]

ROLES = [  # (modifier suffix, state variable, readable)
    ("Owner", "owner", "owner"), ("Admin", "admin", "admin"), ("Gov", "gov", "gov"),
    ("Governance", "governance", "governance"), ("Controller", "controller", "controller"),
    ("Keeper", "keeper", "keeper"), ("Guardian", "guardian", "guardian"),
    ("Strategist", "strategist", "strategist"), ("Vault", "vault", "vault"),
    ("Pool", "pool", "pool"), ("Minter", "minter", "minter"),
    ("Operator", "operator", "operator"), ("Manager", "manager", "manager"),
    ("Treasury", "treasury", "treasury"), ("Timelock", "timelock", "timelock"),
    ("Bridge", "bridge", "bridge"), ("Router", "router", "router"),
    ("Factory", "factory", "factory"), ("Emergency", "emergencyAdmin", "emergency admin"),
    ("PoolAdmin", "poolAdmin", "pool admin"), ("Handler", "handler", "handler"),
    ("Relayer", "relayer", "relayer"), ("Distributor", "distributor", "distributor"),
    ("Liquidator", "liquidator", "liquidator"), ("Rebalancer", "rebalancer", "rebalancer"),
    ("Configurator", "configurator", "configurator"), ("Pauser", "pauser", "pauser"),
    ("Harvester", "harvester", "harvester"), ("Executor", "executor", "executor"),
    ("Registry", "registry", "registry"),
]

SETTER_THINGS = ["Fee", "FeeRecipient", "Treasury", "Keeper", "Oracle", "Strategy",
                 "DebtThreshold", "PerformanceFee", "WithdrawalFee", "MaxSlippage",
                 "RewardRate", "Cap", "DepositLimit", "Controller", "Router",
                 "PriceFeed", "Guardian", "MinDelay", "Paused", "Whitelist",
                 "MarginFeeBasisPoints", "LiquidationBonus", "ReserveFactor",
                 "InterestRateModel", "Emissions", "Duration", "Buffer", "Threshold"]

ACTIONS = ["harvest", "rebalance", "sweep", "pause", "unpause", "mint", "burn",
           "liquidate", "migrate", "emergencyWithdraw", "skim", "notifyRewardAmount",
           "addPool", "removePool", "upgradeTo", "rescueTokens", "distribute",
           "settle", "checkpoint", "tend", "execute", "queueTransaction",
           "cancelTransaction", "initialize", "mintNFT", "burnFrom", "withdrawFees"]

INTROS = [
    "I need a source-level check of the caller restrictions on this smart-contract function.",
    "Check how this contract operation validates who is calling it.",
    "Inspect the caller-validation logic in this production smart-contract operation.",
    "Review who is allowed to call this deployed smart-contract function.",
    "Verify the access control enforced on this production contract function.",
    "Audit the caller authorization on this smart-contract operation.",
    "I want to confirm how this on-chain function restricts its callers.",
]
Q_MODIFIER = [
    "Which authorization modifier beginning with only is listed first on this function? "
    "Show its complete source definition, using the defining file below.",
    "Name the first modifier starting with only on this function and quote its full "
    "definition from the defining source.",
    "Which only-prefixed modifier appears first in this function's declaration? Give its "
    "complete source definition.",
]
Q_REQUIRE = [
    "Quote the first require statement in the function body whose expression mentions msg.sender.",
    "Which require statement mentioning msg.sender appears first inside this function? "
    "Give the actual source statement so I can check the caller validation.",
    "Return the first require in this function's body that checks msg.sender, exactly as written.",
]
EXTRA = ["", "", "This review concerns the implemented caller check.",
         "Answer from the source, not from documentation."]


def hexs(rng: random.Random, n: int) -> str:
    return "".join(rng.choice("0123456789abcdef") for _ in range(n))


def collapse(s: str) -> str:
    return " ".join(s.split())


def camel(s: str) -> str:
    return s[0].lower() + s[1:]


class Project:
    """One codebase: where it lives and how it writes its guards."""

    def __init__(self, rng: random.Random):
        self.org, self.repo = rng.choice(ORGS)
        self.commit = hexs(rng, rng.choice([7, 8, 40]))
        self.contract = rng.choice(CONTRACT_PREFIX) + rng.choice(CONTRACT_WORDS)
        self.path = f"{rng.choice(DIRS)}/{self.contract}.sol"
        self.sender = rng.choice(["msg.sender"] * 3 + ["_msgSender()"])
        self.err = rng.choice(["prefix", "bang", "code", "errors", "custom", "plain"])
        self.err_code = rng.randint(1, 99)
        roles = rng.sample(ROLES, 5)
        self.roles = roles

    def url(self, path: str | None = None) -> str:
        return (f"https://raw.githubusercontent.com/{self.org}/{self.repo}/"
                f"{self.commit}/{path or self.path}")

    def message(self, rng: random.Random, readable: str) -> str:
        word = readable.replace(" ", "_").upper()
        if self.err == "prefix":
            return '"' + self.contract + ": " + rng.choice(
                ["forbidden", f"not {readable}", f"only {readable}", "unauthorized",
                 f"{readable} forbidden", "!auth"]) + '"'
        if self.err == "bang":
            return '"!' + rng.choice([readable.replace(" ", ""), "authorized", "auth"]) + '"'
        if self.err == "code":
            return f'"ERR_NOT_{word}"'
        if self.err == "errors":
            return f"Errors.CALLER_NOT_{word}"
        if self.err == "plain":
            return '"' + rng.choice(["forbidden", "unauthorized", "not allowed",
                                     f"caller is not the {readable}"]) + '"'
        return ""  # custom errors

    def check_expr(self, rng: random.Random, role) -> str:
        suffix, var, readable = role
        s = self.sender
        kind = rng.random()
        if kind < 0.55:
            return f"{s} == {var}" if rng.random() < 0.7 else f"{s} == {var}()"
        if kind < 0.7:
            other = rng.choice(self.roles)[1]
            return f"{s} == {var} || {s} == {other}()"
        if kind < 0.85:
            return f"is{suffix}[{s}]" if rng.random() < 0.5 else f"{var}s[{s}]"
        return f"{s} == address({var})"

    def require(self, rng: random.Random, role) -> str:
        expr = self.check_expr(rng, role)
        msg = self.message(rng, role[2])
        if not msg:
            msg = '"' + role[2] + ' only"'
        return f"require({expr}, {msg})"

    def modifier(self, rng: random.Random, role, name: str | None = None) -> str:
        """Full modifier definition, as the pool's answers render it."""
        suffix, var, readable = role
        name = name or f"only{suffix}"
        style = rng.random()
        if style < 0.12:
            body = [rng.choice([f"_only{suffix}();", f"_only{suffix}({self.sender});",
                                f"_assertSenderIs{suffix}();", f"_require{suffix}({self.sender});",
                                f"_check{suffix}Role({self.sender});"])]
        elif style < 0.24 or self.err == "custom":
            neg = self.check_expr(rng, role).replace("==", "!=").replace("||", "&&")
            body = [f"if ({neg}) revert Not{suffix}();"]
        elif style < 0.32:
            body = [rng.choice([f"_check{suffix}({self.sender});", f"_checkRole({suffix.upper()}_ROLE, {self.sender});",
                                f"require(hasRole({suffix.upper()}_ROLE, {self.sender}), {self.message(rng, readable) or chr(34) + 'role' + chr(34)});"])]
        else:
            body = [self.require(rng, role) + ";"]
        params = "()" if rng.random() < 0.85 else f"(bytes32 {rng.choice(['poolId', 'id', 'key'])})"
        lines = [f"modifier {name}{params} {{"] + body + ["_;", "}"]
        return "\n ".join(lines)


def function_code(rng: random.Random, name: str, modifiers: list[str], body_requires: list[str]) -> str:
    arg_t, arg = rng.choice([("uint256", "_amount"), ("address", "_account"), ("uint256", "_value"),
                             ("address", "_newAddress"), ("bool", "_enabled"), ("uint256", "_bps"),
                             ("bytes32", "_id"), ("uint256", "_debtThreshold")])
    vis = rng.choice(["external", "public", "external override", "external virtual"])
    mods = " ".join(modifiers)
    other = rng.sample(["nonReentrant", "whenNotPaused", "returns (bool)", ""], 1)[0]
    head = f"function {name}({arg_t} {arg}) {vis} {mods} {other}".strip()
    state = camel(name[3:]) if name.startswith("set") and len(name) > 3 else "lastAction"
    body = list(body_requires)
    body += rng.choice([
        [f"{state} = {arg};", f"emit {name[0].upper() + name[1:]}Updated({arg});"],
        [f"uint256 before = {rng.choice(['totalAssets()', 'balanceOf(address(this))', 'reserves'])};",
         f"_{name}({arg});", f"emit {name[0].upper() + name[1:]}(before, {arg});"],
        [f"if ({arg} == {rng.choice(['0', 'address(0)', 'false'])}) {{ return; }}", f"_{name}({arg});"],
        [f"{state} = {arg};"],
    ])
    return collapse(head + " { " + " ".join(body) + " }")


def access_pair(rng: random.Random) -> dict:
    proj = Project(rng)
    foreign = Project(rng)
    while foreign.repo == proj.repo:
        foreign = Project(rng)
    is_mod = rng.random() < 0.65
    name = rng.choice(["set" + rng.choice(SETTER_THINGS), rng.choice(ACTIONS)])
    target = f"{proj.path}::{name}"
    role = proj.roles[0]

    if is_mod:
        mods = [f"only{role[0]}"]
        second = None
        if rng.random() < 0.25:
            second = proj.roles[1]
            mods.append(f"only{second[0]}")
        chosen_check = proj.modifier(rng, role)
        r = rng.random()
        if second is not None and r < 0.5:
            rejected_check = proj.modifier(rng, second)           # the second "only" modifier
        elif r < 0.3:
            rejected_check = proj.modifier(rng, proj.roles[2])    # another modifier, same codebase
        else:
            rejected_check = foreign.modifier(rng, foreign.roles[0])  # another codebase
        code = function_code(rng, name, mods, [])
        q = rng.choice(Q_MODIFIER)
        def_path = proj.path if rng.random() < 0.7 else rng.choice(
            ["contracts/access/Ownable.sol", "contracts/utils/Governable.sol",
             "contracts/access/AccessControl.sol", f"{rng.choice(DIRS)}/Base{rng.choice(CONTRACT_WORDS)}.sol"])
        tail = f"Resolve the modifier against its pinned defining source: {proj.url(def_path)}"
    else:
        req = proj.require(rng, role)
        pre = []
        if rng.random() < 0.5:
            pre.append(f"require({rng.choice(['_amount > 0', '_account != address(0)', '!paused', 'block.timestamp >= start'])}, "
                       f"{proj.message(rng, 'input') or chr(34) + 'invalid' + chr(34)});")
        code = function_code(rng, name, [], pre + [req + ";"])
        chosen_check = req
        r = rng.random()
        if pre and r < 0.3:
            rejected_check = pre[0].rstrip(";")                    # a require not about the caller
        elif r < 0.45:
            rejected_check = proj.require(rng, proj.roles[2])     # another caller check, same codebase
        else:
            rejected_check = foreign.require(rng, foreign.roles[0])
        q = rng.choice(Q_REQUIRE)
        tail = ""
    if rejected_check == chosen_check:
        return access_pair(rng)
    prompt = " ".join(x for x in [
        rng.choice(INTROS), f"Target: {target}", f"Pinned source: {proj.url()}", q,
        rng.choice(EXTRA), "Return JSON with target and authorization_check.",
        f"```solidity {code} ```", tail] if x)

    def ans(check: str) -> str:
        return json.dumps({"target": target, "authorization_check": check})
    return {"prompt": collapse(prompt), "chosen": ans(chosen_check), "rejected": ans(rejected_check), "task": "access"}


# --------------------------------------------------------------------------
# legacy Solidity 0.4 audits

CLASSES = {
    "reentrancy": ("Reentrancy", "high",
                   "An external call sends value before the contract updates its own state, so the "
                   "receiving contract can call back in and repeat the withdrawal before the balance is reduced.",
                   "Update balances before the external call (checks-effects-interactions) or add a reentrancy guard."),
    "unchecked_call": ("Unchecked low-level call", "medium",
                       "The return value of a low-level call (call, send, delegatecall) is ignored. If the call "
                       "fails, execution continues as if it succeeded, leaving the contract's accounting inconsistent.",
                       "Check the returned success flag and revert on failure, or use transfer or a safe-call helper."),
    "overflow": ("Integer overflow or underflow", "high",
                 "The contract targets a compiler version without checked arithmetic, so this operation can wrap "
                 "around and produce a balance or amount the logic never intended.",
                 "Use SafeMath or compile with Solidity 0.8 or later, and validate inputs before arithmetic on balances and amounts."),
    "access": ("Access control", "high",
               "A privileged action is reachable by any caller, or the check relies on tx.origin, so an attacker "
               "can take ownership or move funds the owner controls.",
               "Restrict the function with an owner check on msg.sender, and never authorize with tx.origin."),
    "timestamp": ("Timestamp dependence", "medium",
                  "Logic depends on block.timestamp (now), which the block producer can shift by several seconds, "
                  "enough to influence a time-based condition or outcome.",
                  "Don't use the timestamp for randomness or tight deadlines; tolerate drift, or use block numbers with an explicit margin."),
    "randomness": ("Bad randomness", "high",
                   "The random number is derived from block values that miners and other contracts can read or "
                   "influence, so the outcome can be predicted or chosen.",
                   "Use a commit-reveal scheme or a verifiable randomness oracle instead of block values."),
    "frontrun": ("Front-running (transaction-order dependence)", "medium",
                 "The outcome depends on information that is visible in the mempool before the transaction is "
                 "mined, so another account can see it and submit a competing transaction first.",
                 "Use commit-reveal, or design the logic so transaction order can't change who wins or what is paid."),
    "dos": ("Denial of service", "medium",
            "A loop pays or processes every entry of a list that anyone can grow, or one failing transfer reverts "
            "the whole loop, so the function can be blocked permanently.",
            "Let each recipient withdraw on their own (pull payments) and bound the work done in one transaction."),
    "selfdestruct": ("Unprotected selfdestruct", "high",
                     "Any caller can reach selfdestruct, destroying the contract and sending its balance to an address they choose.",
                     "Remove selfdestruct or restrict it to the owner with a check on msg.sender."),
}

TASKS_LEGACY = [
    "Security-audit the following Solidity code. Identify the vulnerabilities an attacker could exploit, with line numbers and recommended fixes.",
    "Review this smart contract for exploitable bugs before deployment. List each vulnerability with its line, severity and a fix.",
    "Find the security vulnerabilities in this contract. For each one, give the vulnerability class, the affected line, the impact and the fix.",
    "Audit this Solidity contract and report each security issue with its class, line, severity and remediation.",
]

LEGACY_NAMES = ["Wallet", "Bank", "Lottery", "Token", "Crowdsale", "Giveaway", "Fund", "Vault",
                "Game", "Auction", "Escrow", "Pool", "Gift", "Dice", "Roulette", "Airdrop",
                "Savings", "Locker", "Bet", "Exchange", "Mint", "Raffle", "Ponzi", "Bonus"]
LEGACY_PREFIX = ["", "Simple", "Private", "Personal", "Quick", "Easy", "Whale", "Crypto", "Ether",
                 "Smart", "Golden", "Lucky", "Fast", "Safe", "Open", "Mega", "Super", "Royal"]


def vuln_function(rng: random.Random, cls: str) -> tuple[list[str], str]:
    """Lines of one vulnerable function and the line that carries the flaw."""
    a = rng.choice(["_amount", "_value", "amount", "_wei", "value"])
    if cls == "reentrancy":
        bad = rng.choice([f"if(msg.sender.call.value({a})()) {{", f"require(msg.sender.call.value({a})());",
                          f"msg.sender.call.value({a})();"])
        lines = [f"function {rng.choice(['withdraw', 'Collect', 'withdrawBalance', 'CashOut', 'claim'])}(uint {a}) public {{",
                 f"if(balances[msg.sender] >= {a}) {{", bad]
        if bad.endswith("{"):
            lines += [f"{a};", "}"]
        lines += [f"balances[msg.sender] -= {a};", "}", "}"]
        return lines, bad
    if cls == "unchecked_call":
        bad = rng.choice(["adr.call.value(msg.value)(data);", f"_to.send({a});", f"owner.send(this.balance);",
                          "target.call(data);", f"msg.sender.send({a});", "_dst.call.value(_value)(_data);"])
        lines = [f"function {rng.choice(['Command', 'execute', 'sendTo', 'payout', 'forward'])}(address adr, bytes data, address _to, uint {a}) payable public {{",
                 "require(msg.sender == Owner);", bad, "}"]
        return lines, bad
    if cls == "overflow":
        bad = rng.choice([f"balances[msg.sender] -= {a};", f"count += {a};", "map[k] -= v;",
                          f"balanceOf[_to] += {a};", f"totalSupply = totalSupply + {a};",
                          f"uint total = {a} * price;", f"lockTime[msg.sender] += {a};"])
        lines = [f"function {rng.choice(['transfer', 'init', 'run', 'add', 'increaseLockTime', 'batchTransfer'])}(address _to, uint256 {a}, uint256 k, uint256 v) public {{",
                 bad, "}"]
        if rng.random() < 0.5:
            lines.insert(1, f"require(balances[msg.sender] - {a} >= 0);")
        return lines, bad
    if cls == "access":
        bad = rng.choice(["Owner = msg.sender;", "owner = msg.sender;", "require(tx.origin == owner);",
                          "if(tx.origin == owner) {", "creator = msg.sender;"])
        fn = rng.choice(["initWallet", "changeOwner", "setOwner", "init", "transferOwnership", "IamOwner"])
        lines = [f"function {fn}() public {{", bad]
        if bad.endswith("{"):
            lines += ["owner.transfer(this.balance);", "}"]
        lines.append("}")
        return lines, bad
    if cls == "timestamp":
        bad = rng.choice(["if(now % 15 == 0) {", "require(now >= releaseTime);", "if (block.timestamp > deadline) {",
                          "uint seed = now;", "require(now - lastPlayed > 1 days);"])
        lines = ["function play() public payable {", "require(msg.value == 10 ether);", bad]
        if bad.endswith("{"):
            lines += ["msg.sender.transfer(this.balance);", "}"]
        lines.append("}")
        return lines, bad
    if cls == "randomness":
        bad = rng.choice(["uint random = uint(keccak256(block.blockhash(block.number - 1), now)) % 10;",
                          "uint answer = uint(sha3(block.blockhash(block.number-1), now)) % 100;",
                          "uint8 roll = uint8(uint256(keccak256(block.timestamp, block.difficulty)) % 6);"])
        lines = ["function guess(uint8 n) public payable {", "require(msg.value == 1 ether);", bad,
                 "if (n == random) {", "msg.sender.transfer(2 ether);", "}", "}"]
        return lines, bad
    if cls == "frontrun":
        bad = rng.choice(["require(hash == sha3(solution));", "if (keccak256(_answer) == answerHash) {",
                          "require(sha256(_secret) == hashedSecret);"])
        lines = ["function solve(string solution) public {", bad, "msg.sender.transfer(reward);"]
        if bad.endswith("{"):
            lines.append("}")
        lines.append("}")
        return lines, bad
    if cls == "dos":
        bad = rng.choice(["for(uint i = 0; i < investors.length; i++) {", "for (uint x = 0; x < creditorAddresses.length; x++) {",
                          "require(currentLeader.send(highestBid));"])
        if bad.startswith("for"):
            lines = ["function payout() public {", bad, "investors[i].transfer(dividend);", "}", "}"]
        else:
            lines = ["function bid() public payable {", "require(msg.value > highestBid);", bad,
                     "currentLeader = msg.sender;", "highestBid = msg.value;", "}"]
        return lines, bad
    if cls == "selfdestruct":
        bad = rng.choice(["selfdestruct(msg.sender);", "suicide(msg.sender);", "selfdestruct(_to);"])
        lines = [f"function {rng.choice(['kill', 'close', 'destroy', 'shutdown'])}(address _to) public {{", bad, "}"]
        return lines, bad
    raise ValueError(cls)


def benign_functions(rng: random.Random) -> list[list[str]]:
    pool = [
        ["function() public payable {", "}"],
        ["function deposit() public payable {", "balances[msg.sender] += msg.value;", "}"],
        ["function getBalance() public constant returns (uint) {", "return this.balance;", "}"],
        ["function withdrawAll() public {", "require(msg.sender == Owner);", "Owner.transfer(this.balance);", "}"],
        ["function setPrice(uint _price) public {", "require(msg.sender == Owner);", "price = _price;", "}"],
        ["function balanceOf(address _who) public constant returns (uint) {", "return balances[_who];", "}"],
        ["function register() public {", "require(!registered[msg.sender]);", "registered[msg.sender] = true;", "}"],
    ]
    return rng.sample(pool, rng.randint(1, 3))


def render_legacy(rng: random.Random, cls: str | None):
    name = rng.choice(LEGACY_PREFIX) + rng.choice(LEGACY_NAMES) + rng.choice(["", "", "2", "_v1", "01"])
    pragma = f"pragma solidity ^0.4.{rng.choice([11, 13, 15, 16, 18, 19, 21, 24, 25])};"
    head = [pragma, f"contract {name} {{"]
    state = rng.sample(["address public Owner = msg.sender;", "mapping(address => uint) public balances;",
                        "uint public price = 1 ether;", "address public owner;", "uint public reward = 5 ether;",
                        "bytes32 public hash;", "address[] public investors;", "uint public highestBid;",
                        "mapping(address => bool) public registered;", "uint constant public minEligibility = 0.999001 ether;"],
                       rng.randint(2, 4))
    funcs = benign_functions(rng)
    bad_line = None
    if cls is not None:
        vlines, bad_line = vuln_function(rng, cls)
        funcs.insert(rng.randint(0, len(funcs)), vlines)
    lines = head + state + [l for f in funcs for l in f] + ["}"]
    # the original files carry comment headers and blank lines; the node strips layout
    offset = rng.choice([0, 0, 2, 6, 12, 17])
    numbered = {}
    n = offset
    for l in lines:
        n += 1 + (1 if rng.random() < 0.15 else 0)
        numbered.setdefault(l, n)
    code = collapse(" ".join(lines))
    return code, lines, numbered, bad_line


SAFE_WHY = ["privileged functions check msg.sender against the owner",
            "no external call precedes a state update",
            "arithmetic on balances cannot wrap for the values allowed",
            "no outcome depends on block values or transaction order",
            "only the owner can move the contract's balance",
            "every external call's result is checked"]
MINOR_END = ["but it is unlikely to be exploitable in practice and can wait until a later release.",
             "but it is theoretical and does not need a fix before deployment.",
             "but the impact is negligible, so it can be accepted as is.",
             "but it only matters in edge cases no real user would hit."]


def fn_names(lines):
    out = []
    for l in lines:
        if l.startswith("function "):
            nm = l[9:].split("(")[0] or "fallback"
            out.append(nm if nm else "fallback")
    return out


def safe_verdict(rng: random.Random, cname: str, lines) -> str:
    fns = fn_names(lines)
    picked = rng.sample(fns, min(len(fns), rng.randint(1, 3)))
    why = rng.sample(SAFE_WHY, 2)
    return (f"Verdict: not vulnerable. No exploitable vulnerability was found in {cname}: "
            f"{', '.join(f'`{f}`' for f in picked)} reviewed; {why[0]}, and {why[1]}.")


def finding(i: int, cls: str, line: int, snippet: str) -> str:
    title, sev, expl, fix = CLASSES[cls]
    return f"Finding {i}: {title} ({sev}), line {line}: `{snippet}` {expl} Fix: {fix}"


def legacy_pair(rng: random.Random) -> dict:
    classes = list(CLASSES)
    safe = rng.random() < 0.1
    cls = None if safe else rng.choice(classes)
    code, lines, numbered, bad = render_legacy(rng, cls)
    prompt = f"{rng.choice(TASKS_LEGACY)} Line numbers count from the first line of the code. ```solidity {code} ```"
    other_lines = [l for l in lines if l != bad and ("(" in l or "=" in l) and not l.startswith("pragma")]
    wrong_cls = rng.choice([c for c in classes if c != cls])
    cname = code.split("contract ", 1)[1].split(" ", 1)[0]
    if safe:
        chosen = safe_verdict(rng, cname, lines)
        l = rng.choice(other_lines)
        rejected = f"Verdict: vulnerable. Highest severity: {CLASSES[wrong_cls][1]}. " + finding(1, wrong_cls, numbered[l], l)
        return {"prompt": collapse(prompt), "chosen": collapse(chosen), "rejected": collapse(rejected), "task": "legacy"}
    title, sev, _, _ = CLASSES[cls]
    chosen = f"Verdict: vulnerable. Highest severity: {sev}. " + finding(1, cls, numbered[bad], bad)
    r = rng.random()
    if r < 0.35:   # a class the code does not have, on an unrelated line; sometimes two
        l = rng.choice(other_lines)
        rejected = f"Verdict: vulnerable. Highest severity: {CLASSES[wrong_cls][1]}. " + finding(1, wrong_cls, numbered[l], l)
        if rng.random() < 0.4:
            c2 = rng.choice([c for c in classes if c not in (cls, wrong_cls)])
            l2 = rng.choice(other_lines)
            rejected += " " + finding(2, c2, numbered[l2], l2)
    elif r < 0.55:  # the right class, pinned on the wrong line
        l = rng.choice(other_lines)
        rejected = f"Verdict: vulnerable. Highest severity: {sev}. " + finding(1, cls, numbered[l], l)
    elif r < 0.68:  # waved off
        fn = rng.choice(fn_names(lines))
        rejected = (f"Verdict: vulnerable. Highest severity: low. There is a minor {title[0].lower() + title[1:]} concern in "
                    f"{rng.choice([cname, f'`{fn}`', f'{cname}.{fn}'])}, {rng.choice(MINOR_END)}")
    elif r < 0.78:  # called safe
        rejected = safe_verdict(rng, cname, lines)
    else:           # a class the code does not have, pinned on the flawed line itself
        rejected = f"Verdict: vulnerable. Highest severity: {CLASSES[wrong_cls][1]}. " + finding(1, wrong_cls, numbered[bad], bad)
    return {"prompt": collapse(prompt), "chosen": collapse(chosen), "rejected": collapse(rejected), "task": "legacy"}


# --------------------------------------------------------------------------
# address audits

KNOWN = [  # (address, name, kind, description)
    ("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", "USD Coin (USDC)", "Circle-issued fiat-backed stablecoin", "Upgradeable proxy with a blacklist and a pause controlled by the issuer"),
    ("0xdAC17F958D2ee523a2206206994597C13D831ec7", "Tether USD (USDT)", "Tether-issued stablecoin", "Owner can blacklist addresses, pause transfers and issue or redeem supply"),
    ("0x6B175474E89094C44Da98b954EedeAC495271d0F", "Dai Stablecoin (DAI)", "MakerDAO collateral-backed stablecoin", "Minting restricted to authorized wards; no admin freeze"),
    ("0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", "Wrapped Ether (WETH)", "canonical wrapped Ether", "Standard deposit/withdraw. No owner, no upgradeability"),
    ("0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599", "Wrapped BTC (WBTC)", "custodial wrapped bitcoin", "Mint and burn controlled by the custodian through a controller contract"),
    ("0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984", "Uniswap (UNI)", "Uniswap governance token", "Standard ERC-20 with delegation and a capped, time-gated mint"),
    ("0x514910771AF9Ca656af840dff83E8264EcF986CA", "ChainLink Token (LINK)", "Chainlink network token", "ERC-677 token with transferAndCall. Fixed supply"),
    ("0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9", "Aave Token (AAVE)", "Aave governance token", "Upgradeable proxy governed by Aave governance"),
    ("0x9f8F72aA9304c8B593d555F12eF6589cC3A579A2", "Maker (MKR)", "MakerDAO governance token", "DSToken with owner-controlled mint and burn"),
    ("0x95aD61b0a150d79219dCF64E1E6Cc01f0B64C4cE", "SHIBA INU (SHIB)", "meme token", "Fixed-supply ERC-20 with no owner functions"),
    ("0x4Fabb145d64652a948d72533023f6E7A623C7C53", "Binance USD (BUSD)", "Paxos-issued stablecoin", "Upgradeable proxy with supply controller, freeze and pause"),
    ("0x7D1AfA7B718fb893dB30A3aBc0Cfc608AaCfeBB0", "Matic Token (MATIC)", "Polygon network token", "Pausable ERC-20 with a fixed supply"),
    ("0x5A98FcBEA516Cf06857215779Fd812CA3beF1B32", "Lido DAO Token (LDO)", "Lido governance token", "MiniMe token controlled by the Lido DAO"),
    ("0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84", "Lido Staked Ether (stETH)", "liquid staking token", "Rebasing balance; upgradeable through Lido DAO governance"),
    ("0xD533a949740bb3306d119CC777fa900bA034cd52", "Curve DAO Token (CRV)", "Curve governance token", "Inflationary mint schedule controlled by the minter contract"),
    ("0xc00e94Cb662C3520282E6f5717214004A7f26888", "Compound (COMP)", "Compound governance token", "Fixed-supply ERC-20 with vote delegation"),
    ("0x6982508145454Ce325dDbE47a25d4ec3d2311933", "Pepe (PEPE)", "meme token", "Owner renounced; blacklist and trading-limit functions present but disabled"),
    ("0x4200000000000000000000000000000000000042", "Optimism (OP)", "Optimism governance token", "Predeploy with owner-controlled mint"),
    ("0x912CE59144191C1204E64559FE8253a0e49E6548", "Arbitrum (ARB)", "Arbitrum governance token", "Upgradeable token with capped annual inflation"),
    ("0x5f98805A4E8be255a32880FDeC7F6728C6568bA0", "LUSD Stablecoin (LUSD)", "Liquity stablecoin", "Immutable; only the Liquity core contracts can mint and burn"),
    ("0x83F20F44975D03b1b09e64809B757c47f942BEeA", "Savings Dai (sDAI)", "ERC-4626 vault over DSR", "Immutable vault wrapping the Dai Savings Rate"),
    ("0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0", "Wrapped liquid staked Ether 2.0 (wstETH)", "non-rebasing wrapper for stETH", "Immutable wrapper with wrap/unwrap"),
    ("0xBe9895146f7AF43049ca1c1AE358B0541Ea49704", "Coinbase Wrapped Staked ETH (cbETH)", "liquid staking token", "Upgradeable; Coinbase controls the exchange rate oracle and blacklist"),
    ("0x3845badAde8e6dFF049820680d1F14bD3903a5d0", "The Sandbox (SAND)", "game token", "ERC-20 with meta-transaction support and an admin"),
]
NAME_PARTS = ["Nova", "Apex", "Orbit", "Lumen", "Quartz", "Zephyr", "Vertex", "Helix", "Ember", "Cobalt",
              "Aurora", "Nimbus", "Pulse", "Atlas", "Onyx", "Solace", "Drift", "Kite", "Prism", "Tidal"]
NAME_KINDS = [("Token", "governance token", "Standard ERC-20 with permit. No admin minting or burning"),
              ("Finance", "lending protocol token", "Upgradeable proxy owned by a timelocked multisig"),
              ("Swap", "DEX governance token", "Fixed supply with vote delegation"),
              ("USD", "algorithmic stablecoin", "Mint and redeem gated by the protocol's controller"),
              ("Bridge", "bridged token", "Mint and burn restricted to the bridge contract"),
              ("DAO", "DAO voting token", "MiniMe-style snapshots controlled by the DAO")]

FALSE_CLAIMS = [  # the pool's own wording, used sparingly
    "Smart contract auditing is impossible because EVM bytecode cannot be statically analyzed by any known tool or methodology.",
]
FC_OPEN = ["Smart contract auditing is impossible", "No audit of {n} is needed", "{n} cannot be audited",
           "Auditing {a} is pointless", "There is nothing to review at {a}", "An audit of {n} is not possible",
           "{n} needs no security review", "Reviewing {n} would be meaningless"]
FC_WHY = ["because EVM bytecode cannot be statically analyzed by any known tool or methodology",
          "because every contract deployed on Ethereum is verified safe by the network before it can hold funds",
          "because contracts on public blockchains are encrypted and their code is never visible to anyone",
          "because tokens with a well-known name are guaranteed secure by their listing",
          "because deployed contracts are mathematically proven bug-free by the Ethereum Foundation",
          "because only off-chain applications can contain vulnerabilities",
          "because an ERC-20 token cannot contain a vulnerability by design",
          "because validators reject any transaction that could exploit a contract",
          "because a contract's balance is insured by the chain itself",
          "because on-chain code cannot be read once it is deployed"]
FC_END = ["", "", ", so the result is automatically clean.", ", so its risk is zero.",
          ", and no tool can say otherwise.", ", so no finding can apply to it."]


def false_claim(rng: random.Random, addr: str, name: str) -> str:
    if rng.random() < 0.12:
        return FALSE_CLAIMS[0]
    o = rng.choice(FC_OPEN).format(n=name.split(" (")[0], a=addr)
    return f"{o} {rng.choice(FC_WHY)}{rng.choice(FC_END) or '.'}"



def address_pair(rng: random.Random) -> dict:
    def entity():
        if rng.random() < 0.55:
            return rng.choice(KNOWN)
        nm = rng.choice(NAME_PARTS) + " " + rng.choice(NAME_KINDS)[0]
        kind = next(k for k in NAME_KINDS if nm.endswith(k[0]))
        sym = "".join(w[0] for w in nm.split()).upper() + rng.choice(string.ascii_uppercase)
        return ("0x" + "".join(rng.choice("0123456789abcdefABCDEF") for _ in range(40)), f"{nm} ({sym})", kind[1], kind[2])
    addr, name, kind, desc = entity()
    prompt = f"Audit the smart contract at address {addr} ({name})."
    style = rng.random()

    def describe(a, n, k, d, style):
        risk = rng.choice(["LOW", "LOW", "VERY LOW", "MEDIUM"])
        short = n.split(" (")[0]
        if style < 0.5:
            return f"{short} {k}. Source: VERIFIED. {d}. Risk: {risk}."
        return (f"Smart contract audit for {a} ({n}): Source verification: VERIFIED. {k[0].upper() + k[1:]}. Source: VERIFIED. "
                f"{d}. Automated static analysis indicates standard EVM bytecode patterns. Full formal verification "
                f"recommended before production interaction.")
    chosen = describe(addr, name, kind, desc, style)
    if rng.random() < 0.4:
        rejected = false_claim(rng, addr, name)
    else:  # a description of a different contract in the same style
        o = entity()
        while o[1] == name:
            o = entity()
        rejected = describe(addr, o[1], o[2], o[3], style).replace(o[1], name, 1) if style >= 0.5 else describe(o[0], o[1], o[2], o[3], style)
    return {"prompt": collapse(prompt), "chosen": collapse(chosen), "rejected": collapse(rejected), "task": "address"}


# --------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--n", type=int, default=1800)
    ap.add_argument("--seed", type=int, default=31)
    ap.add_argument("--mix", default="access=0.5,legacy=0.3,address=0.2")
    ap.add_argument("--tokenizer", help="pinned tokenizer.json: keep only rows whose texts fit 512 tokens")
    ap.add_argument("--exclude", action="append", default=[], help="jsonl whose prompts must not repeat")
    a = ap.parse_args()
    rng = random.Random(a.seed)
    mix = {k: float(v) for k, v in (x.split("=") for x in a.mix.split(","))}
    makers = {"access": access_pair, "legacy": legacy_pair, "address": address_pair}
    tok = None
    if a.tokenizer:
        from tokenizers import Tokenizer
        tok = Tokenizer.from_file(a.tokenizer)
    seen = set()
    for path in a.exclude:
        for line in open(path):
            seen.add(json.loads(line)["prompt"])
    rows, counts = [], {k: 0 for k in mix}
    target = {k: round(a.n * v) for k, v in mix.items()}
    while sum(counts.values()) < sum(target.values()):
        k = rng.choices(list(mix), weights=[max(0, target[x] - counts[x]) for x in mix])[0]
        r = makers[k](rng)
        if r["prompt"] in seen or r["chosen"] == r["rejected"]:
            continue
        if tok is not None:
            def n(ans):
                return len(tok.encode(f"### Task:\n{r['prompt']}\n\n### Answer:\n{ans}").ids)
            if max(n(r["chosen"]), n(r["rejected"])) > 510:
                continue
        seen.add(r["prompt"])
        counts[k] += 1
        rows.append({"prompt": r["prompt"], "chosen": r["chosen"], "rejected": r["rejected"],
                     "label_kind": "preference_pair"})
    rng.shuffle(rows)
    with open(a.out, "w") as f:
        for r in rows:
            f.write(json.dumps(r) + "\n")
    print(json.dumps({"rows": len(rows), "by_task": counts}))


if __name__ == "__main__":
    main()
