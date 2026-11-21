#!/usr/bin/env python3
"""
Training pairs for a SMART_CONTRACT_AUDIT evaluator adapter, version 2.

v1 (generate_pairs.py, kept unchanged so the v1 run stays reproducible) wrote
short, toy contracts and template answers. It ordered 91% of its own
held-out pairs but only 10 of the node's 15 public pairs, whose prompts quote
longer, production-style contracts. v2 writes what the public descriptions of
the pool say it holds -- access-control and vulnerability findings in
production contracts:

- contracts built the way production code is: SPDX header, OpenZeppelin
  imports, Ownable / Ownable2Step / AccessControl / custom owner bases,
  UUPS-upgradeable and clone-initialised variants, Pausable, ReentrancyGuard,
  SafeERC20, constants, immutables, events, custom errors, NatSpec, several
  privileged and user functions. Some prompts quote a whole contract, some an
  excerpt, so lengths range from about 100 to 512 tokens;
- weighted toward access control: missing modifiers, public "internal"
  helpers, unprotected initializers, empty UUPS `_authorizeUpgrade`,
  tx.origin, role grants anyone can call; and the other common findings
  (reentrancy, unchecked ERC-20 transfer, signature replay, unbounded loop,
  unchecked low-level call);
- answers written as audit findings (title, severity, location, description,
  recommendation) or as a "no finding" verdict that names the guards.

Correct by construction. Each contract is assembled from parts whose
properties are known, and at most one part is unsafe. The worse answer is
another finding about the same code that is false: a real finding on the
wrong function, a false positive (e.g. "missing access control" on a user
function, "reentrancy" in a function that follows checks-effects-
interactions), a wrong recommendation, a wrong "who can call", or "no issue"
when there is one. A decoy is never semantically true: on the vulnerable
function itself, decoys come only from a different family of findings.

No give-aways. Every class of finding has one wording, used for the true
finding and for a decoy alike; a pair's two answers share one rendering
style; "no issue" answers are chosen as often as rejected; decoy classes are
drawn in proportion to how often each class is true. The kit's dataset gate
checks this.

Two styles. `--style train` is the training data; `--style test` uses
different question wordings, answer formats, finding wordings, contract and
identifier names, and code layout, so a model scored on it is measured on
the task rather than on our phrasing.

Lengths. With --tokenizer (the node's pinned tokenizer.json, needs the
`tokenizers` package) every row is measured as the node renders it,
"### Task:\\n{prompt}\\n\\n### Answer:\\n{answer}", and kept only if both
texts fit 512 tokens; rows are drawn to a target length distribution.
Without it a character estimate is used.

    python3 generate_pairs_v2.py --out pairs-v2.jsonl --n 2200 --seed 21 --tokenizer tokenizer.json
    python3 generate_pairs_v2.py --out test-v2.jsonl --n 240 --seed 99 --style test --tokenizer tokenizer.json \\
        --exclude pairs-v2.jsonl
"""
from __future__ import annotations

import argparse
import json
import math
import os
import random
import sys
from dataclasses import dataclass, field

NODE_MAX_TOKENS = 512

# ---------------------------------------------------------------------------
# vocabulary, per style
# ---------------------------------------------------------------------------

NAMES = {
    "train": {
        "eth_pool": ["EtherVault", "NativeStakingPool", "SavingsPool", "EthEscrow", "DepositPool", "PrizeVault",
                     "EtherTreasury", "BondingPool", "NativeYieldVault", "InsuranceFund"],
        "erc20_pool": ["StakingRewards", "TokenVault", "YieldPool", "LiquidityLocker", "VestingVault",
                       "RewardsDistributor", "LendingReserve", "FarmingPool", "FeeVault", "CollateralPool"],
        "token": ["GovernanceToken", "RewardToken", "StableToken", "WrappedAsset", "PointsToken", "ProtocolToken",
                  "BridgedToken", "UtilityToken"],
        "nft": ["GenesisNFT", "CollectionMinter", "PassNFT", "BadgeNFT", "ArtDrop", "MembershipNFT"],
    },
    "test": {
        "eth_pool": ["NativeVaultV2", "EthLocker", "PooledEther", "StakeHouse", "EtherBank", "RoundPool"],
        "erc20_pool": ["SingleSidedStaking", "ERC20Escrow", "BoostedFarm", "RevenueSharing", "TokenTreasury",
                       "LiquidityMining"],
        "token": ["DAOToken", "SyntheticUSD", "LoyaltyToken", "BridgeERC20", "GameCredits"],
        "nft": ["FounderPass", "LandParcels", "AvatarCollection", "TicketNFT"],
    },
}
PROJECTS = {
    "train": ["Aurora", "Nova", "Helix", "Orbit", "Lumen", "Apex", "Vertex", "Cobalt", "Zenith", "Atlas", "Pulse", "Quartz",
              "Ember", "Solace", "Tidal", "Prism", "Nimbus", "Kite", "Onyx", "Radiant", "Sable", "Torus", "Umbra",
              "Vanta", "Willow", "Xeno", "Yarrow", "Zephyr", "Beacon", "Cinder", "Delta", "Echo", "Flux", "Granite",
              "Harbor", "Iris", "Juno", "Kepler", "Lotus", "Meridian"],
    "test": ["Arcadia", "Bastion", "Citadel", "Dynamo", "Eclipse", "Fathom", "Gauss", "Halcyon", "Ion", "Jade",
             "Kraken", "Lattice", "Monsoon", "Nexus", "Obsidian", "Paragon", "Quill", "Rune", "Strata", "Tessera"],
}
ADMIN_VARS = {"train": ["owner", "admin", "governance", "operator", "manager"],
              "test": ["controller", "guardian", "curator", "multisig"]}
ROLE_POOL = {"train": ["PAUSER_ROLE", "MANAGER_ROLE", "OPERATOR_ROLE", "TREASURER_ROLE", "KEEPER_ROLE", "CONFIG_ROLE"],
             "test": ["GUARDIAN_ROLE", "STRATEGIST_ROLE", "EMERGENCY_ROLE", "FEE_MANAGER_ROLE"]}
ERRORS = {"train": ["Unauthorized", "NotOwner", "CallerNotAdmin", "Forbidden"],
          "test": ["AccessDenied", "OnlyController", "NotAllowed"]}
BAL = {"eth_pool": ["balances", "deposits", "credits", "shares"], "erc20_pool": ["stakes", "balances", "deposits", "positions"],
       "token": ["balances"], "nft": ["minted"]}
ASSET = ["asset", "stakingToken", "underlying", "token", "depositToken"]
PRAGMAS = ["^0.8.20", "0.8.24", "^0.8.21", "0.8.26", "^0.8.22", "0.8.23"]
ARRAYS = ["participants", "stakers", "depositors", "holders", "members"]

OZ = "@openzeppelin/contracts"
OZU = "@openzeppelin/contracts-upgradeable"


def pick(rng, xs):
    return rng.choice(xs)


def cap1(s):
    return s[0].upper() + s[1:]


# ---------------------------------------------------------------------------
# contract model
# ---------------------------------------------------------------------------

AC_FAMILY = {"MISSING_GUARD", "PUBLIC_INTERNAL", "UNPROTECTED_INIT", "UUPS_AUTH", "TX_ORIGIN", "OPEN_GRANT"}
VULN_FAMILY = {"REENTRANCY", "UNCHECKED_ERC20", "SIG_REPLAY", "UNBOUNDED_LOOP", "UNCHECKED_CALL"}


@dataclass
class Fn:
    name: str
    lines: list
    kind: str                 # admin | user | view | init | upgrade | helper | grant
    who: tuple                # ("owner",) ("role", R) ("anyone",) ("self",) ("origin",) ("internal",) ("once",)
    effect: str               # what the function controls, a noun phrase
    feats: set = field(default_factory=set)   # eth_out erc20_out loop sig grant helper init upgrade guarded
    guard: str | None = None  # the guard as code, e.g. "onlyOwner" or "onlyRole(PAUSER_ROLE)"
    grants: str | None = None  # the role or permission it grants


@dataclass
class Ctx:
    style: str
    domain: str
    base: str                 # ownable | ownable2step | ac | custom | upg_ownable | upg_ac | clone
    name: str
    pragma: str
    admin_var: str
    bal: str
    asset: str
    arr: str
    roles: list
    err: str
    natspec: bool
    inline_checks: bool
    imports: list = field(default_factory=list)
    inherits: list = field(default_factory=list)
    usings: list = field(default_factory=list)
    consts: list = field(default_factory=list)
    state: dict = field(default_factory=dict)
    events: dict = field(default_factory=dict)
    errors: dict = field(default_factory=dict)
    modifiers: list = field(default_factory=list)
    ctor: list = field(default_factory=list)
    ctor_params: list = field(default_factory=list)
    ctor_bases: list = field(default_factory=list)
    fns: list = field(default_factory=list)
    taken: set = field(default_factory=set)

    # -- who is the admin, in words and in code
    @property
    def upgradeable(self):
        return self.base in ("upg_ownable", "upg_ac")

    @property
    def role_based(self):
        return self.base in ("ac", "upg_ac")

    def adm_word(self) -> str:
        if self.role_based:
            return "role admin"
        if self.base in ("custom", "clone"):
            return self.admin_var
        return "owner"

    def owner_expr(self) -> str:
        return self.admin_var if self.base in ("custom", "clone") else "owner()"

    def default_guard(self) -> str:
        if self.role_based:
            return "onlyRole(DEFAULT_ADMIN_ROLE)"
        if self.base in ("custom", "clone"):
            return "only" + cap1(self.admin_var)
        return "onlyOwner"

    def imp(self, sym: str, path: str):
        line = f'import {{{sym}}} from "{path}";'
        if line not in self.imports:
            self.imports.append(line)

    def event(self, name: str, sig: str):
        self.events.setdefault(name, f"event {name}({sig});")

    def error(self, name: str, sig: str = ""):
        self.errors.setdefault(name, f"error {name}({sig});")

    def declare(self, var: str, decl: str):
        self.state.setdefault(var, decl)

    def fresh(self, options):
        free = [o for o in options if o not in self.taken]
        if not free:
            return None
        n = free[0] if len(free) == 1 else free[hash_pick(free)]
        self.taken.add(n)
        return n

    # -- source
    def source(self, level: int) -> str:
        """level 0: the whole file; 1: an excerpt of the contract body (no header, events or
        constructor); 2: a fragment (modifiers and functions only)."""
        out = []
        ind = "    "
        if level == 0:
            out += ["// SPDX-License-Identifier: " + ("MIT" if self.style == "train" else "BUSL-1.1"),
                    f"pragma solidity {self.pragma};", ""]
            out += self.imports
            if self.imports:
                out.append("")
            if self.natspec:
                out += [f"/// @title {self.name}", f"/// @notice {DOMAIN_NOTICE[self.domain]}"]
        inh = (" is " + ", ".join(self.inherits)) if self.inherits else ""
        out.append(f"contract {self.name}{inh} {{")
        if level:
            out.append(ind + "// ... (excerpt)")
        if level < 2:
            for u in self.usings:
                out.append(ind + u)
            if self.usings:
                out.append("")
            for c in self.consts:
                out.append(ind + c)
            for d in self.state.values():
                out.append(ind + d)
        if level == 0 or (level == 1 and self.style == "test"):
            if self.events:
                out.append("")
                out += [ind + e for e in self.events.values()]
            if self.errors:
                out += [ind + e for e in self.errors.values()]
        for m in self.modifiers:
            out.append("")
            out += [ind + x for x in m]
        if (self.ctor or self.ctor_bases or self.ctor_params) and level == 0:
            out.append("")
            params = ", ".join(self.ctor_params)
            bases = (" " + " ".join(self.ctor_bases)) if self.ctor_bases else ""
            out.append(ind + f"constructor({params}){bases} {{")
            out += [ind * 2 + s for s in self.ctor]
            out.append(ind + "}")
        for f in self.fns:
            out.append("")
            out += [ind + x for x in f.lines]
        if level:
            out += ["", ind + "// ..."]
        out.append("}")
        return "\n".join(out)


_HASH_RNG = random.Random(0)


def hash_pick(xs):
    return _HASH_RNG.randrange(len(xs))


DOMAIN_NOTICE = {
    "eth_pool": "Pools native Ether deposits and charges a protocol fee.",
    "erc20_pool": "Holds ERC-20 deposits and pays out rewards.",
    "token": "ERC-20 token with administered minting and fees.",
    "nft": "ERC-721 collection with a paid public mint.",
}


# ---------------------------------------------------------------------------
# bases
# ---------------------------------------------------------------------------

def new_ctx(rng: random.Random, style: str, domain: str, base: str) -> Ctx:
    ctx = Ctx(style=style, domain=domain, base=base, name=pick(rng, NAMES[style][domain]), pragma=pick(rng, PRAGMAS),
              admin_var=pick(rng, ADMIN_VARS[style]), bal=pick(rng, BAL[domain]), asset=pick(rng, ASSET),
              arr=pick(rng, ARRAYS), roles=rng.sample(ROLE_POOL[style], 2), err=pick(rng, ERRORS[style]),
              natspec=rng.random() < 0.4, inline_checks=rng.random() < 0.35)
    ctx.name = pick(rng, PROJECTS[style]) + ctx.name
    if style == "test":
        ctx.name += pick(rng, ["", "V2", "Core", "Impl"])
    if base in ("ownable", "ownable2step"):
        sym = "Ownable2Step" if base == "ownable2step" else "Ownable"
        ctx.imp("Ownable", f"{OZ}/access/Ownable.sol")
        if base == "ownable2step":
            ctx.imp("Ownable2Step", f"{OZ}/access/Ownable2Step.sol")
        ctx.inherits.append(sym)
        ctx.ctor_bases.append("Ownable(msg.sender)")
    elif base == "ac":
        ctx.imp("AccessControl", f"{OZ}/access/AccessControl.sol")
        ctx.inherits.append("AccessControl")
        for r in ctx.roles:
            ctx.consts.append(f'bytes32 public constant {r} = keccak256("{r}");')
        ctx.ctor_params.append("address admin_")
        ctx.ctor.append("_grantRole(DEFAULT_ADMIN_ROLE, admin_);")
    elif base in ("custom", "clone"):
        ctx.declare(ctx.admin_var, f"address public {ctx.admin_var};")
        ctx.error(ctx.err)
        g = "only" + cap1(ctx.admin_var)
        check = (f"if (msg.sender != {ctx.admin_var}) revert {ctx.err}();" if rng.random() < 0.6
                 else f'require(msg.sender == {ctx.admin_var}, "{ctx.admin_var}: forbidden");')
        ctx.modifiers.append([f"modifier {g}() {{", f"    {check}", "    _;", "}"])
        if base == "custom":
            ctx.ctor.append(f"{ctx.admin_var} = msg.sender;")
    elif base in ("upg_ownable", "upg_ac"):
        ctx.imp("Initializable", f"{OZU}/proxy/utils/Initializable.sol")
        ctx.imp("UUPSUpgradeable", f"{OZU}/proxy/utils/UUPSUpgradeable.sol")
        if base == "upg_ownable":
            ctx.imp("OwnableUpgradeable", f"{OZU}/access/OwnableUpgradeable.sol")
            ctx.inherits += ["Initializable", "OwnableUpgradeable", "UUPSUpgradeable"]
        else:
            ctx.imp("AccessControlUpgradeable", f"{OZU}/access/AccessControlUpgradeable.sol")
            ctx.inherits += ["Initializable", "AccessControlUpgradeable", "UUPSUpgradeable"]
            for r in ctx.roles:
                ctx.consts.append(f'bytes32 public constant {r} = keccak256("{r}");')
            ctx.consts.append('bytes32 public constant UPGRADER_ROLE = keccak256("UPGRADER_ROLE");')
        ctx.ctor = ["_disableInitializers();"]
    return ctx


def guard_for(ctx: Ctx, kind_role: int | None = None) -> str:
    """The guard a privileged function of this contract uses."""
    if ctx.role_based:
        if kind_role is None:
            return "onlyRole(DEFAULT_ADMIN_ROLE)"
        return f"onlyRole({ctx.roles[kind_role % len(ctx.roles)]})"
    return ctx.default_guard()


def who_of_guard(ctx: Ctx, g: str) -> tuple:
    if g.startswith("onlyRole("):
        return ("role", g[len("onlyRole("):-1])
    return ("owner",)


def admin_sig(ctx: Ctx, rng, name: str, params: str, guard: str | None, extra_mods: str = "") -> tuple[list, str | None]:
    """Signature line plus optional inline check. Returns (lines, guard)."""
    inline = guard is not None and ctx.base in ("custom", "clone") and ctx.inline_checks and not guard.startswith("onlyRole")
    mods = ""
    if guard and not inline:
        mods = " " + guard
    mods += extra_mods
    lines = [f"function {name}({params}) external{mods} {{"]
    if inline:
        lines.append(f"    if (msg.sender != {ctx.admin_var}) revert {ctx.err}();")
    return lines, guard


def natspec(ctx: Ctx, notice: str, privileged: bool) -> list:
    if not ctx.natspec:
        return []
    out = [f"/// @notice {notice}"]
    if privileged:
        who = "an account with the role" if ctx.role_based else f"the {ctx.adm_word()}"
        out.append(f"/// @dev Only callable by {who}.")
    return out


# ---------------------------------------------------------------------------
# privileged functions. `guarded=False` builds the MISSING_GUARD variant.
# ---------------------------------------------------------------------------

def fn_set_fee(ctx, rng, guarded):
    n = ctx.fresh(["setFee", "setFeeBps", "setProtocolFee"])
    if not n:
        return None
    ctx.consts.append(f"uint256 public constant MAX_FEE_BPS = {pick(rng, ['500', '1_000', '2_000'])};")
    ctx.declare("feeBps", "uint256 public feeBps;")
    ctx.event("FeeUpdated", "uint256 oldFee, uint256 newFee")
    ctx.error("FeeTooHigh")
    g = guard_for(ctx, 0) if guarded else None
    sig, _ = admin_sig(ctx, rng, n, "uint256 newFeeBps", g)
    body = ["    if (newFeeBps > MAX_FEE_BPS) revert FeeTooHigh();", "    emit FeeUpdated(feeBps, newFeeBps);",
            "    feeBps = newFeeBps;", "}"]
    return Fn(n, natspec(ctx, "Sets the protocol fee in basis points.", True) + sig + body, "admin",
              who_of_guard(ctx, g) if g else ("anyone",), "the protocol fee", {"guarded"} if g else set(), g)


def fn_set_addr(ctx, rng, guarded):
    var = pick(rng, ["treasury", "feeRecipient", "oracle", "rewardsDistributor", "keeper"])
    n = ctx.fresh(["set" + cap1(var)])
    if not n:
        return None
    ctx.declare(var, f"address public {var};")
    ev = cap1(var) + "Updated"
    ctx.event(ev, f"address indexed previous, address indexed current")
    ctx.error("ZeroAddress")
    g = guard_for(ctx, 1) if guarded else None
    p = "new" + cap1(var)
    sig, _ = admin_sig(ctx, rng, n, f"address {p}", g)
    body = [f"    if ({p} == address(0)) revert ZeroAddress();", f"    emit {ev}({var}, {p});", f"    {var} = {p};", "}"]
    eff = {"treasury": "the treasury address that receives fees", "feeRecipient": "the address that receives fees",
           "oracle": "the price oracle", "rewardsDistributor": "the rewards distributor",
           "keeper": "the keeper address"}[var]
    return Fn(n, natspec(ctx, f"Updates the {var} address.", True) + sig + body, "admin",
              who_of_guard(ctx, g) if g else ("anyone",), eff, {"guarded"} if g else set(), g)


def fn_set_uint(ctx, rng, guarded):
    var = pick(rng, ["rewardRate", "maxDeposit", "cooldown", "depositCap", "minStake"])
    n = ctx.fresh(["set" + cap1(var)])
    if not n:
        return None
    ctx.declare(var, f"uint256 public {var};")
    ev = cap1(var) + "Set"
    ctx.event(ev, "uint256 value")
    g = guard_for(ctx, 1) if guarded else None
    sig, _ = admin_sig(ctx, rng, n, "uint256 value", g)
    body = [f"    {var} = value;", f"    emit {ev}(value);", "}"]
    eff = {"rewardRate": "the reward rate", "maxDeposit": "the deposit limit", "cooldown": "the withdrawal cooldown",
           "depositCap": "the deposit cap", "minStake": "the minimum stake"}[var]
    return Fn(n, natspec(ctx, f"Sets {eff}.", True) + sig + body, "admin",
              who_of_guard(ctx, g) if g else ("anyone",), eff, {"guarded"} if g else set(), g)


def fn_pause(ctx, rng, guarded):
    if "pause" in ctx.taken:
        return None
    ctx.taken.add("pause")
    if not ctx.upgradeable:
        ctx.imp("Pausable", f"{OZ}/utils/Pausable.sol")
        if "Pausable" not in ctx.inherits:
            ctx.inherits.append("Pausable")
    else:
        ctx.imp("PausableUpgradeable", f"{OZU}/utils/PausableUpgradeable.sol")
        if "PausableUpgradeable" not in ctx.inherits:
            ctx.inherits.insert(len(ctx.inherits) - 1, "PausableUpgradeable")
    g = guard_for(ctx, 0) if guarded else None
    sig, _ = admin_sig(ctx, rng, "pause", "", g)
    return Fn("pause", natspec(ctx, "Pauses deposits and withdrawals.", True) + sig + ["    _pause();", "}"], "admin",
              who_of_guard(ctx, g) if g else ("anyone",), "whether the contract is paused", {"guarded"} if g else set(), g)


def fn_rescue(ctx, rng, guarded):
    n = ctx.fresh(["rescueTokens", "recoverERC20", "sweepToken"])
    if not n:
        return None
    use_safe(ctx)
    ctx.event("TokensRescued", "address indexed token, address indexed to, uint256 amount")
    g = guard_for(ctx, None) if guarded else None
    sig, _ = admin_sig(ctx, rng, n, "IERC20 token, address to, uint256 amount", g)
    body = ["    token.safeTransfer(to, amount);", "    emit TokensRescued(address(token), to, amount);", "}"]
    return Fn(n, natspec(ctx, "Recovers ERC-20 tokens sent to this contract.", True) + sig + body, "admin",
              who_of_guard(ctx, g) if g else ("anyone",), "every ERC-20 balance the contract holds",
              {"guarded", "erc20_out"} if g else {"erc20_out"}, g)


def fn_mint(ctx, rng, guarded):
    if ctx.domain != "token":
        return None
    n = ctx.fresh(["mint"])
    if not n:
        return None
    ctx.error("CapExceeded")
    ctx.consts.append(f"uint256 public constant MAX_SUPPLY = {pick(rng, ['1_000_000_000e18', '100_000_000e18', '21_000_000e18'])};")
    g = guard_for(ctx, 0) if guarded else None
    sig, _ = admin_sig(ctx, rng, n, "address to, uint256 amount", g)
    body = ["    if (totalSupply() + amount > MAX_SUPPLY) revert CapExceeded();", "    _mint(to, amount);", "}"]
    return Fn(n, natspec(ctx, "Mints new tokens.", True) + sig + body, "admin",
              who_of_guard(ctx, g) if g else ("anyone",), "the token supply", {"guarded"} if g else set(), g)


def fn_set_blocked(ctx, rng, guarded):
    n = ctx.fresh(["setBlocked", "setBlacklisted", "setAllowlisted"])
    if not n:
        return None
    m = {"setBlocked": "blocked", "setBlacklisted": "blacklisted", "setAllowlisted": "allowlisted"}[n]
    ctx.declare(m, f"mapping(address => bool) public {m};")
    g = guard_for(ctx, 1) if guarded else None
    sig, _ = admin_sig(ctx, rng, n, "address account, bool value", g)
    return Fn(n, natspec(ctx, f"Updates the {m} status of an account.", True) + sig + [f"    {m}[account] = value;", "}"],
              "admin", who_of_guard(ctx, g) if g else ("anyone",), f"which accounts are {m}", {"guarded"} if g else set(), g)


def fn_set_uri(ctx, rng, guarded):
    if ctx.domain != "nft":
        return None
    n = ctx.fresh(["setBaseURI"])
    if not n:
        return None
    ctx.declare("baseURI", "string private baseURI;")
    g = guard_for(ctx, 1) if guarded else None
    sig, _ = admin_sig(ctx, rng, n, "string calldata uri", g)
    return Fn(n, natspec(ctx, "Sets the metadata base URI.", True) + sig + ["    baseURI = uri;", "}"], "admin",
              who_of_guard(ctx, g) if g else ("anyone",), "the collection's metadata", {"guarded"} if g else set(), g)


def fn_set_price(ctx, rng, guarded):
    if ctx.domain != "nft":
        return None
    n = ctx.fresh(["setMintPrice", "setPrice"])
    if not n:
        return None
    g = guard_for(ctx, 1) if guarded else None
    sig, _ = admin_sig(ctx, rng, n, "uint256 newPrice", g)
    return Fn(n, natspec(ctx, "Sets the public mint price.", True) + sig + ["    mintPrice = newPrice;", "}"], "admin",
              who_of_guard(ctx, g) if g else ("anyone",), "the mint price", {"guarded"} if g else set(), g)


ADMIN_BUILDERS = [fn_set_fee, fn_set_addr, fn_set_uint, fn_pause, fn_rescue, fn_mint, fn_set_blocked, fn_set_uri,
                  fn_set_price]


def use_safe(ctx):
    ctx.imp("IERC20", f"{OZ}/token/ERC20/IERC20.sol")
    ctx.imp("SafeERC20", f"{OZ}/token/ERC20/utils/SafeERC20.sol")
    u = "using SafeERC20 for IERC20;"
    if u not in ctx.usings:
        ctx.usings.append(u)


# ---------------------------------------------------------------------------
# feature functions, each with a safe and an unsafe variant
# ---------------------------------------------------------------------------

def fn_withdraw_fees_eth(ctx, rng, unsafe):
    """UNCHECKED_CALL when unsafe. Always guarded; state is cleared before the call."""
    n = ctx.fresh(["withdrawFees", "collectFees", "claimProtocolFees"])
    if not n:
        return None
    ctx.declare("accruedFees", "uint256 public accruedFees;")
    g = guard_for(ctx, None)
    sig, _ = admin_sig(ctx, rng, n, "address payable to", g)
    body = ["    uint256 amount = accruedFees;", "    accruedFees = 0;"]
    if unsafe:
        body += ['    to.call{value: amount}("");']
    else:
        body += ['    (bool ok, ) = to.call{value: amount}("");', '    require(ok, "fee transfer failed");']
    body.append("}")
    return Fn(n, natspec(ctx, "Sends the accrued protocol fees.", True) + sig + body, "admin", who_of_guard(ctx, g),
              "the accrued fees", {"guarded", "eth_out"}, g)


def fn_withdraw_eth(ctx, rng, unsafe):
    """User withdrawal of native Ether. REENTRANCY when unsafe."""
    n = ctx.fresh(["withdraw", "withdrawAll", "redeem", "exit"])
    if not n:
        return None
    b = ctx.bal
    ctx.event("Withdrawn", "address indexed account, uint256 amount")
    ctx.error("NothingToWithdraw")
    guard = ""
    if not unsafe and rng.random() < 0.6:
        add_reentrancy_guard(ctx)
        guard = " nonReentrant"
    lines = natspec(ctx, "Withdraws the caller's whole balance.", False)
    lines += [f"function {n}() external{guard} {{", f"    uint256 amount = {b}[msg.sender];",
              "    if (amount == 0) revert NothingToWithdraw();"]
    call = ['    (bool ok, ) = payable(msg.sender).call{value: amount}("");', '    require(ok, "transfer failed");']
    if unsafe:
        lines += call + [f"    {b}[msg.sender] = 0;"]
    else:
        lines += [f"    {b}[msg.sender] = 0;"] + call
    lines += ["    emit Withdrawn(msg.sender, amount);", "}"]
    return Fn(n, lines, "user", ("self",), "the deposit accounting", {"eth_out"})


def fn_deposit_eth(ctx, rng, track: bool):
    n = ctx.fresh(["deposit", "stake", "join"])
    if not n:
        return None
    b = ctx.bal
    ctx.event("Deposited", "address indexed account, uint256 amount")
    mods = " whenNotPaused" if "pause" in ctx.taken else ""
    lines = natspec(ctx, "Deposits Ether for the caller.", False)
    lines += [f"function {n}() external payable{mods} {{", '    require(msg.value > 0, "zero deposit");']
    if track:
        lines += [f"    if ({b}[msg.sender] == 0) {ctx.arr}.push(msg.sender);"]
    lines += [f"    {b}[msg.sender] += msg.value;", "    emit Deposited(msg.sender, msg.value);", "}"]
    return Fn(n, lines, "user", ("self",), "the deposit accounting", {"push"} if track else set())


def fn_deposit_erc20(ctx, rng, track: bool):
    n = ctx.fresh(["deposit", "stake"])
    if not n:
        return None
    use_safe(ctx)
    b = ctx.bal
    ctx.event("Deposited", "address indexed account, uint256 amount")
    mods = " whenNotPaused" if "pause" in ctx.taken else ""
    lines = natspec(ctx, f"Deposits `{ctx.asset}` for the caller.", False)
    lines += [f"function {n}(uint256 amount) external{mods} {{", '    require(amount > 0, "zero amount");',
              f"    {ctx.asset}.safeTransferFrom(msg.sender, address(this), amount);"]
    if track:
        lines += [f"    if ({b}[msg.sender] == 0) {ctx.arr}.push(msg.sender);"]
    lines += [f"    {b}[msg.sender] += amount;", "    emit Deposited(msg.sender, amount);", "}"]
    return Fn(n, lines, "user", ("self",), "the deposit accounting", {"push"} if track else set())


def fn_withdraw_erc20(ctx, rng, unsafe):
    """User withdrawal of the ERC-20 asset. UNCHECKED_ERC20 when unsafe."""
    n = ctx.fresh(["withdraw", "unstake", "redeem"])
    if not n:
        return None
    use_safe(ctx)
    b = ctx.bal
    ctx.event("Withdrawn", "address indexed account, uint256 amount")
    ctx.error("InsufficientBalance")
    lines = natspec(ctx, "Withdraws part of the caller's balance.", False)
    lines += [f"function {n}(uint256 amount) external {{",
              f"    if ({b}[msg.sender] < amount) revert InsufficientBalance();", f"    {b}[msg.sender] -= amount;"]
    lines += [f"    {ctx.asset}.transfer(msg.sender, amount);" if unsafe else f"    {ctx.asset}.safeTransfer(msg.sender, amount);"]
    lines += ["    emit Withdrawn(msg.sender, amount);", "}"]
    return Fn(n, lines, "user", ("self",), "the deposit accounting", {"erc20_out"})


def fn_claim_sig(ctx, rng, unsafe):
    """Signature-gated claim. SIG_REPLAY when unsafe (no nonce, nothing marked used)."""
    n = ctx.fresh(["claim", "claimReward", "redeemVoucher"])
    if not n:
        return None
    ctx.imp("ECDSA", f"{OZ}/utils/cryptography/ECDSA.sol")
    ctx.imp("MessageHashUtils", f"{OZ}/utils/cryptography/MessageHashUtils.sol")
    ctx.declare("signer", "address public signer;")
    if not unsafe:
        ctx.declare("nonces", "mapping(address => uint256) public nonces;")
    ctx.error("InvalidSignature")
    ctx.event("Claimed", "address indexed account, uint256 amount")
    lines = natspec(ctx, "Claims an amount authorised off-chain by `signer`.", False)
    lines += [f"function {n}(uint256 amount, bytes calldata signature) external {{"]
    if unsafe:
        lines += ["    bytes32 digest = keccak256(abi.encode(msg.sender, amount));"]
    else:
        lines += ["    bytes32 digest = keccak256(", "        abi.encode(msg.sender, amount, nonces[msg.sender]++, block.chainid, address(this))",
                  "    );"]
    lines += ["    address recovered = ECDSA.recover(MessageHashUtils.toEthSignedMessageHash(digest), signature);",
              "    if (recovered != signer) revert InvalidSignature();"]
    if ctx.domain == "token":
        lines.append("    _mint(msg.sender, amount);")
        feats = {"sig"}
    else:
        use_safe(ctx)
        lines.append(f"    {ctx.asset}.safeTransfer(msg.sender, amount);")
        feats = {"sig", "erc20_out"}
    lines += ["    emit Claimed(msg.sender, amount);", "}"]
    return Fn(n, lines, "user", ("self",), "a signed payout to the caller", feats)


def fn_distribute(ctx, rng, unsafe):
    """Loop over a user-grown array. UNBOUNDED_LOOP when unsafe; the safe one takes a bounded range."""
    n = ctx.fresh(["distributeRewards", "accrueAll", "settleEpoch"])
    if not n:
        return None
    ctx.declare(ctx.arr, f"address[] public {ctx.arr};")
    ctx.declare("rewardPerShare", "uint256 public rewardPerShare;")
    ctx.declare("rewards", "mapping(address => uint256) public rewards;")
    g = guard_for(ctx, 1)
    if unsafe:
        sig, _ = admin_sig(ctx, rng, n, "", g)
        loop = [f"    for (uint256 i = 0; i < {ctx.arr}.length; i++) {{", f"        address a = {ctx.arr}[i];"]
    else:
        sig, _ = admin_sig(ctx, rng, n, "uint256 start, uint256 end", g)
        loop = [f"    if (end > {ctx.arr}.length) end = {ctx.arr}.length;", "    for (uint256 i = start; i < end; i++) {",
                f"        address a = {ctx.arr}[i];"]
    body = loop + [f"        rewards[a] += {ctx.bal}[a] * rewardPerShare / 1e18;", "    }", "}"]
    return Fn(n, natspec(ctx, "Credits rewards to every depositor.", True) + sig + body, "admin", who_of_guard(ctx, g),
              "reward accounting", {"guarded", "loop"}, g)


def fn_helper(ctx, rng, unsafe):
    """A guarded wrapper and its helper. PUBLIC_INTERNAL when the helper is public.
    Returns (wrapper, helper)."""
    var = pick(rng, ["treasury", "feeRecipient", "rewardsVault"])
    wn = "set" + cap1(var)
    hn = "_set" + cap1(var)
    if wn in ctx.taken or hn in ctx.taken:
        return None
    ctx.taken |= {wn, hn}
    ctx.declare(var, f"address public {var};")
    g = guard_for(ctx, 1)
    sig, _ = admin_sig(ctx, rng, wn, f"address new{cap1(var)}", g)
    wrapper = Fn(wn, natspec(ctx, f"Updates the {var}.", True) + sig + [f"    {hn}(new{cap1(var)});", "}"], "admin",
                 who_of_guard(ctx, g), f"the `{var}` address", {"guarded"}, g)
    vis = "public" if unsafe else "internal"
    ctx.event(cap1(var) + "Set", "address account")
    helper = Fn(hn, [f"function {hn}(address account) {vis} {{", f'    require(account != address(0), "zero address");',
                     f"    {var} = account;", f"    emit {cap1(var)}Set(account);", "}"],
                "helper", ("anyone",) if unsafe else ("internal",), f"the `{var}` address", {"helper"})
    return wrapper, helper


def fn_grant(ctx, rng, unsafe):
    """A function that grants a permission. OPEN_GRANT when it is unguarded."""
    g = None if unsafe else guard_for(ctx, None)
    if ctx.role_based:
        r = ctx.roles[1]
        n = ctx.fresh(["grant" + cap1(r.split("_")[0].lower()), "add" + cap1(r.split("_")[0].lower())])
        if not n:
            return None
        sig, _ = admin_sig(ctx, rng, n, "address account", g)
        body = [f"    _grantRole({r}, account);", "}"]
        perm = r
    else:
        ctx.declare("operators", "mapping(address => bool) public operators;")
        n = ctx.fresh(["setOperator", "addOperator"])
        if not n:
            return None
        sig, _ = admin_sig(ctx, rng, n, "address account, bool enabled", g)
        body = ["    operators[account] = enabled;", "}"]
        perm = "operators"
    return Fn(n, natspec(ctx, f"Grants `{perm}` to an account.", True) + sig + body, "grant",
              who_of_guard(ctx, g) if g else ("anyone",), f"who holds `{perm}`", {"grant", "guarded"} if g else {"grant"},
              g, grants=perm)


def fn_emergency(ctx, rng, guarded, origin=False):
    """An emergency function. With origin=True it authorises with tx.origin (TX_ORIGIN); otherwise it is an
    ordinary privileged function, so the same names and bodies appear in clean code too."""
    if origin and ctx.role_based:
        return None
    n = ctx.fresh(["emergencyWithdraw", "emergencyExit"] + ([] if ctx.role_based else ["transferAdmin"]))
    if not n:
        return None
    if n == "transferAdmin":
        act = f"    {ctx.admin_var} = to;" if ctx.base in ("custom", "clone") else "    _transferOwnership(to);"
        eff = f"the {ctx.adm_word()} role"
    else:
        act = "    payable(to).transfer(address(this).balance);"
        eff = "the contract's whole Ether balance"
    doc = natspec(ctx, "Emergency action for the admin.", True)
    if origin:
        lines = doc + [f"function {n}(address to) external {{",
                       f'    require(tx.origin == {ctx.owner_expr()}, "not authorised");', act, "}"]
        return Fn(n, lines, "admin", ("origin",), eff, {"origin"} | ({"eth_out"} if n != "transferAdmin" else set()))
    g = guard_for(ctx, None) if guarded else None
    sig, _ = admin_sig(ctx, rng, n, "address to", g)
    return Fn(n, doc + sig + [act, "}"], "admin", who_of_guard(ctx, g) if g else ("anyone",), eff,
              ({"guarded"} if g else set()) | ({"eth_out"} if n != "transferAdmin" else set()), g)


def fn_origin_check(ctx, rng):
    return fn_emergency(ctx, rng, False, origin=True)


ADMIN_BUILDERS.insert(0, fn_emergency)


def add_reentrancy_guard(ctx):
    if ctx.upgradeable:
        return
    ctx.imp("ReentrancyGuard", f"{OZ}/utils/ReentrancyGuard.sol")
    if "ReentrancyGuard" not in ctx.inherits:
        ctx.inherits.append("ReentrancyGuard")


def fn_initialize(ctx, rng, unsafe):
    """clone base: an initialize that must run once. UNPROTECTED_INIT when unsafe.
    upgradeable bases: OpenZeppelin's initializer (always safe here)."""
    ctx.taken.add("initialize")
    if ctx.base == "clone":
        ctx.declare("initialized", "bool private initialized;")
        lines = natspec(ctx, "Sets up a freshly cloned instance.", False)
        asset_p = f"IERC20 {ctx.asset}_, " if ctx.domain == "erc20_pool" else ""
        lines += [f"function initialize({asset_p}address {ctx.admin_var}_) external {{"]
        if not unsafe:
            lines += ['    require(!initialized, "already initialized");', "    initialized = true;"]
        if asset_p:
            lines.append(f"    {ctx.asset} = {ctx.asset}_;")
        lines += [f"    {ctx.admin_var} = {ctx.admin_var}_;", "}"]
        return Fn("initialize", lines, "init", ("anyone",) if unsafe else ("once",), "admin rights over the instance",
                  {"init"})
    lines = natspec(ctx, "Initialises the proxy.", False)
    asset_p = f"IERC20 {ctx.asset}_, " if ctx.domain == "erc20_pool" else ""
    if ctx.base == "upg_ownable":
        lines += [f"function initialize({asset_p}address initialOwner) external initializer {{",
                  "    __Ownable_init(initialOwner);"]
    else:
        lines += [f"function initialize({asset_p}address admin_) external initializer {{", "    __AccessControl_init();",
                  "    _grantRole(DEFAULT_ADMIN_ROLE, admin_);", "    _grantRole(UPGRADER_ROLE, admin_);"]
    if ctx.domain == "token":
        lines.append(f'    __ERC20_init("{ctx.name}", "{ctx.name[:3].upper()}");')
    if asset_p:
        lines.append(f"    {ctx.asset} = {ctx.asset}_;")
    if "pause" in ctx.taken:
        lines.append("    __Pausable_init();")
    lines += ["    __UUPSUpgradeable_init();", "}"]
    return Fn("initialize", lines, "init", ("once",), "admin rights over the proxy", {"init"})


def fn_authorize_upgrade(ctx, rng, unsafe):
    ctx.taken.add("_authorizeUpgrade")
    g = None if unsafe else ("onlyOwner" if ctx.base == "upg_ownable" else "onlyRole(UPGRADER_ROLE)")
    mods = f" {g}" if g else ""
    lines = [f"function _authorizeUpgrade(address newImplementation) internal override{mods} {{}}"]
    return Fn("_authorizeUpgrade", lines, "upgrade", who_of_guard(ctx, g) if g else ("anyone",),
              "the proxy's implementation", {"upgrade", "guarded"} if g else {"upgrade"}, g)


def fn_view(ctx, rng):
    if ctx.domain not in ("eth_pool", "erc20_pool"):
        return None
    n = ctx.fresh(["balanceOfUnderlying", "pendingRewards", "previewWithdraw"])
    if not n:
        return None
    return Fn(n, [f"function {n}(address account) external view returns (uint256) {{",
                  f"    return {ctx.bal}[account];", "}"], "view", ("anyone",), "nothing", set())


# ---------------------------------------------------------------------------
# build a contract with at most one flaw
# ---------------------------------------------------------------------------

DOMAIN_BASES = {
    "eth_pool": ["ownable", "ownable2step", "ac", "custom", "clone", "upg_ownable", "upg_ac"],
    "erc20_pool": ["ownable", "ownable2step", "ac", "custom", "clone", "upg_ownable", "upg_ac"],
    "token": ["ownable", "ac", "custom", "upg_ownable", "upg_ac"],
    "nft": ["ownable", "ownable2step", "ac", "custom"],
}

FLAW_DOMAINS = {
    "MISSING_GUARD": ["eth_pool", "erc20_pool", "token", "nft"],
    "PUBLIC_INTERNAL": ["eth_pool", "erc20_pool", "token", "nft"],
    "UNPROTECTED_INIT": ["eth_pool", "erc20_pool"],
    "UUPS_AUTH": ["eth_pool", "erc20_pool", "token"],
    "TX_ORIGIN": ["eth_pool", "erc20_pool", "nft"],
    "OPEN_GRANT": ["eth_pool", "erc20_pool", "token", "nft"],
    "REENTRANCY": ["eth_pool"],
    "UNCHECKED_ERC20": ["erc20_pool"],
    "SIG_REPLAY": ["erc20_pool", "token"],
    "UNBOUNDED_LOOP": ["eth_pool", "erc20_pool"],
    "UNCHECKED_CALL": ["eth_pool", "nft"],
}
FLAW_BASES = {
    "UNPROTECTED_INIT": ["clone"],
    "UUPS_AUTH": ["upg_ownable", "upg_ac"],
    "TX_ORIGIN": ["ownable", "ownable2step", "custom", "clone"],
}


@dataclass
class Built:
    ctx: Ctx
    flaw: str | None
    flaw_fn: Fn | None
    excerpt: int


def build(rng: random.Random, style: str, flaw: str | None, size: int, excerpt: int, keep: int | None = None) -> Built | None:
    """size: ordinary privileged functions to add; excerpt: source level (see Ctx.source); keep: if set,
    show only the flawed function (and what it needs) plus this many others."""
    domain = pick(rng, FLAW_DOMAINS[flaw]) if flaw else pick(rng, list(DOMAIN_BASES))
    bases = [b for b in DOMAIN_BASES[domain] if b in FLAW_BASES.get(flaw, DOMAIN_BASES[domain])]
    if not bases:
        return None
    base = pick(rng, bases)
    ctx = new_ctx(rng, style, domain, base)
    if domain == "token":
        if ctx.upgradeable:
            ctx.imp("ERC20Upgradeable", f"{OZU}/token/ERC20/ERC20Upgradeable.sol")
            ctx.inherits.insert(1, "ERC20Upgradeable")
        else:
            ctx.imp("ERC20", f"{OZ}/token/ERC20/ERC20.sol")
            ctx.inherits.insert(0, "ERC20")
            ctx.ctor_bases.insert(0, f'ERC20("{ctx.name}", "{ctx.name[:3].upper()}")')
    elif domain == "nft":
        ctx.imp("ERC721", f"{OZ}/token/ERC721/ERC721.sol")
        ctx.inherits.insert(0, "ERC721")
        ctx.ctor_bases.insert(0, f'ERC721("{ctx.name}", "{ctx.name[:4].upper()}")')
        ctx.declare("mintPrice", "uint256 public mintPrice;")
        ctx.declare("nextId", "uint256 public nextId;")
    elif domain == "erc20_pool":
        use_safe(ctx)
        if ctx.upgradeable or base == "clone":
            ctx.declare(ctx.asset, f"IERC20 public {ctx.asset};")
        else:
            ctx.declare(ctx.asset, f"IERC20 public immutable {ctx.asset};")
            ctx.ctor_params.insert(0, f"IERC20 {ctx.asset}_")
            ctx.ctor.append(f"{ctx.asset} = {ctx.asset}_;")
    if domain in ("eth_pool", "erc20_pool"):
        ctx.declare(ctx.bal, f"mapping(address => uint256) public {ctx.bal};")

    fns: list[Fn] = []
    flaw_fn = None

    def add(f):
        if f is not None:
            fns.append(f)
        return f

    # the flaw (or its safe twin, sometimes, so the feature appears in clean code too)
    want = {flaw} if flaw else set()
    twins = [k for k in ("REENTRANCY", "UNCHECKED_ERC20", "SIG_REPLAY", "UNBOUNDED_LOOP", "UNCHECKED_CALL",
                         "PUBLIC_INTERNAL", "OPEN_GRANT", "UUPS_AUTH", "UNPROTECTED_INIT")
             if domain in FLAW_DOMAINS[k] and base in FLAW_BASES.get(k, DOMAIN_BASES[domain]) and k != flaw]
    # safe twins give decoys something to be wrong about; prefer classes whose wording is short of decoys
    for _ in range(min(len(twins), rng.choice([0, 1, 1, 2]))):
        k = BALANCE.choose(rng, twins, lambda t: t)
        twins.remove(k)
        want.add(k + "#safe")
    # upgradeable and clone bases always carry their entry points
    if ctx.upgradeable:
        want.add("UUPS_AUTH" if flaw == "UUPS_AUTH" else "UUPS_AUTH#safe")
    if base == "clone":
        want.add("UNPROTECTED_INIT" if flaw == "UNPROTECTED_INIT" else "UNPROTECTED_INIT#safe")

    if domain == "eth_pool":
        add(fn_deposit_eth(ctx, rng, track=any(w.startswith("UNBOUNDED_LOOP") for w in want)))
        if rng.random() < 0.8 or "REENTRANCY" in want:
            f = add(fn_withdraw_eth(ctx, rng, unsafe="REENTRANCY" in want))
            if "REENTRANCY" in want:
                flaw_fn = f
    elif domain == "erc20_pool":
        add(fn_deposit_erc20(ctx, rng, track=any(w.startswith("UNBOUNDED_LOOP") for w in want)))
        if rng.random() < 0.8 or "UNCHECKED_ERC20" in want:
            f = add(fn_withdraw_erc20(ctx, rng, unsafe="UNCHECKED_ERC20" in want))
            if "UNCHECKED_ERC20" in want:
                flaw_fn = f
    elif domain == "nft":
        ctx.error("WrongPayment")
        fns.append(Fn("mint", natspec(ctx, "Public mint at `mintPrice`.", False) + [
            "function mint() external payable {", "    if (msg.value != mintPrice) revert WrongPayment();",
            "    _safeMint(msg.sender, nextId++);", "}"], "user", ("self",), "the collection's supply", set()))
        ctx.taken.add("mint")
    elif domain == "token" and rng.random() < 0.4:
        fns.append(Fn("burn", ["function burn(uint256 amount) external {", "    _burn(msg.sender, amount);", "}"],
                      "user", ("self",), "the caller's own tokens", set()))
        ctx.taken.add("burn")

    for w in sorted(want):
        k, safe = w.split("#")[0], w.endswith("#safe")
        if k in ("REENTRANCY", "UNCHECKED_ERC20", "MISSING_GUARD", "TX_ORIGIN"):
            continue   # built with the user functions above, or below
        if k == "UNCHECKED_CALL":
            f = add(fn_withdraw_fees_eth(ctx, rng, unsafe=not safe))
        elif k == "SIG_REPLAY":
            f = add(fn_claim_sig(ctx, rng, unsafe=not safe))
        elif k == "UNBOUNDED_LOOP":
            f = add(fn_distribute(ctx, rng, unsafe=not safe))
        elif k == "PUBLIC_INTERNAL":
            pair = fn_helper(ctx, rng, unsafe=not safe)
            if pair is None:
                f = None
            else:
                fns.extend(pair)
                f = pair[1]
        elif k == "OPEN_GRANT":
            f = add(fn_grant(ctx, rng, unsafe=not safe))
        elif k == "UUPS_AUTH":
            f = fn_authorize_upgrade(ctx, rng, unsafe=not safe)   # appended last
        elif k == "UNPROTECTED_INIT":
            f = fn_initialize(ctx, rng, unsafe=not safe)          # placed first
        else:
            f = None
        if k == flaw:
            if f is None:
                return None
            flaw_fn = f
        if k == "UUPS_AUTH" and f is not None:
            ctx._upgrade_fn = f
        if k == "UNPROTECTED_INIT" and f is not None:
            ctx._init_fn = f

    if flaw == "TX_ORIGIN":
        flaw_fn = add(fn_origin_check(ctx, rng))
        if flaw_fn is None:
            return None

    # ordinary privileged functions
    builders = [b for b in ADMIN_BUILDERS]
    rng.shuffle(builders)
    n_admin = size + (1 if flaw == "MISSING_GUARD" else 0)
    made = []
    for b in builders:
        if len(made) >= n_admin:
            break
        f = b(ctx, rng, True)
        if f is not None:
            made.append(f)
    if flaw == "MISSING_GUARD":
        if not made:
            return None
        # rebuild one of them unguarded: drop its guard from the signature / inline check
        i = rng.randrange(len(made))
        made[i] = strip_guard(made[i])
        flaw_fn = made[i]
    fns.extend(made)
    if rng.random() < 0.15:
        add(fn_view(ctx, rng))
    if flaw and flaw_fn is None:
        return None

    # upgradeable / clone plumbing
    if ctx.upgradeable or base == "clone":
        ctx.ctor = ["_disableInitializers();"] if ctx.upgradeable else []
        ctx.ctor_params, ctx.ctor_bases = [], []
        init = getattr(ctx, "_init_fn", None) or fn_initialize(ctx, rng, unsafe=False)
        fns.insert(0, init)
        if ctx.upgradeable:
            up = getattr(ctx, "_upgrade_fn", None)
            if up is None:
                up = fn_authorize_upgrade(ctx, rng, unsafe=False)
            fns.append(up)
            if ctx.natspec:
                ctx.ctor_bases = []
    # a shorter quote: the flawed function, what it depends on, and `keep` others
    if keep is not None:
        must = set()
        if flaw_fn is not None:
            must.add(flaw_fn.name)
            if flaw_fn.kind == "helper":
                must.add("s" + flaw_fn.name[2:])          # its wrapper, _setX -> setX
            if "loop" in flaw_fn.feats:                   # the loop is unbounded because deposits grow the array
                must |= {f.name for f in fns if "push" in f.feats}
        others = [f for f in fns if f.name not in must and f.kind not in ("init", "upgrade")]
        if not ctx.upgradeable and base != "clone" and flaw is None and not others:
            return None
        chosen_others = rng.sample(others, min(keep, len(others)))
        keepn = must | {f.name for f in chosen_others}
        for f in list(chosen_others):
            if f.kind == "helper":
                keepn.add("s" + f.name[2:])
            if f.kind == "admin" and ("_" + f.name[0].lower() + f.name[1:]) in {g.name for g in fns}:
                keepn.add("_" + f.name[0].lower() + f.name[1:])
        fns = [f for f in fns if f.name in keepn or f.kind in ("init", "upgrade")]

    # stable but varied order: user functions first or admin first
    head = [f for f in fns if f.kind == "init"]
    tail = [f for f in fns if f.kind == "upgrade"]
    mid = [f for f in fns if f.kind not in ("init", "upgrade")]
    if rng.random() < 0.5:
        mid.sort(key=lambda f: 0 if f.kind in ("user", "view") else 1)
    else:
        mid.sort(key=lambda f: 1 if f.kind in ("user", "view") else 0)
    # keep a helper right after its wrapper
    ordered = []
    for f in mid:
        if f.kind == "helper":
            continue
        ordered.append(f)
        for h in mid:
            if h.kind == "helper" and h.name == "_" + f.name[0].lower() + f.name[1:]:
                ordered.append(h)
    ctx.fns = head + ordered + tail
    if ctx.upgradeable:
        ctx.ctor_params = []
    return Built(ctx, flaw, flaw_fn, excerpt)


def is_inline(f: Fn) -> bool:
    return any(ln.strip().startswith("if (msg.sender != ") for ln in f.lines)


def strip_guard(f: Fn) -> Fn:
    lines = []
    for ln in f.lines:
        if f.guard and ln.startswith("function ") and (" " + f.guard) in ln:
            ln = ln.replace(" " + f.guard, "", 1)
        elif ln.strip().startswith("if (msg.sender != ") and "revert" in ln:
            continue
        lines.append(ln)
    return Fn(f.name, lines, f.kind, ("anyone",), f.effect, f.feats - {"guarded"}, None, f.grants)


# ---------------------------------------------------------------------------
# findings: one wording per class and style, shared by true findings and decoys
# ---------------------------------------------------------------------------

SEVERITY = {"MISSING_GUARD": "High", "PUBLIC_INTERNAL": "High", "UNPROTECTED_INIT": "Critical", "UUPS_AUTH": "Critical",
            "TX_ORIGIN": "High", "OPEN_GRANT": "Critical", "REENTRANCY": "High", "UNCHECKED_ERC20": "Medium",
            "SIG_REPLAY": "High", "UNBOUNDED_LOOP": "Medium", "UNCHECKED_CALL": "Medium"}


def rec_guard(ctx: Ctx, f: Fn) -> str:
    if f.guard:
        return f.guard
    if f.kind == "upgrade":
        return "onlyOwner" if ctx.base == "upg_ownable" else "onlyRole(UPGRADER_ROLE)"
    if f.kind == "grant":
        return guard_for(ctx, None)   # the role admin grants roles
    return guard_for(ctx, 1) if ctx.role_based else ctx.default_guard()


def finding_parts(style: str, cls: str, ctx: Ctx, f: Fn) -> dict:
    c, n, eff = ctx.name, f.name, f.effect
    g = rec_guard(ctx, f)
    adm = f"the {ctx.adm_word()}"
    perm = f.grants or (ctx.roles[1] if ctx.role_based else "operators")
    b, a, arr = ctx.bal, ctx.asset, ctx.arr
    if style == "train":
        t = {
            "MISSING_GUARD": (f"Missing access control on `{n}`",
                              f"`{n}` is external and has no access-control modifier or caller check, so any account can call it and change {eff}.",
                              f"Restrict `{n}` with `{g}`, as the other privileged functions are."),
            "PUBLIC_INTERNAL": (f"Helper `{n}` is publicly callable",
                                f"`{n}` is declared `public` and has no caller check, so anyone can skip the guarded entry point and change {eff} directly.",
                                f"Declare `{n}` `internal` so it is reachable only through its guarded wrapper."),
            "UNPROTECTED_INIT": (f"Unprotected initializer `{n}`",
                                 f"`{n}` can be called again after deployment: nothing records that it already ran, so any account can call it and take over {eff}.",
                                 f"Let `{n}` run only once, with OpenZeppelin's `initializer` modifier or an `initialized` flag checked and set at the start."),
            "UUPS_AUTH": (f"Anyone can upgrade the proxy through `{n}`",
                          f"`{n}` has an empty body and no modifier, so the UUPS check passes for every caller and any account can call `upgradeToAndCall` and replace {eff}.",
                          f"Add `{g}` to `{n}` so only {adm} can authorise an upgrade."),
            "TX_ORIGIN": (f"Authorization through `tx.origin` in `{n}`",
                          f"`{n}` authorises the caller by comparing `tx.origin`, so a malicious contract that {adm} interacts with can call it on their behalf and take {eff}.",
                          f"Compare `msg.sender` instead of `tx.origin` in `{n}`, or use `{g}`."),
            "OPEN_GRANT": (f"Anyone can grant themselves `{perm}` through `{n}`",
                           f"`{n}` grants `{perm}` to an arbitrary account and has no caller check, so any account can give itself the permissions behind `{perm}`.",
                           f"Restrict `{n}` with `{g}` so only the role admin can grant `{perm}`."),
            "REENTRANCY": (f"Reentrancy in `{n}`",
                           f"`{n}` sends Ether to the caller before it clears their entry in `{b}`, so a receiving contract can re-enter `{n}` and be paid again.",
                           f"In `{n}`, zero `{b}[msg.sender]` before the external call (checks-effects-interactions) and add `nonReentrant`."),
            "UNCHECKED_ERC20": (f"Unchecked ERC-20 transfer in `{n}`",
                                f"`{n}` calls `transfer` on `{a}` and ignores the returned boolean, so with a token that returns false instead of reverting the books change although nothing was sent.",
                                f"Use `safeTransfer` from SafeERC20 for the transfer in `{n}`."),
            "SIG_REPLAY": (f"Signature replay in `{n}`",
                           f"The digest `{n}` verifies has no nonce and the signature is never marked as used, so the same signature can be submitted again and again.",
                           f"Include a per-account nonce, the chain id and the contract address in the digest `{n}` checks, and increment the nonce on use."),
            "UNBOUNDED_LOOP": (f"Unbounded loop in `{n}`",
                               f"`{n}` iterates over all of `{arr}`, which every new depositor grows, so its gas cost eventually exceeds the block gas limit and it can no longer run.",
                               f"Process `{arr}` in bounded batches in `{n}`, or let each account settle its own share."),
            "UNCHECKED_CALL": (f"Unchecked low-level call in `{n}`",
                               f"`{n}` sends Ether with a low-level `call` and ignores its success flag, so a failed transfer is still booked as paid and the funds are stranded.",
                               f"Check the boolean returned by the call in `{n}` and revert when it is false."),
        }[cls]
    else:
        t = {
            "MISSING_GUARD": (f"`{n}` lacks authorization",
                              f"No modifier or `msg.sender` check protects `{n}`; every external account may invoke it and alter {eff}.",
                              f"Gate `{n}` behind `{g}`."),
            "PUBLIC_INTERNAL": (f"Exposed internal function `{n}`",
                                f"Because `{n}` has `public` visibility and performs no authorization, the restriction on its wrapper is bypassable and {eff} can be overwritten by anyone.",
                                f"Change the visibility of `{n}` to `internal` or `private`."),
            "UNPROTECTED_INIT": (f"Re-initialisation of `{n}`",
                                 f"`{n}` keeps no record of having run and may be invoked repeatedly, so an attacker can call it after deployment and seize {eff}.",
                                 f"Guard `{n}` with an `initializer` modifier (or a one-time flag) so it executes exactly once."),
            "UUPS_AUTH": (f"Unauthorised upgrades via `{n}`",
                          f"The override of `{n}` is empty and carries no modifier; any caller may therefore run `upgradeToAndCall` and swap {eff}.",
                          f"Protect `{n}` with `{g}`."),
            "TX_ORIGIN": (f"`tx.origin` used for authorization in `{n}`",
                          f"`{n}` trusts `tx.origin`; a contract that {adm} is tricked into calling can invoke `{n}` and obtain {eff}.",
                          f"Authorise `{n}` on `msg.sender` (for example via `{g}`), never `tx.origin`."),
            "OPEN_GRANT": (f"Permissionless grant of `{perm}` in `{n}`",
                           f"`{n}` adds any address to `{perm}` and checks nothing about the caller, so an attacker can grant themselves `{perm}`.",
                           f"Only the role admin should reach `{n}`: add `{g}`."),
            "REENTRANCY": (f"Re-entrant withdrawal in `{n}`",
                           f"`{n}` pays the caller through an external call while `{b}[msg.sender]` is still unchanged; a contract recipient can call back into `{n}` and drain funds.",
                           f"Update `{b}` before the call in `{n}` and protect it with a reentrancy guard."),
            "UNCHECKED_ERC20": (f"Ignored return value of `{a}.transfer` in `{n}`",
                                f"The boolean returned by `{a}.transfer` in `{n}` is discarded; tokens that signal failure by returning false leave balances debited with no tokens moved.",
                                f"Replace the call in `{n}` with SafeERC20's `safeTransfer`."),
            "SIG_REPLAY": (f"Replayable signature in `{n}`",
                           f"Nothing in `{n}` binds a signature to a single use (no nonce, no used-digest record), so one valid signature can be redeemed repeatedly.",
                           f"Add a nonce plus chain id and contract address to the signed data in `{n}` and consume the nonce."),
            "UNBOUNDED_LOOP": (f"Gas-limit DoS in `{n}`",
                               f"`{n}` walks the whole `{arr}` array, which grows with every new depositor; past some size the call runs out of gas permanently.",
                               f"Iterate `{arr}` in `{n}` in bounded ranges, or switch to per-account accounting."),
            "UNCHECKED_CALL": (f"Unchecked Ether transfer in `{n}`",
                               f"The low-level `call` in `{n}` returns a success flag that is never inspected; if the transfer fails the fees are written off regardless.",
                               f"Require the call in `{n}` to succeed."),
        }[cls]
    return {"title": t[0], "desc": t[1], "rec": t[2], "sev": SEVERITY[cls], "fn": n, "c": c}


def guard_list(ctx: Ctx, limit: int = 4) -> str:
    items = []
    for f in ctx.fns:
        if f.guard and f.kind != "upgrade":
            g = f"a `msg.sender` check against `{ctx.admin_var}`" if is_inline(f) else f"`{f.guard}`"
            items.append(f"`{f.name}` ({g})")
    upg = [f for f in ctx.fns if f.kind == "upgrade" and f.guard]
    if upg:
        items.insert(0, f"`_authorizeUpgrade` (`{upg[0].guard}`)")
    return ", ".join(items[:limit]) if items else "none"


def feature_notes(style: str, ctx: Ctx) -> list:
    """Things a clean review would say about the code, from which features it has (not whether they are safe)."""
    feats = set().union(*[f.feats for f in ctx.fns]) if ctx.fns else set()
    kinds = {f.kind for f in ctx.fns}
    notes = []
    tr = style == "train"
    if "eth_out" in feats:
        notes.append("Ether is sent only after the books are updated and every call's result is checked" if tr
                     else "native transfers follow checks-effects-interactions and their success is enforced")
    if "erc20_out" in feats:
        notes.append("token transfers go through SafeERC20" if tr else "ERC-20 transfers use the Safe wrappers")
    if "sig" in feats:
        notes.append("signatures are bound to a nonce, so they cannot be replayed" if tr
                     else "each signature is single-use thanks to the nonce")
    if "loop" in feats:
        notes.append("the reward loop works on a caller-bounded range" if tr else "the loop is bounded by its arguments")
    if "init" in kinds:
        notes.append("`initialize` can run only once" if tr else "initialisation is one-shot")
    if "helper" in kinds:
        notes.append("the helper behind the setter is internal" if tr else "internal helpers are not externally reachable")
    if "grant" in kinds:
        notes.append("granting permissions is restricted" if tr else "permission grants require the admin")
    return notes


def nofinding_parts(style: str, scope: str, ctx: Ctx) -> dict:
    users = [f"`{f.name}`" for f in ctx.fns if f.kind == "user"]
    notes = feature_notes(style, ctx)
    gl = guard_list(ctx)
    if style == "train":
        if scope == "ac":
            head = f"No access-control issue in `{ctx.name}`"
            body = (f"Every privileged function is restricted: {gl}." if gl != "none"
                    else "The functions shown hold no privileged action that an outsider could reach.")
        else:
            head = f"No high- or medium-severity issue in `{ctx.name}`"
            body = (f"The privileged functions are restricted ({gl})." if gl != "none"
                    else "No function shown performs a privileged action.")
        if users:
            body += f" {' and '.join(users[:2])} {'are' if len(users[:2]) > 1 else 'is'} open by design and only act{'' if len(users[:2]) > 1 else 's'} for the caller."
        if notes:
            body += " " + cap1("; ".join(notes[:2])) + "."
    else:
        head = f"No findings in scope for {ctx.name}" if scope == "ac" else f"{ctx.name} looks sound"
        body = f"Authorization is enforced on {gl}." if gl != "none" else "Nothing shown requires authorization."
        if users:
            body += f" User entry points ({', '.join(users[:2])}) only touch the caller's own position."
        if notes:
            body += " Also, " + "; ".join(notes[:2]) + "."
    return {"head": head, "body": body}


# -- renderers. A pair's two answers always share one renderer.

def render_finding(style: str, r: int, p: dict) -> str:
    if style == "train":
        if r == 0:
            return (f"**[{p['sev'][0]}-01] {p['title']}**\n\n**Severity:** {p['sev']}\n**Location:** `{p['c']}.{p['fn']}`\n\n"
                    f"{p['desc']}\n\n**Recommendation:** {p['rec']}")
        if r == 1:
            return f"{p['title']} ({p['sev']}, `{p['c']}`). {p['desc']} Recommendation: {p['rec']}"
        if r == 2:
            return (f"- Issue: {p['title']}\n- Severity: {p['sev']}\n- Location: `{p['c']}.{p['fn']}`\n- Details: {p['desc']}\n"
                    f"- Fix: {p['rec']}")
        return f"{p['sev']} ({p['c']}): {p['desc']} Fix: {p['rec']}"
    if r == 0:
        return (f"## {p['title']}\nRisk: {p['sev']}\nAffected: {p['c']}::{p['fn']}()\n\nSummary: {p['desc']}\n"
                f"Mitigation: {p['rec']}")
    if r == 1:
        return json.dumps({"title": p["title"], "severity": p["sev"].lower(), "contract": p["c"], "function": p["fn"],
                           "description": p["desc"], "recommendation": p["rec"]})
    return f"1. [{p['sev'].upper()}] {p['title']} ({p['c']})\n   {p['desc']}\n   -> {p['rec']}"


def render_nofinding(style: str, r: int, p: dict) -> str:
    if style == "train":
        if r == 0:
            return f"**{p['head']}.**\n\n{p['body']}"
        if r == 1:
            return f"{p['head']}. {p['body']}"
        if r == 2:
            return f"- Result: {p['head']}\n- Details: {p['body']}"
        return f"{p['head']}: {p['body']}"
    if r == 0:
        return f"## {p['head']}\n\n{p['body']}"
    if r == 1:
        return json.dumps({"title": p["head"], "severity": "none", "function": None, "description": p["body"],
                           "recommendation": None})
    return f"1. [NONE] {p['head']}\n   {p['body']}"


N_RENDER = {"train": 4, "test": 3}


# ---------------------------------------------------------------------------
# decoys
# ---------------------------------------------------------------------------

def plausible(f: Fn) -> list:
    """Classes an auditor might wrongly claim for this function."""
    out = []
    if f.kind in ("admin", "grant") and "guarded" in f.feats:
        out += ["MISSING_GUARD", "TX_ORIGIN"]
    if f.kind == "user":
        out += ["MISSING_GUARD"]
    if f.kind == "grant":
        out += ["OPEN_GRANT"]
    if f.kind == "helper":
        out += ["PUBLIC_INTERNAL"]
    if f.kind == "init":
        out += ["UNPROTECTED_INIT"]
    if f.kind == "upgrade":
        out += ["UUPS_AUTH"]
    if "eth_out" in f.feats:
        out += ["REENTRANCY", "UNCHECKED_CALL"]
    if "erc20_out" in f.feats:
        out += ["UNCHECKED_ERC20", "REENTRANCY"]
    if "sig" in f.feats:
        out += ["SIG_REPLAY"]
    if "loop" in f.feats:
        out += ["UNBOUNDED_LOOP"]
    return out


def is_true(b: Built, cls: str, f: Fn) -> bool:
    """Whether claiming `cls` for `f` would be right (or overlap the real finding)."""
    if b.flaw is None or b.flaw_fn is None:
        return False
    if f.name != b.flaw_fn.name:
        return False
    if cls == b.flaw:
        return True
    return (cls in AC_FAMILY) == (b.flaw in AC_FAMILY)   # same family on the same function: too close to call


def decoys(b: Built) -> list:
    out = []
    for f in b.ctx.fns:
        for cls in plausible(f):
            if not is_true(b, cls, f):
                out.append((cls, f))
    if b.flaw_fn is not None:
        fam = VULN_FAMILY if b.flaw in AC_FAMILY else AC_FAMILY
        for cls in plausible(b.flaw_fn):
            if cls in fam and not is_true(b, cls, b.flaw_fn):
                out.append((cls, b.flaw_fn))
    uniq = {}
    for cls, f in out:
        uniq.setdefault((cls, f.name), (cls, f))
    return list(uniq.values())


# How often each class is the true one (the same weights drive decoy choice, so a class's wording appears in
# chosen and rejected answers about equally often).
CLASS_W = {"MISSING_GUARD": 0.30, "PUBLIC_INTERNAL": 0.08, "UNPROTECTED_INIT": 0.07, "UUPS_AUTH": 0.07,
           "TX_ORIGIN": 0.07, "OPEN_GRANT": 0.09, "REENTRANCY": 0.08, "UNCHECKED_ERC20": 0.06, "SIG_REPLAY": 0.07,
           "UNBOUNDED_LOOP": 0.05, "UNCHECKED_CALL": 0.06}
AC_W = {k: v for k, v in CLASS_W.items() if k in AC_FAMILY}


class Balancer:
    """Keeps every answer kind (a finding class, "no issue", a who-can-call kind) about as frequent among
    rejected answers as among chosen ones, so no wording tells the two apart. Decoys are drawn with weights
    that grow with how far a kind's rejected count lags its chosen count."""

    def __init__(self):
        self.cho: dict = {}
        self.rej: dict = {}

    def weight(self, key: str) -> float:
        gap = self.cho.get(key, 0) - self.rej.get(key, 0)
        return math.exp(max(-4.0, min(4.0, 0.15 * gap)))

    def choose(self, rng, cands: list, key_of):
        if not cands:
            return None
        # spread a kind's weight over its candidates, so a kind with many candidates is not favoured
        per = {}
        for c in cands:
            per[key_of(c)] = per.get(key_of(c), 0) + 1
        w = [self.weight(key_of(c)) / per[key_of(c)] for c in cands]
        return rng.choices(cands, weights=w)[0]

    def choose_truth(self, rng, cands: list, key_of):
        """The mirror image: prefer a true answer of a kind that is short among chosen answers."""
        per = {}
        for c in cands:
            per[key_of(c)] = per.get(key_of(c), 0) + 1
        w = [1.0 / self.weight(key_of(c)) / per[key_of(c)] for c in cands]
        return rng.choices(cands, weights=w)[0]

    def record(self, chosen_key: str, rejected_key: str):
        self.cho[chosen_key] = self.cho.get(chosen_key, 0) + 1
        self.rej[rejected_key] = self.rej.get(rejected_key, 0) + 1


BALANCE = Balancer()


def nofinding_key(ctx: Ctx) -> str:
    return "NOFINDING" if guard_list(ctx) != "none" else "NOFINDING_EMPTY"


def pick_decoy(rng, b: Built, prefer_ac: bool, allow_nofinding: bool = False, prefix: str = ""):
    ds = decoys(b)
    if prefer_ac:
        ac = [d for d in ds if d[0] in AC_FAMILY]
        ds = ac or ds
    if allow_nofinding:
        ds = ds + [(nofinding_key(b.ctx), None)]
    return BALANCE.choose(rng, ds, lambda d: prefix + d[0])


# ---------------------------------------------------------------------------
# tasks
# ---------------------------------------------------------------------------

Q = {
    "train": {
        "ac": [
            "Review `{c}` for access-control vulnerabilities. Report the most serious finding with its severity, location and a recommendation, or state that there is none.",
            "You are auditing the contract below. Focus on access control: can an unauthorised account reach any privileged function?",
            "Perform an access-control review of this contract and describe the issue you find, if any.",
            "Identify any missing or broken authorization in the following Solidity code.",
            "Check every privileged function of `{c}` for a missing or bypassable caller restriction.",
        ],
        "general": [
            "Audit the following contract and report the highest-severity vulnerability, or state that there is none.",
            "Security review: what is the most important issue in `{c}`, and how should it be fixed?",
            "Find the vulnerability in this production contract, explain its impact and recommend a fix.",
            "Review the code below as a smart-contract auditor. What is your main finding?",
        ],
        "who": [
            "Who can call `{f}` in `{c}`? Explain what enforces it.",
            "Which accounts are authorised to execute `{f}`?",
            "Access-control question: what restricts the callers of `{c}.{f}`?",
        ],
        "fix": [
            "`{c}` contains one vulnerability. What change fixes it?",
            "What is the correct remediation for the issue in `{c}`?",
            "Recommend the fix for the security issue in the contract below.",
        ],
    },
    "test": {
        "ac": [
            "Is there any way for a non-privileged user to perform an admin action in this contract? Explain.",
            "Assess the authorization model of `{c}` and list the most severe access-control weakness.",
            "As an auditor, verify the role and ownership checks below. Anything wrong?",
        ],
        "general": [
            "Give your top finding for this contract (or confirm it is clean).",
            "Spot the bug: review `{c}` and describe the most severe vulnerability.",
            "What would you flag in an audit report for the following code?",
        ],
        "who": [
            "Under what conditions can `{f}` be executed successfully, and by whom?",
            "Describe the permission required to invoke `{c}.{f}`.",
        ],
        "fix": [
            "Propose a patch for the vulnerability in this contract.",
            "How should the developers of `{c}` remediate the flaw in this code?",
        ],
    },
}


def frame(rng, style: str, q: str, src: str, b: Built) -> str:
    excerpt = b.excerpt
    if style == "train":
        intro = ""
        if excerpt and rng.random() < 0.6:
            intro = f"The following is an excerpt of `{b.ctx.name}`, deployed in production.\n\n"
        if rng.random() < 0.75:
            return f"{intro}{q}\n\n```solidity\n{src}\n```"
        return f"{intro}```solidity\n{src}\n```\n\n{q}"
    intro = "Excerpt from a deployed contract:\n" if excerpt else "Contract:\n"
    return f"{intro}```solidity\n{src}\n```\nQuestion: {q}"


def who_text(style: str, ctx: Ctx, f: Fn, who: tuple) -> str:
    n = f"{ctx.name}.{f.name}"
    if style == "train":
        if who[0] == "owner":
            g = ctx.default_guard() if not ctx.role_based else "onlyOwner"
            w = ctx.adm_word() if not ctx.role_based else "owner"
            if ctx.base in ("custom", "clone") and ctx.inline_checks:
                return f"Only the {w}: `{n}` reverts unless `msg.sender` is `{ctx.admin_var}`, so every other caller fails."
            return f"Only the {w}: `{n}` is guarded by `{g}`, which reverts for every other caller."
        if who[0] == "role":
            return (f"Only accounts holding `{who[1]}`: `onlyRole({who[1]})` on `{n}` reverts for everyone else, and the role "
                    f"is granted by its admin role.")
        if who[0] == "anyone":
            return f"Any account: `{n}` has no modifier or caller check, so nothing restricts who calls it."
        return f"Any account, but `{n}` only acts on the caller's own position, so it needs no restriction."
    if who[0] == "owner":
        w = ctx.adm_word() if not ctx.role_based else "owner"
        return f"Restricted to the {w} address (enforced in `{n}` via the ownership check)."
    if who[0] == "role":
        return f"Callers must have been granted `{who[1]}`; all other calls to `{n}` revert."
    if who[0] == "anyone":
        return f"Unrestricted: `{n}` is callable by every address since no authorization is performed."
    return f"Anyone may call `{n}`; it is scoped to `msg.sender`'s own funds, which is intended."


def task_review(rng, style: str, scope: str):
    """scope 'ac': access-control review; 'general': most severe finding."""
    clean = rng.random() < 1 / 3
    if clean:
        flaw = None
    else:
        ws = AC_W if scope == "ac" else CLASS_W
        flaw = rng.choices(list(ws), weights=list(ws.values()))[0]
    b = build(rng, style, flaw, **shape(rng))
    if b is None:
        return None
    ctx = b.ctx
    r = rng.randrange(N_RENDER[style])
    nof = render_nofinding(style, r, nofinding_parts(style, scope, ctx))
    if clean:
        d = pick_decoy(rng, b, prefer_ac=(scope == "ac"))
        if d is None:
            return None
        chosen, rejected = nof, render_finding(style, r, finding_parts(style, d[0], ctx, d[1]))
        bal = (nofinding_key(ctx), d[0])
    else:
        chosen = render_finding(style, r, finding_parts(style, flaw, ctx, b.flaw_fn))
        d = pick_decoy(rng, b, prefer_ac=(scope == "ac"), allow_nofinding=True)
        if d is None:
            return None
        rejected = nof if d[0].startswith("NOFINDING") else render_finding(style, r, finding_parts(style, d[0], ctx, d[1]))
        bal = (flaw, d[0])
    q = pick(rng, Q[style][scope]).format(c=ctx.name)
    return {"prompt": frame(rng, style, q, ctx.source(b.excerpt), b), "chosen": chosen, "rejected": rejected,
            "task": f"{scope}_review", "flaw": flaw or "none", "bal": bal}


def task_who(rng, style: str):
    flaw = rng.choice([None, None, "MISSING_GUARD", "MISSING_GUARD", "OPEN_GRANT", "PUBLIC_INTERNAL"])
    b = build(rng, style, flaw, **shape(rng))
    if b is None:
        return None
    ctx = b.ctx
    cands = [f for f in ctx.fns if f.who[0] in ("owner", "role", "anyone", "self") and f.kind not in ("upgrade",)]
    if b.flaw_fn is not None and rng.random() < 0.3:
        cands = [b.flaw_fn]
    cands = [f for f in cands if f.kind != "init" and not (f.kind == "helper" and f.who[0] != "anyone")]
    if not cands:
        return None
    f = BALANCE.choose_truth(rng, cands, lambda g: "WHO_" + g.who[0])
    roles_here = sorted({g.who[1] for g in ctx.fns if g.who[0] == "role"} | set(ctx.roles if ctx.role_based else []))
    options = [("owner",), ("anyone",)] + [("role", rr) for rr in roles_here]
    if f.kind == "user" or (f.kind in ("admin", "grant") and f.who[0] in ("owner", "role")):
        options.append(("self",))
    wrong = [o for o in options if o != f.who and not (f.who[0] == "self" and o[0] == "anyone")
             and not (f.who[0] == "anyone" and o[0] == "self")]
    if ctx.role_based:
        wrong = [o for o in wrong if o[0] != "owner"] or wrong
    w = BALANCE.choose(rng, wrong, lambda o: "WHO_" + o[0])
    if w is None:
        return None
    bal = ("WHO_" + f.who[0], "WHO_" + w[0])
    q = pick(rng, Q[style]["who"]).format(c=ctx.name, f=f.name)
    return {"prompt": frame(rng, style, q, ctx.source(b.excerpt), b), "chosen": who_text(style, ctx, f, f.who),
            "rejected": who_text(style, ctx, f, w), "task": "who_can_call", "flaw": flaw or "none", "bal": bal}


def fix_text(style: str, r: int, p: dict) -> str:
    if style == "train":
        if r % 2 == 0:
            return f"{p['rec']} This removes the issue in `{p['c']}`: {p['title'][0].lower() + p['title'][1:]} ({p['sev']})."
        return f"Fix for `{p['c']}` ({p['sev']}, {p['title']}): {p['rec']}"
    return f"Patch for {p['c']}: {p['rec']} (addresses: {p['title']})"


def task_fix(rng, style: str):
    flaw = rng.choices(list(CLASS_W), weights=list(CLASS_W.values()))[0]
    b = build(rng, style, flaw, **shape(rng))
    if b is None:
        return None
    d = pick_decoy(rng, b, prefer_ac=False, prefix="FIX_")
    if d is None:
        return None
    bal = ("FIX_" + flaw, "FIX_" + d[0])
    r = rng.randrange(2)
    chosen = fix_text(style, r, finding_parts(style, flaw, b.ctx, b.flaw_fn))
    rejected = fix_text(style, r, finding_parts(style, d[0], b.ctx, d[1]))
    q = pick(rng, Q[style]["fix"]).format(c=b.ctx.name)
    return {"prompt": frame(rng, style, q, b.ctx.source(b.excerpt), b), "chosen": chosen, "rejected": rejected,
            "task": "fix", "flaw": flaw, "bal": bal}


SIZE = [0, 0, 1, 1, 1, 2, 2, 3]


def shape(rng) -> dict:
    """How much of a contract a prompt quotes: whole files, excerpts and short fragments."""
    level = rng.choices([0, 1, 2], weights=[0.35, 0.35, 0.30])[0]
    keep = None if level == 0 else rng.choice([0, 1, 1, 2, 2, 3, None])
    return {"size": rng.choice(SIZE), "excerpt": level, "keep": keep}


# ---------------------------------------------------------------------------
# lengths
# ---------------------------------------------------------------------------

class Measure:
    def __init__(self, tokenizer_path: str | None):
        self.tok = None
        if tokenizer_path:
            from tokenizers import Tokenizer  # the node's pinned tokenizer.json
            self.tok = Tokenizer.from_file(tokenizer_path)

    def tokens(self, prompt: str, answer: str) -> int:
        text = f"### Task:\n{prompt}\n\n### Answer:\n{answer}"
        if self.tok is None:
            return int(len(text) / 3.0) + 2
        return len(self.tok.encode(text).ids)


# Target distribution of the longer text of a pair, in tokens (the node's real inputs ran 76-512, most 250-450).
BANDS = [((90, 250), 0.22), ((250, 380), 0.38), ((380, 460), 0.25), ((460, 512), 0.15)]


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--out", required=True)
    ap.add_argument("--n", type=int, default=2200)
    ap.add_argument("--seed", type=int, default=21)
    ap.add_argument("--style", choices=["train", "test"], default="train")
    ap.add_argument("--tokenizer", help="the node's pinned tokenizer.json, to measure lengths exactly")
    ap.add_argument("--v1-share", type=float, default=0.10, help="share of rows from the v1 generator (train style only)")
    ap.add_argument("--exclude", action="append", default=[], help="JSONL whose prompts must not reappear")
    args = ap.parse_args()

    rng = random.Random(args.seed)
    _HASH_RNG.seed(args.seed * 7919 + 1)
    meas = Measure(args.tokenizer)
    seen = set()
    for path in args.exclude:
        with open(path, encoding="utf-8") as fh:
            seen |= {json.loads(l)["prompt"] for l in fh if l.strip()}

    v1 = None
    if args.style == "train" and args.v1_share > 0:
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        import generate_pairs as v1  # noqa: E402

    tasks = [(lambda: task_review(rng, args.style, "ac"), 0.34), (lambda: task_review(rng, args.style, "general"), 0.22),
             (lambda: task_who(rng, args.style), 0.16), (lambda: task_fix(rng, args.style), 0.16)]
    v1_tasks = None
    if v1 is not None:
        v1_tasks = [(v1.task_access, 0.45), (v1.task_swc, 0.25), (v1.task_count, 0.15), (v1.task_fix, 0.15)]

    rows, tries = [], 0
    band_n = {b: 0 for b, _ in BANDS}
    while len(rows) < args.n and tries < args.n * 200:
        tries += 1
        if v1_tasks and rng.random() < args.v1_share:
            t = rng.choices([t for t, _ in v1_tasks], weights=[w for _, w in v1_tasks])[0]
            row = t(rng)
            if row:
                row = dict(row, task="v1_" + row["task"], flaw="v1")
        else:
            t = rng.choices([t for t, _ in tasks], weights=[w for _, w in tasks])[0]
            row = t()
        if not row or row["prompt"] in seen or row["chosen"] == row["rejected"]:
            continue
        tl = max(meas.tokens(row["prompt"], row["chosen"]), meas.tokens(row["prompt"], row["rejected"]))
        if tl > NODE_MAX_TOKENS:
            continue   # the answer would be cut off: both texts identical to the model, no preference
        band = next((b for b, _ in BANDS if b[0] <= tl <= b[1]), None)
        if band is None:
            continue
        quota = dict(BANDS)[band] * args.n
        if band_n[band] >= quota + 1:
            continue
        band_n[band] += 1
        if "bal" in row:
            BALANCE.record(*row["bal"])
        row["tokens"] = tl
        seen.add(row["prompt"])
        rows.append(row)
    rng.shuffle(rows)
    with open(args.out, "w", encoding="utf-8") as fh:
        for r in rows:
            fh.write(json.dumps({"prompt": r["prompt"], "chosen": r["chosen"], "rejected": r["rejected"],
                                 "label_kind": "preference_pair"}) + "\n")
    stats = {"pairs": len(rows), "tries": tries, "style": args.style, "measured_with": "tokenizer" if meas.tok else "chars",
             "by_task": {}, "by_flaw": {}, "bands": {f"{a}-{b}": n for (a, b), n in band_n.items()}}
    for r in rows:
        stats["by_task"][r["task"]] = stats["by_task"].get(r["task"], 0) + 1
        stats["by_flaw"][r["flaw"]] = stats["by_flaw"].get(r["flaw"], 0) + 1
    print(json.dumps(stats))


if __name__ == "__main__":
    main()
