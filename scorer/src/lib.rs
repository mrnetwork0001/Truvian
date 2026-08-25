//! Truvian v2 — Telegraph Protocol scoring module for the ONCHAIN_TX_LOOKUP intent.
//!
//! Contract (C ABI, wasm32-unknown-unknown, zero imports):
//!   alloc(size: i32) -> i32
//!   dealloc(ptr: i32, size: i32)
//!   rank_answer(q_ptr, q_len, gt_ptr, gt_len, ma_ptr, ma_len) -> f32 in [0,1]
//!
//! v2 strategy (post-rejection iteration):
//!   1. Typed on-chain fact recall (tx hashes, addresses, ints/wei, decimals,
//!      tx status) — unchanged core idea, now with partial hex-prefix credit.
//!   2. NEGATION-AWARE lexing: a strong negator ("not", "never", "didn't",
//!      "wasn't", "without", "rather"/"instead", sentence punctuation resets)
//!      opens a 3-content-token window that flips polarity words and flags
//!      similarity tokens as negated, so "was never included" stops matching
//!      "included" and "did not succeed" reads as failure.
//!   3. POLARITY GROUPS with contradiction penalties: tx status
//!      (succeed/confirm/mined vs fail/revert/rejected), direction
//!      (rise/climb vs fall/drop), win/lose, leading Yes/No — including
//!      Chinese substring forms (成功/失败, 上涨/下跌) with 未/没/不 flips.
//!      A wrong conclusion wrapped around the right numbers gets multiplied
//!      down hard.
//!   4. NEAR-MISS detection: an unmatched ground-truth integer whose answer
//!      contains a same-length, few-digits-off value (block off by one, wei
//!      last digit wrong) is an active wrong assertion, penalized beyond the
//!      lost recall. Same for corrupted hex sharing a long prefix, and for
//!      swapped from/to address pairs.
//!   5. Much stronger text fallback: stopword-weighted unigram F1 (with a
//!      6-char canonical prefix stemmer) + bigram Dice, replacing plain Dice.
//!   6. CONTRAST transform: smooth monotone s^2/(s^2+(1-s)^2) pushes good
//!      answers toward 1 and bad answers toward 0, widening the good-bad
//!      margin without ever reordering scores.
//!
//! Hard invariants: empty/whitespace answer == 0.0 exactly; verbatim
//! (trimmed) match == 1.0 exactly (=> Stage-2 self-match 1.0); all other
//! scores in [0, 0.995]; fully deterministic (Vec + sort only, no hash maps,
//! no randomness, no time, no I/O, zero WASM imports).

use std::alloc::{alloc as raw_alloc, dealloc as raw_dealloc, Layout};

mod embed;
mod math;
mod tokenizer;

/// MiniLM-L6-v2 INT8 semantic cosine between two texts, in [0,1].
/// Deterministic: INT8 weights + pure-Rust libm float math, no host calls.
fn semantic_cosine(a: &str, b: &str) -> f32 {
    let ea = embed::run(&tokenizer::tokenize(a));
    let eb = embed::run(&tokenizer::tokenize(b));
    math::cosine(&ea, &eb)
}

// ---------------------------------------------------------------------------
// Host memory contract
// ---------------------------------------------------------------------------

/// Allocate `size` bytes and return the pointer. The host (wazero) writes the
/// UTF-8 input strings here before calling `rank_answer`.
#[no_mangle]
pub extern "C" fn alloc(size: i32) -> i32 {
    let size = if size <= 0 { 1 } else { size as usize };
    let layout = match Layout::from_size_align(size, 1) {
        Ok(l) => l,
        Err(_) => return 0,
    };
    unsafe { raw_alloc(layout) as i32 }
}

/// Free a buffer previously returned by `alloc`.
#[no_mangle]
pub extern "C" fn dealloc(ptr: i32, size: i32) {
    if ptr == 0 || size <= 0 {
        return;
    }
    if let Ok(layout) = Layout::from_size_align(size as usize, 1) {
        unsafe { raw_dealloc(ptr as *mut u8, layout) };
    }
}

/// Read a (ptr,len) pair from linear memory as a UTF-8 string (lossy on
/// invalid bytes — never traps on malformed input).
unsafe fn read_str(ptr: i32, len: i32) -> String {
    if ptr == 0 || len <= 0 {
        return String::new();
    }
    let slice = unsafe { core::slice::from_raw_parts(ptr as *const u8, len as usize) };
    String::from_utf8_lossy(slice).into_owned()
}

// ---------------------------------------------------------------------------
// Word lists (linear scans — small, deterministic)
// ---------------------------------------------------------------------------

const STOPWORDS: &[&str] = &[
    "a", "an", "the", "is", "are", "was", "were", "be", "been", "being", "of",
    "in", "on", "at", "to", "from", "by", "for", "with", "and", "or", "it",
    "its", "this", "that", "these", "those", "as", "has", "have", "had",
    "does", "do", "did", "but", "if", "then", "than", "so", "such", "there",
    "here", "what", "which", "who", "whom", "when", "where", "why", "how",
    "all", "any", "both", "each", "into", "about", "over", "under", "again",
    "he", "she", "they", "them", "his", "her", "their", "we", "you", "your",
    "i", "me", "my", "am", "will", "would", "can", "could", "should", "shall",
    "may", "might", "must", "also", "just", "very", "per", "via",
];

const ZH_STOP: &[char] = &['的', '了', '在', '是', '于', '该', '和', '与', '为'];

/// Strong negators: counted for asymmetry AND open the flip window.
const NEG_STRONG: &[&str] = &[
    "not", "never", "cannot", "cant", "dont", "doesnt", "didnt", "isnt",
    "wasnt", "arent", "werent", "hasnt", "havent", "hadnt", "wont",
    "couldnt", "wouldnt", "shouldnt", "without", "none", "neither", "nor",
];

/// Weak negators: open the flip window only (not counted for asymmetry).
const NEG_WEAK: &[&str] = &["no", "rather", "instead", "unable"];

// Polarity groups: 0 = tx status, 1 = up/down direction, 2 = win/lose,
// 3 = leading yes/no. Bit 1 = positive asserted, bit 2 = negative asserted.
const NGROUPS: usize = 4;
const G_STATUS: usize = 0;
const G_UPDOWN: usize = 1;
const G_WINLOSE: usize = 2;
const G_YESNO: usize = 3;

const STATUS_POS: &[&str] = &[
    "succeed", "succeeds", "succeeded", "succeeding", "success", "successful",
    "successfully", "confirmed", "executed", "completed", "mined", "included",
    "landed", "found", "exists", "exist",
];
const STATUS_NEG: &[&str] = &[
    "fail", "fails", "failed", "failing", "failure", "unsuccessful",
    "unsuccessfully", "revert", "reverts", "reverted", "reverting",
    "rejected", "invalid", "bounced", "bounce",
];
const UPDOWN_POS: &[&str] = &[
    "increase", "increases", "increased", "increasing", "rise", "rises",
    "rose", "risen", "rising", "climb", "climbs", "climbed", "climbing",
    "gain", "gains", "gained", "surge", "surged", "jump", "jumps", "jumped",
    "rally", "rallied", "grew", "grow", "grows", "growing", "up", "higher",
    "appreciated", "raise", "raises", "raised", "raising",
];
const UPDOWN_NEG: &[&str] = &[
    "decrease", "decreases", "decreased", "decreasing", "fall", "falls",
    "fell", "fallen", "falling", "drop", "drops", "dropped", "dropping",
    "decline", "declines", "declined", "declining", "dip", "dips", "dipped",
    "plunge", "plunged", "sank", "sink", "slumped", "slid", "down", "lower",
    "depreciated", "shrank", "lowers", "lowered", "lowering",
];
const WINLOSE_POS: &[&str] = &["won", "win", "wins", "winning", "victory", "victorious", "beat"];
const WINLOSE_NEG: &[&str] = &["lost", "lose", "loses", "losing"];

/// Chinese polarity substrings: (pattern, group, positive).
const ZH_POLARITY: &[(&str, usize, bool)] = &[
    ("成功", G_STATUS, true),
    ("上链", G_STATUS, true),
    ("失败", G_STATUS, false),
    ("失敗", G_STATUS, false),
    ("回滚", G_STATUS, false),
    ("上涨", G_UPDOWN, true),
    ("上漲", G_UPDOWN, true),
    ("上升", G_UPDOWN, true),
    ("下跌", G_UPDOWN, false),
    ("下降", G_UPDOWN, false),
];
const ZH_NEGATORS: &[char] = &['未', '没', '沒', '不', '无', '無', '别', '別'];

/// Common number words normalize to digit strings, so "two" matches "2",
/// word-form scores become typed facts, and quantifier words stop consuming
/// the negation window ("rather than one central party").
fn word_number(w: &str) -> Option<&'static str> {
    Some(match w {
        "zero" => "0", "one" => "1", "two" => "2", "three" => "3",
        "four" => "4", "five" => "5", "six" => "6", "seven" => "7",
        "eight" => "8", "nine" => "9", "ten" => "10", "eleven" => "11",
        "twelve" => "12", "thirteen" => "13", "fourteen" => "14",
        "fifteen" => "15", "sixteen" => "16", "seventeen" => "17",
        "eighteen" => "18", "nineteen" => "19", "twenty" => "20",
        "trio" => "3", "couple" => "2", "pair" => "2", "dozen" => "12",
        _ => return None,
    })
}

fn in_list(list: &[&str], w: &str) -> bool {
    list.iter().any(|x| *x == w)
}

fn polarity_word(w: &str) -> Option<(usize, bool)> {
    if in_list(STATUS_POS, w) {
        Some((G_STATUS, true))
    } else if in_list(STATUS_NEG, w) {
        Some((G_STATUS, false))
    } else if in_list(UPDOWN_POS, w) {
        Some((G_UPDOWN, true))
    } else if in_list(UPDOWN_NEG, w) {
        Some((G_UPDOWN, false))
    } else if in_list(WINLOSE_POS, w) {
        Some((G_WINLOSE, true))
    } else if in_list(WINLOSE_NEG, w) {
        Some((G_WINLOSE, false))
    } else {
        None
    }
}

// ---------------------------------------------------------------------------
// Typed facts
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq)]
enum Fact {
    /// 0x-prefixed hex, lowercased. len == 66 → tx hash, len == 42 → address.
    Hex(String),
    /// Integer, normalized digit string (commas / leading zeros stripped).
    Int(String),
    /// Number with a decimal point; compared with tiny relative tolerance.
    Dec(f64),
    /// Transaction status after negation flipping: true = success group.
    Status(bool),
}

impl Fact {
    fn weight(&self) -> f32 {
        match self {
            Fact::Hex(s) => match s.len() {
                66 => 6.0, // tx hash — the single most identifying fact
                42 => 4.0, // address
                _ => 2.0,  // other hex
            },
            Fact::Int(s) => {
                if s.len() >= 10 {
                    3.0 // big integer (wei values, timestamps)
                } else {
                    1.5 // small number (block number, gas used, value 0, ...)
                }
            }
            Fact::Dec(_) => 1.5,
            Fact::Status(_) => 2.0,
        }
    }

    /// Stable sort/dedup key. Deterministic — derived only from content.
    fn key(&self) -> String {
        match self {
            Fact::Hex(s) => format!("h:{s}"),
            Fact::Int(s) => format!("i:{s}"),
            Fact::Dec(v) => format!("d:{:016x}", v.to_bits()),
            Fact::Status(s) => format!("s:{}", if *s { 1 } else { 0 }),
        }
    }

    /// Anti-gaming penalty units for a fact asserted in the answer but absent
    /// from the ground truth.
    fn extra_units(&self) -> f32 {
        match self {
            Fact::Hex(_) => 1.0,
            Fact::Int(s) => {
                if s.len() >= 10 {
                    1.0
                } else {
                    0.4
                }
            }
            Fact::Dec(_) => 0.3,
            Fact::Status(_) => 0.0, // handled by the contradiction penalty
        }
    }
}

fn int_to_f64(s: &str) -> Option<f64> {
    if s.len() <= 15 {
        s.parse::<f64>().ok()
    } else {
        None // too large for exact f64 — only exact string equality counts
    }
}

fn num_eq(a: f64, b: f64) -> bool {
    if a == b {
        return true;
    }
    let scale = a.abs().max(b.abs());
    (a - b).abs() <= 1e-6 * scale
}

/// Exact fact match.
fn facts_match(gt: &Fact, ma: &Fact) -> bool {
    match (gt, ma) {
        (Fact::Hex(a), Fact::Hex(b)) => a == b,
        (Fact::Status(a), Fact::Status(b)) => a == b,
        (Fact::Int(a), Fact::Int(b)) => a == b,
        (Fact::Int(a), Fact::Dec(b)) | (Fact::Dec(b), Fact::Int(a)) => {
            matches!(int_to_f64(a), Some(av) if num_eq(av, *b))
        }
        (Fact::Dec(a), Fact::Dec(b)) => num_eq(*a, *b),
        _ => false,
    }
}

/// Partial credit in [0,1] for a ground-truth fact against all answer facts.
/// Hex prefix (>=10 hex chars, one a prefix of the other) earns 0.75 —
/// handles truncated hash/address display.
fn match_credit(gt: &Fact, ma_facts: &[Fact]) -> f32 {
    let mut best = 0.0f32;
    for mf in ma_facts {
        if facts_match(gt, mf) {
            return 1.0;
        }
        if let (Fact::Hex(a), Fact::Hex(b)) = (gt, mf) {
            let (short, long) = if a.len() <= b.len() { (a, b) } else { (b, a) };
            if short.len() >= 12 && long.starts_with(short.as_str()) && best < 0.75 {
                best = 0.75;
            }
        }
    }
    best
}

/// Near-miss digits: same-length strings differing in at most 2 positions
/// (block off by one, wei last digit wrong), or a one-digit append/prepend
/// variant (847 vs 8470, 251 vs 3251) — an actively wrong number.
fn digits_near_miss(a: &str, b: &str) -> bool {
    if a == b {
        return false;
    }
    if a.len() == b.len() && a.len() >= 4 {
        let mut diff = 0u32;
        for (ca, cb) in a.bytes().zip(b.bytes()) {
            if ca != cb {
                diff += 1;
                if diff > 2 {
                    return false;
                }
            }
        }
        return diff >= 1;
    }
    let (short, long) = if a.len() < b.len() { (a, b) } else { (b, a) };
    short.len() >= 3
        && long.len() == short.len() + 1
        && (long.starts_with(short) || long.ends_with(short))
}

/// Same-length hex values sharing a >=10-char prefix but differing → corrupted
/// hash/address assertion.
fn hex_near_miss(a: &str, b: &str) -> bool {
    if a.len() != b.len() || a.len() < 40 || a == b {
        return false;
    }
    let pa = &a.as_bytes()[..12.min(a.len())];
    let pb = &b.as_bytes()[..12.min(b.len())];
    pa == pb
}

// ---------------------------------------------------------------------------
// Lexer / analyzer
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq)]
enum Kind {
    Word,
    Num,
    Hex,
    Cjk,
}

struct Tok {
    text: String,
    kind: Kind,
    negated: bool,
    /// Original text had a leading uppercase letter (proper-noun heuristic).
    proper: bool,
}

struct Analysis {
    facts: Vec<Fact>,
    toks: Vec<Tok>,
    pol: [u8; NGROUPS], // bit 1 = positive asserted, bit 2 = negative asserted
    neg_strong: u32,
    from_addr: Option<String>,
    to_addr: Option<String>,
}

fn is_cjk_or_symbol(c: char) -> bool {
    (c as u32) >= 0x2E80 && !c.is_whitespace()
}

/// Full analysis pass: typed facts, similarity tokens with negation flags,
/// polarity groups (with negation flipping), from/to address orientation.
fn analyze(text: &str) -> Analysis {
    let chars: Vec<char> = text.chars().collect();
    let n = chars.len();
    let mut facts: Vec<Fact> = Vec::new();
    let mut toks: Vec<Tok> = Vec::new();
    let mut pol = [0u8; NGROUPS];
    let mut neg_strong = 0u32;
    let mut from_addr: Option<String> = None;
    let mut to_addr: Option<String> = None;

    // Negation windows: `neg_active` counts remaining CONTENT tokens a
    // negator flips polarity words over (3); `flag_budget` marks only the
    // FIRST content token after a negator as lexically negated ("not Sydney")
    // so collateral nouns further along don't get falsely flagged.
    // Stopwords / numbers / hex do not consume either window.
    let mut neg_active = 0i32;
    let mut flag_budget = 0i32;
    // A capital letter at a sentence start is grammar, not evidence of a
    // proper noun ("Bake the bread..." / "Give the loaf..."), so such tokens
    // must never be treated as named entities by the substitution check.
    let mut sentence_start = true;
    let mut pending_initial_caps: Vec<usize> = Vec::new();
    // from/to orientation: which marker was last seen and how many tokens ago.
    let mut marker: Option<(bool, u32)> = None; // (is_from, tokens_since)
    let mut word_index = 0usize; // index among Word toks (for leading yes/no)

    let mut i = 0usize;
    while i < n {
        let c = chars[i];

        // Sentence/clause punctuation closes any open negation scope.
        if c == '.' || c == ',' || c == ';' || c == '!' || c == '?' || c == ':' {
            neg_active = 0;
            flag_budget = 0;
            if c != ',' {
                sentence_start = true;
            }
            i += 1;
            continue;
        }

        // 0x-prefixed hex token
        if c == '0'
            && i + 2 < n
            && (chars[i + 1] == 'x' || chars[i + 1] == 'X')
            && chars[i + 2].is_ascii_hexdigit()
        {
            let mut j = i + 2;
            while j < n && chars[j].is_ascii_hexdigit() {
                j += 1;
            }
            let tok: String = chars[i..j].iter().collect::<String>().to_ascii_lowercase();
            if tok.len() == 42 {
                if let Some((is_from, dist)) = marker {
                    if dist <= 3 {
                        if is_from {
                            if from_addr.is_none() {
                                from_addr = Some(tok.clone());
                            }
                        } else if to_addr.is_none() {
                            to_addr = Some(tok.clone());
                        }
                    }
                }
            }
            if let Some((f, d)) = marker {
                marker = Some((f, d + 1));
            }
            facts.push(Fact::Hex(tok.clone()));
            toks.push(Tok { text: tok, kind: Kind::Hex, negated: false, proper: false });
            i = j;
            continue;
        }

        // Decimal number: digits, ','-separators (only between digits), one
        // '.' (only if followed by a digit).
        if c.is_ascii_digit() {
            let mut j = i;
            let mut raw = String::new();
            let mut seen_dot = false;
            while j < n {
                let d = chars[j];
                if d.is_ascii_digit() {
                    raw.push(d);
                    j += 1;
                } else if d == ',' && j + 1 < n && chars[j + 1].is_ascii_digit() {
                    j += 1; // thousands separator — skip
                } else if d == '.' && !seen_dot && j + 1 < n && chars[j + 1].is_ascii_digit() {
                    raw.push('.');
                    seen_dot = true;
                    j += 1;
                } else {
                    break;
                }
            }
            if seen_dot {
                if let Ok(v) = raw.parse::<f64>() {
                    facts.push(Fact::Dec(v));
                }
                toks.push(Tok { text: raw, kind: Kind::Num, negated: false, proper: false });
            } else {
                let trimmed = raw.trim_start_matches('0');
                let norm = if trimmed.is_empty() { "0" } else { trimmed };
                facts.push(Fact::Int(norm.to_string()));
                toks.push(Tok { text: norm.to_string(), kind: Kind::Num, negated: false, proper: false });
            }
            if let Some((f, d)) = marker {
                marker = Some((f, d + 1));
            }
            i = j;
            continue;
        }

        // CJK / emoji: one char = one similarity token
        if is_cjk_or_symbol(c) {
            toks.push(Tok { text: c.to_string(), kind: Kind::Cjk, negated: false, proper: false });
            i += 1;
            continue;
        }

        // Alphabetic word (Latin, Cyrillic, ...). Contractions merge across
        // an apostrophe: "didn't" -> "didnt"; possessive "'s" is dropped.
        if c.is_alphabetic() {
            // A sentence-initial capital is ambiguous: "Paris is the capital"
            // (proper noun) vs "Bake the bread" (imperative verb). Defer the
            // decision to a post-pass that looks at the following word — a
            // determiner after it means the capitalized word governs an
            // object, i.e. it is a verb, not a named entity.
            if sentence_start && c.is_uppercase() {
                pending_initial_caps.push(toks.len());
            }
            let prop = c.is_uppercase() && !sentence_start;
            sentence_start = false;
            let mut j = i;
            while j < n && chars[j].is_alphabetic() && !is_cjk_or_symbol(chars[j]) {
                j += 1;
            }
            let mut word: String = chars[i..j].iter().collect::<String>().to_lowercase();
            if j + 1 < n && (chars[j] == '\'' || chars[j] == '\u{2019}') {
                let nxt = chars[j + 1].to_ascii_lowercase();
                let boundary = j + 2 >= n || !chars[j + 2].is_alphabetic();
                if nxt == 't' && boundary {
                    word.push('t');
                    j += 2;
                } else if nxt == 's' && boundary {
                    j += 2; // possessive — drop
                }
            }

            let is_first_word = word_index == 0;
            word_index += 1;

            // Leading yes/no interjection → yes/no polarity group.
            if is_first_word && (word == "yes" || word == "no") {
                if word == "yes" {
                    pol[G_YESNO] |= 1;
                } else {
                    pol[G_YESNO] |= 2;
                    // "No," / "No —" is an interjection only; a bare leading
                    // "no" ("No transaction was found") also negates.
                    let mut k = j;
                    while k < n && chars[k] == ' ' {
                        k += 1;
                    }
                    let interjection = k < n
                        && (chars[k] == ',' || chars[k] == '-' || chars[k] == '\u{2014}');
                    if !interjection {
                        neg_active = 3;
                        flag_budget = 1;
                    }
                }
                toks.push(Tok { text: word, kind: Kind::Word, negated: false, proper: prop });
                i = j;
                continue;
            }

            // Number words become numeric tokens/facts and do not consume
            // the negation windows (like digit tokens).
            if let Some(d) = word_number(&word) {
                facts.push(Fact::Int(d.to_string()));
                toks.push(Tok { text: d.to_string(), kind: Kind::Num, negated: false, proper: false });
                if let Some((f, dd)) = marker {
                    marker = Some((f, dd + 1));
                }
                i = j;
                continue;
            }

            let strong_neg = in_list(NEG_STRONG, &word);
            let weak_neg = in_list(NEG_WEAK, &word);
            if strong_neg || weak_neg {
                if strong_neg {
                    neg_strong += 1;
                }
                neg_active = 3;
                // "instead of X", "rather than X", "without X" disclaim the
                // whole following phrase, not just its first word.
                flag_budget = if matches!(word.as_str(), "instead" | "rather" | "without") { 3 } else { 1 };
                toks.push(Tok { text: word, kind: Kind::Word, negated: false, proper: prop });
                if let Some((f, d)) = marker {
                    marker = Some((f, d + 1));
                }
                i = j;
                continue;
            }

            // from/to orientation markers
            if word == "from" || word == "sender" {
                marker = Some((true, 0));
            } else if word == "to" || word == "recipient" || word == "receiver" {
                marker = Some((false, 0));
            } else if let Some((f, d)) = marker {
                marker = Some((f, d + 1));
            }

            let flipped = neg_active > 0;
            // Bare directional adverbs right after a count noun are position
            // descriptions ("ten points down"), not direction-of-change
            // claims — they must not arm the up/down contradiction group.
            let positional = matches!(word.as_str(), "up" | "down" | "higher" | "lower")
                && toks.iter().rev().find(|t| t.kind == Kind::Word).map_or(false, |t| {
                    matches!(t.text.as_str(), "points" | "point" | "goals" | "goal" | "games" | "game" | "sets" | "set" | "runs" | "run")
                });
            // "defeated"/"beaten" are win-group words in the active voice
            // ("A defeated B") but flip meaning in the passive ("A was
            // defeated") — only the active form asserts a win.
            let mut pol_hit = if positional { None } else { polarity_word(&word) };
            if pol_hit.is_none() && (word == "defeated" || word == "beaten") {
                let passive = toks.iter().rev().find(|t| t.kind == Kind::Word).map_or(false, |t| {
                    matches!(t.text.as_str(), "was" | "were" | "been" | "being" | "is" | "are" | "got" | "getting" | "get")
                });
                if !passive {
                    pol_hit = Some((G_WINLOSE, true));
                }
            }
            if let Some((g, positive)) = pol_hit {
                let effective = positive != flipped;
                pol[g] |= if effective { 1 } else { 2 };
                if g == G_STATUS {
                    facts.push(Fact::Status(effective));
                }
            }

            let stop = in_list(STOPWORDS, &word);
            let flag = flag_budget > 0 && !stop;
            toks.push(Tok { text: word, kind: Kind::Word, negated: flag, proper: prop });
            if !stop {
                // content words consume both negation windows
                if neg_active > 0 {
                    neg_active -= 1;
                }
                if flag_budget > 0 {
                    flag_budget -= 1;
                }
            }
            i = j;
            continue;
        }

        i += 1;
    }

    // Resolve deferred sentence-initial capitals (see the note at the word
    // branch): proper-noun unless the next word is a determiner.
    const DETERMINERS: &[&str] = &[
        "the", "a", "an", "this", "that", "these", "those", "my", "your",
        "his", "her", "its", "our", "their", "some", "any", "all", "each",
        "every", "both", "another", "one", "two", "three", "it", "them",
        "me", "us", "him", "you",
    ];
    for idx in pending_initial_caps {
        let next_word = toks
            .iter()
            .skip(idx + 1)
            .find(|t| t.kind == Kind::Word)
            .map(|t| t.text.clone());
        let governs_object = match next_word {
            Some(w) => in_list(DETERMINERS, &w),
            None => false,
        };
        if !governs_object {
            if let Some(t) = toks.get_mut(idx) {
                t.proper = true;
            }
        }
    }

    // Chinese polarity: substring scan with a 2-char negator look-behind.
    let full: String = chars.iter().collect::<String>();
    for (pat, g, positive) in ZH_POLARITY {
        let mut start = 0usize;
        while let Some(off) = full[start..].find(pat) {
            let abs = start + off;
            let prefix: Vec<char> = full[..abs].chars().rev().take(4).collect();
            let flipped = prefix.iter().any(|c| ZH_NEGATORS.contains(c));
            let effective = *positive != flipped;
            pol[*g] |= if effective { 1 } else { 2 };
            if *g == G_STATUS {
                facts.push(Fact::Status(effective));
            }
            start = abs + pat.len();
        }
    }

    // Deterministic dedup of facts by content key (Vec-based, no hash maps).
    facts.sort_by(|a, b| a.key().cmp(&b.key()));
    facts.dedup_by(|a, b| a.key() == b.key());

    Analysis { facts, toks, pol, neg_strong, from_addr, to_addr }
}

// ---------------------------------------------------------------------------
// Text similarity: weighted unigram F1 + bigram Dice
// ---------------------------------------------------------------------------

/// Synonym groups: frequent answer verbs and qualifiers collapse to a group
/// token, so "won"/"beat"/"defeated" (or "about"/"roughly"/"around") match
/// across paraphrases. Groups never merge opposites — win/lose and rise/fall
/// stay distinct, and the polarity machinery uses the raw words anyway.
const SYN_GROUPS: &[(&str, &[&str])] = &[
    ("~win", &["won", "win", "wins", "winning", "victory", "victorious", "beat", "defeated", "triumphed", "prevailed"]),
    ("~lose", &["lost", "lose", "loses", "losing", "squandered", "blew"]),
    ("~rise", &["rose", "risen", "rise", "rises", "rising", "climbed", "climbs", "climbing", "increased", "increases", "increasing", "gained", "gains", "surged", "jumped", "higher"]),
    ("~fall", &["fell", "fallen", "fall", "falls", "falling", "dropped", "drops", "dropping", "declined", "declines", "declining", "decreased", "decreases", "decreasing", "lower", "plunged", "sank"]),
    ("~success", &["succeeded", "succeeds", "succeed", "successful", "successfully", "success", "confirmed", "executed", "completed", "mined", "landed"]),
    ("~fail", &["failed", "fails", "fail", "failing", "failure", "reverted", "reverts", "revert", "unsuccessful", "rejected"]),
    ("~about", &["about", "approximately", "around", "roughly", "near", "nearly", "circa"]),
    ("~large", &["largest", "biggest", "large", "big"]),
    ("~tie", &["tied", "tie", "ties", "level", "deadlocked", "square"]),
    ("~each", &["each", "apiece"]),
    ("~keep", &["kept", "keep", "keeps", "keeping", "maintain", "maintains", "maintained"]),
    ("~improve", &["improve", "improves", "improved", "improving", "lifts", "lifted", "boosts", "boosted", "enhances", "enhanced"]),
    ("~worsen", &["worsen", "worsens", "worsened", "worsening", "degrades", "degraded", "deteriorates", "deteriorated"]),
    ("~strengthen", &["strengthen", "strengthens", "strengthened", "bolsters", "bolstered"]),
    ("~weaken", &["weaken", "weakens", "weakened", "erode", "erodes", "eroded", "undermines", "undermined"]),
    ("~north", &["north", "northward", "northwards", "northern"]),
    ("~south", &["south", "southward", "southwards", "southern"]),
    ("~loose", &["relaxes", "relaxed", "relax", "softens", "softened", "loosens", "loosened"]),
    ("~tight", &["tightens", "tightened", "tighten", "stiffens", "stiffened"]),
    ("~more", &["more", "greater"]),
    ("~less", &["less", "fewer", "lesser"]),
    ("~sunny", &["sunny", "sunshine", "cloudless", "clear", "clearing", "clears"]),
    ("~cloudy", &["cloudy", "overcast"]),
    ("~rain", &["rain", "rains", "rainy", "raining", "showers"]),
    ("~snow", &["snow", "snowy", "snowfall"]),
    ("~storm", &["storm", "storms", "stormy", "thunderstorms", "thunderstorm"]),
    ("~calm", &["calm", "gentle", "mild"]),
    ("~lead", &["leads", "leading", "ahead"]),
];

fn synonym_group(w: &str) -> Option<&'static str> {
    for (label, words) in SYN_GROUPS {
        if words.iter().any(|x| *x == w) {
            return Some(label);
        }
    }
    None
}

/// Canonical form for matching: synonym-group token when the word belongs to
/// one; otherwise strip one common inflection suffix (when at least 4 chars
/// remain), then keep a 5-char prefix — so "succeeded" and "succeed" both
/// canonicalize alike, "clearing" and "clears" to "clear". Deterministic,
/// applied identically to both texts.
fn canon(t: &Tok) -> String {
    if t.kind != Kind::Word {
        return t.text.clone();
    }
    let w = t.text.as_str();
    if let Some(g) = synonym_group(w) {
        return g.to_string();
    }
    let mut stem = w;
    for suf in ["ing", "ed", "ly", "es", "s"] {
        if let Some(rest) = w.strip_suffix(suf) {
            if rest.chars().count() >= 4 {
                stem = rest;
                break;
            }
        }
    }
    if stem.chars().count() > 5 {
        stem.chars().take(5).collect()
    } else {
        stem.to_string()
    }
}

fn tok_weight(t: &Tok) -> f32 {
    match t.kind {
        Kind::Hex => 2.5,
        Kind::Num => {
            if t.text.len() >= 10 {
                2.5
            } else {
                1.8
            }
        }
        Kind::Cjk => {
            let c = t.text.chars().next().unwrap_or(' ');
            if ZH_STOP.contains(&c) {
                0.25
            } else {
                1.0
            }
        }
        Kind::Word => {
            if in_list(STOPWORDS, &t.text)
                || in_list(NEG_STRONG, &t.text)
                || in_list(NEG_WEAK, &t.text)
            {
                0.25
            } else {
                1.0
            }
        }
    }
}

/// Weighted multiset intersection over (negation-flag, canonical-token) keys.
fn weighted_f1(gt: &[Tok], ma: &[Tok]) -> f32 {
    if gt.is_empty() || ma.is_empty() {
        return 0.0;
    }
    let keyed = |ts: &[Tok], skip_negated: bool| -> Vec<(String, f32)> {
        let mut v: Vec<(String, f32)> = ts
            .iter()
            .filter(|t| !(skip_negated && t.negated))
            .map(|t| {
                (
                    format!("{}|{}", if t.negated { 'n' } else { 'p' }, canon(t)),
                    tok_weight(t),
                )
            })
            .collect();
        v.sort_by(|a, b| a.0.cmp(&b.0));
        v
    };
    // Ground-truth tokens under negation are disclaimed ("not Sydney") — an
    // answer is not required to repeat them, so they leave the reference set.
    let a = keyed(gt, true);
    let b = keyed(ma, false);
    let total_a: f32 = a.iter().map(|x| x.1).sum();
    let total_b: f32 = b.iter().map(|x| x.1).sum();
    if total_a <= 0.0 || total_b <= 0.0 {
        return 0.0;
    }
    let (mut i, mut j, mut matched) = (0usize, 0usize, 0.0f32);
    while i < a.len() && j < b.len() {
        match a[i].0.cmp(&b[j].0) {
            core::cmp::Ordering::Equal => {
                matched += a[i].1;
                i += 1;
                j += 1;
            }
            core::cmp::Ordering::Less => i += 1,
            core::cmp::Ordering::Greater => j += 1,
        }
    }
    let p = matched / total_b;
    let r = matched / total_a;
    // Recall-tilted F-beta (beta^2 = 1.5): a paraphrase that covers the
    // ground truth but adds phrasing of its own loses less than one that
    // omits content. Value dumps are handled by the precision penalty.
    const B2: f32 = 2.0;
    if p <= 0.0 || r <= 0.0 {
        0.0
    } else {
        (1.0 + B2) * p * r / (B2 * p + r)
    }
}

/// Dice coefficient over adjacent-token bigrams (word-order signal).
fn bigram_dice(gt: &[Tok], ma: &[Tok]) -> f32 {
    if gt.len() < 2 || ma.len() < 2 {
        return weighted_f1(gt, ma); // degenerate: fall back to unigram signal
    }
    let grams = |ts: &[Tok]| -> Vec<String> {
        let mut v: Vec<String> = (0..ts.len() - 1)
            .map(|k| format!("{}\u{1}{}", canon(&ts[k]), canon(&ts[k + 1])))
            .collect();
        v.sort();
        v
    };
    let a = grams(gt);
    let b = grams(ma);
    let (mut i, mut j, mut common) = (0usize, 0usize, 0usize);
    while i < a.len() && j < b.len() {
        match a[i].cmp(&b[j]) {
            core::cmp::Ordering::Equal => {
                common += 1;
                i += 1;
                j += 1;
            }
            core::cmp::Ordering::Less => i += 1,
            core::cmp::Ordering::Greater => j += 1,
        }
    }
    (2.0 * common as f32) / ((a.len() + b.len()) as f32)
}

/// Character-trigram Dice over normalized text (lowercased, punctuation runs
/// collapsed to single spaces). Catches morphology ("clearing"/"clears") and
/// partial-word overlap that token matching misses; order-insensitive.
fn char_trigram_dice(a: &str, b: &str) -> f32 {
    let norm = |s: &str| -> Vec<char> {
        let mut v: Vec<char> = Vec::new();
        let mut last_space = true;
        for c in s.chars() {
            let keep = c.is_alphanumeric() || is_cjk_or_symbol(c);
            if keep {
                for lc in c.to_lowercase() {
                    v.push(lc);
                }
                last_space = false;
            } else if !last_space {
                v.push(' ');
                last_space = true;
            }
        }
        v
    };
    let grams = |cs: &[char]| -> Vec<String> {
        if cs.len() < 3 {
            return vec![cs.iter().collect()];
        }
        let mut v: Vec<String> = (0..cs.len() - 2)
            .map(|i| cs[i..i + 3].iter().collect())
            .collect();
        v.sort();
        v
    };
    let a = grams(&norm(a));
    let b = grams(&norm(b));
    if a.is_empty() || b.is_empty() {
        return 0.0;
    }
    let (mut i, mut j, mut common) = (0usize, 0usize, 0usize);
    while i < a.len() && j < b.len() {
        match a[i].cmp(&b[j]) {
            core::cmp::Ordering::Equal => {
                common += 1;
                i += 1;
                j += 1;
            }
            core::cmp::Ordering::Less => i += 1,
            core::cmp::Ordering::Greater => j += 1,
        }
    }
    (2.0 * common as f32) / ((a.len() + b.len()) as f32)
}

fn text_similarity(gt: &[Tok], ma: &[Tok]) -> f32 {
    let f1 = weighted_f1(gt, ma);
    let bg = bigram_dice(gt, ma);
    0.60 * f1 + 0.15 * bg
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/// Structural-syntax density: the fraction of non-whitespace characters that
/// are JSON/key-value syntax. Prose answers sit under ~4%; raw JSON blobs sit
/// above ~15%. Used to penalize machine-readable dumps the way the network's
/// champion (and its revealed leaderboard preference) does: an answer is
/// supposed to be an answer, not a serialized API response.
fn structure_density(s: &str) -> f32 {
    let mut structural = 0u32;
    let mut nonspace = 0u32;
    for c in s.chars() {
        if c.is_whitespace() {
            continue;
        }
        nonspace += 1;
        if matches!(c, '{' | '}' | '[' | ']' | '"' | ':' | ',') {
            structural += 1;
        }
    }
    if nonspace == 0 {
        0.0
    } else {
        structural as f32 / nonspace as f32
    }
}

/// Blobness in [0,1]: how much a text is a serialized data structure rather
/// than prose. Two signals, take the max:
///   - JSON key pattern: occurrences of '":' (one per key in a serialized
///     object) — robust even when long hex payloads dilute character counts;
///   - structural character density, for bracket/CSV-style dumps.
fn blobness(s: &str) -> f32 {
    let keys = s.matches("\":").count() as f32;
    let key_ramp = ((keys - 1.0) / 5.0).clamp(0.0, 1.0);
    let density_ramp = ((structure_density(s) - 0.08) / 0.14).clamp(0.0, 1.0);
    key_ramp.max(density_ramp)
}

/// Smooth monotone contrast curve: fixes s=0, 0.5, 1; pushes >0.5 toward 1
/// and <0.5 toward 0. Never reorders scores.
fn contrast(s: f32) -> f32 {
    let s = s.clamp(0.0, 1.0);
    let a = s * s * s;
    let b = (1.0 - s) * (1.0 - s) * (1.0 - s);
    if a + b <= 0.0 {
        return 0.0;
    }
    a / (a + b)
}

/// Canon set of content Word tokens (sorted, deduped) for membership tests.
fn canon_set(toks: &[Tok]) -> Vec<String> {
    let mut v: Vec<String> = toks
        .iter()
        .filter(|t| t.kind == Kind::Word)
        .map(canon)
        .collect();
    v.sort();
    v.dedup();
    v
}

fn set_has(set: &[String], k: &str) -> bool {
    set.binary_search_by(|x| x.as_str().cmp(k)).is_ok()
}

/// Per-canon affirm/deny profile of the content words in a text:
/// (canon, affirmed_anywhere, negated_anywhere). Sorted by canon.
fn polarity_profile(toks: &[Tok]) -> Vec<(String, bool, bool)> {
    let mut v: Vec<(String, bool, bool)> = Vec::new();
    for t in toks {
        if t.kind != Kind::Word {
            continue;
        }
        if t.text.len() < 3
            || in_list(STOPWORDS, &t.text)
            || in_list(NEG_STRONG, &t.text)
            || in_list(NEG_WEAK, &t.text)
        {
            continue;
        }
        let c = canon(t);
        match v.binary_search_by(|x| x.0.cmp(&c)) {
            Ok(idx) => {
                if t.negated {
                    v[idx].2 = true;
                } else {
                    v[idx].1 = true;
                }
            }
            Err(idx) => v.insert(idx, (c, !t.negated, t.negated)),
        }
    }
    v
}

fn score(question: &str, ground_truth: &str, miner_answer: &str) -> f32 {
    let ma_trim = miner_answer.trim();
    // HARD RULE: empty / whitespace-only answer → exactly 0.0
    if ma_trim.is_empty() {
        return 0.0;
    }
    let gt_trim = ground_truth.trim();
    // Verbatim match (trimmed) → exactly 1.0. Also guarantees Stage-2
    // self-match rank_answer(q, gt, gt) == 1.0 on every question.
    if ma_trim == gt_trim {
        return 1.0;
    }
    if gt_trim.is_empty() {
        return 0.0;
    }

    let q = analyze(question.trim());
    let gt = analyze(gt_trim);
    let ma = analyze(ma_trim);

    // Question-discounted fact recall is needed up front: the semantic
    // channel is gated by it below.
    let eff_weight_early = |gf: &Fact| -> f32 {
        let w = gf.weight();
        match gf {
            Fact::Status(_) => w,
            _ => {
                if q.facts.iter().any(|qf| facts_match(gf, qf)) {
                    w * 0.15
                } else {
                    w
                }
            }
        }
    };
    let gtw_disc: f32 = gt.facts.iter().map(&eff_weight_early).sum();
    let gtw_raw: f32 = gt.facts.iter().map(|f| f.weight()).sum();
    let recall_early = if gtw_disc > 0.0 {
        gt.facts
            .iter()
            .map(|gf| match_credit(gf, &ma.facts) * eff_weight_early(gf))
            .sum::<f32>()
            / gtw_disc
    } else {
        1.0
    };

    // Token-level similarity plus a character-trigram term: loose-but-correct
    // paraphrases share word morphology even when exact tokens differ.
    let lex = (text_similarity(&gt.toks, &ma.toks)
        + 0.25 * char_trigram_dice(gt_trim, ma_trim))
        .clamp(0.0, 1.0);

    // MiniLM semantic similarity carries the meaning signal that lexical
    // overlap misses on distant paraphrases. Calibrated so unrelated text
    // (cosine ~0.3) maps to 0 and a solid paraphrase (~0.95) maps to ~1.
    let cjk_frac = |t: &str| -> f32 {
        let mut cjk = 0u32;
        let mut total = 0u32;
        for c in t.chars() {
            if c.is_whitespace() {
                continue;
            }
            total += 1;
            if is_cjk_or_symbol(c) {
                cjk += 1;
            }
        }
        if total == 0 { 0.0 } else { cjk as f32 / total as f32 }
    };
    let cjk_heavy = cjk_frac(gt_trim) > 0.25 || cjk_frac(ma_trim) > 0.25;
    let sem = if cjk_heavy { 0.0 } else { semantic_cosine(gt_trim, ma_trim) };
    let sem_cal_topical = ((sem - 0.35) / 0.60).clamp(0.0, 1.0);
    // Recall gate: semantic topicality must not lift an answer that failed
    // the ground truth's typed facts (wrong population, wrong score...).
    let alpha_gate = gtw_raw / (gtw_raw + 3.0);
    let sem_cal = sem_cal_topical * (1.0 - alpha_gate * (1.0 - recall_early));
    // Fusion: a weighted blend, with a semantic floor so a distant-but-true
    // paraphrase (high cosine, low token overlap) is not starved by lexical
    // similarity. All correctness penalties apply multiplicatively AFTER
    // this, so embeddings can never rescue a wrong-status / wrong-value /
    // entity-swapped answer.
    let text = lex
        .max(0.55 * lex + 0.45 * sem_cal)
        .max(sem_cal - 0.08)
        .clamp(0.0, 1.0);

    // Question-given facts are context the answer need not repeat: a hash or
    // block number already present in the question carries little answer
    // information, so its ground-truth weight is discounted. Status facts are
    // never discounted (a question mentioning "succeed" is a query, not an
    // assertion).
    let eff_weight = |gf: &Fact| -> f32 {
        let w = gf.weight();
        match gf {
            Fact::Status(_) => w,
            _ => {
                if q.facts.iter().any(|qf| facts_match(gf, qf)) {
                    w * 0.15
                } else {
                    w
                }
            }
        }
    };

    let gt_weight_total: f32 = gt.facts.iter().map(&eff_weight).sum();
    let gt_weight_raw: f32 = gt.facts.iter().map(|f| f.weight()).sum();

    // Fact/text blend: fact-rich ground truths are decided by fact recall,
    // fact-free ones by text similarity (smooth ramp, never a hard switch).
    // Alpha reflects how fact-like the ground truth is (undiscounted), while
    // recall itself is measured over question-discounted weights.
    let alpha = gt_weight_raw / (gt_weight_raw + 3.0);
    let mut recall = 0.0f32;
    if gt_weight_total > 0.0 {
        let mut matched_weight = 0.0f32;
        for gf in &gt.facts {
            matched_weight += match_credit(gf, &ma.facts) * eff_weight(gf);
        }
        recall = matched_weight / gt_weight_total;
    }
    let raw = alpha * recall + (1.0 - alpha) * text;

    // --- Contradiction penalty (multiplicative — crushes high-recall answers
    // that wrap the right numbers in the wrong conclusion) ------------------
    let mut p_contra = 0.0f32;
    for g in 0..NGROUPS {
        let g_pos = gt.pol[g] & 1 != 0;
        let g_neg = gt.pol[g] & 2 != 0;
        let m_pos = ma.pol[g] & 1 != 0;
        let m_neg = ma.pol[g] & 2 != 0;
        // Exclusive opposite assertion only.
        let contradiction = (g_pos && !g_neg && m_neg && !m_pos)
            || (g_neg && !g_pos && m_pos && !m_neg);
        if contradiction {
            p_contra += match g {
                G_STATUS => 0.60,
                G_YESNO => 0.55,
                G_WINLOSE => 0.68,
                _ => 0.65,
            };
        }
    }

    // Affirm/deny clash on content words: the answer denies something the
    // ground truth asserts ("was never included" vs "included in block N"),
    // or affirms something the ground truth explicitly negates ("is Sydney"
    // vs "not Sydney").
    {
        let gp = polarity_profile(&gt.toks);
        let mp = polarity_profile(&ma.toks);
        let is_proper = |toks: &[Tok], c: &str| -> bool {
            toks.iter().any(|t| t.kind == Kind::Word && t.proper && canon(t) == c)
        };
        let mut p_clash = 0.0f32;
        for (c, ga, gn) in &gp {
            if let Ok(idx) = mp.binary_search_by(|x| x.0.cmp(c)) {
                let (_, ma_aff, ma_neg) = &mp[idx];
                let deny = *ga && !*gn && *ma_neg && !*ma_aff;
                let affirm_denied = *gn && !*ga && *ma_aff && !*ma_neg;
                if deny || affirm_denied {
                    // A named entity explicitly negated on one side and
                    // asserted on the other is decisive; generic words get a
                    // mild nudge (polarity groups carry the strong signal).
                    p_clash += if is_proper(&gt.toks, c) && is_proper(&ma.toks, c) {
                        0.35
                    } else {
                        0.18
                    };
                }
            }
        }
        p_contra += p_clash.min(0.60);
    }

    // Antonym substitution at the synonym-group level: the ground truth
    // asserts one member of an antonym pair, the answer asserts the opposite
    // member and not the original ("lowers risk, improves mood" answered
    // with "raises risk, worsens mood"). Works even when a sentence carries
    // several direction words, where the coarse group bits neutralize.
    {
        const ANTONYMS: &[(&str, &str)] = &[
            ("~rise", "~fall"),
            ("~win", "~lose"),
            ("~improve", "~worsen"),
            ("~strengthen", "~weaken"),
            ("~north", "~south"),
            ("~loose", "~tight"),
            ("~more", "~less"),
            ("~sunny", "~rain"),
            ("~sunny", "~cloudy"),
            ("~sunny", "~storm"),
            ("~rain", "~snow"),
            ("~calm", "~storm"),
            ("~tie", "~lead"),
        ];
        let affirmed = |toks: &[Tok], label: &str| -> bool {
            toks.iter().any(|t| t.kind == Kind::Word && !t.negated && canon(t) == label)
        };
        let mut hits = 0.0f32;
        for (a, b) in ANTONYMS {
            for (x, y) in [(a, b), (b, a)] {
                if affirmed(&gt.toks, x) && affirmed(&ma.toks, y) && !affirmed(&ma.toks, x) {
                    hits += 0.40;
                }
            }
        }
        p_contra += hits.min(0.80);
    }

    let mut veto_proper = false;
    // Proper-noun substitution: the answer replaces a named entity from the
    // ground truth with a novel one in the same lexical slot
    // ("Paris is the capital" -> "Marseille is the capital").
    {
        let gt_set = canon_set(&gt.toks);
        let ma_set = canon_set(&ma.toks);
        let q_set = canon_set(&q.toks);
        let slot = |toks: &[Tok], k: usize| -> (String, String) {
            let prev = if k == 0 { "^".to_string() } else { canon(&toks[k - 1]) };
            let next = if k + 1 >= toks.len() { "$".to_string() } else { canon(&toks[k + 1]) };
            (prev, next)
        };
        // `from_question` gates only the ANSWER side: an entity the question
        // itself names is not a novel claim, so it cannot be a substitution.
        // The ground-truth side must NOT be gated — "on Base" is named by the
        // question AND by the ground truth, and an answer that says
        // "on Arbitrum" in its slot has substituted it, which is exactly the
        // wrong-chain case this must catch.
        let candidate = |t: &Tok, own: &[String], other: &[String], from_question: bool| -> bool {
            t.kind == Kind::Word
                && t.proper
                && t.text.len() >= 3
                && !in_list(STOPWORDS, &t.text)
                && !in_list(NEG_STRONG, &t.text)
                && !in_list(NEG_WEAK, &t.text)
                && polarity_word(&t.text).is_none()
                && set_has(own, &canon(t))
                && !set_has(other, &canon(t))
                && (!from_question || !set_has(&q_set, &canon(t)))
        };
        let mut fired = false;
        'outer: for (gi, gtok) in gt.toks.iter().enumerate() {
            if !candidate(gtok, &gt_set, &ma_set, false) {
                continue;
            }
            let (gp, gn) = slot(&gt.toks, gi);
            for (mi, mtok) in ma.toks.iter().enumerate() {
                if !candidate(mtok, &ma_set, &gt_set, true) {
                    continue;
                }
                let (mp, mn) = slot(&ma.toks, mi);
                let real_side = (gp == mp && gp != "^") || (gn == mn && gn != "$");
                if gp == mp && gn == mn && real_side {
                    fired = true;
                    break 'outer;
                }
            }
        }
        if fired {
            p_contra += 0.55;
            veto_proper = true;
        }
    }

    // Swapped from/to orientation: same two addresses, reversed direction.
    if let (Some(gf), Some(gt_to), Some(mf), Some(mt)) =
        (&gt.from_addr, &gt.to_addr, &ma.from_addr, &ma.to_addr)
    {
        if gf != gt_to && mf == gt_to && mt == gf {
            p_contra += 0.55;
        }
    }

    // --- Value-substitution veto ------------------------------------------
    // A ground-truth typed fact with NO match in the answer, where the answer
    // asserts a DIFFERENT value of the same type and comparable magnitude, is
    // a contradiction (wrong amount / wrong address / wrong hash), not a mere
    // omission. Omitting a fact is incompleteness; replacing it with a wrong
    // one is a false claim, and one such claim is disqualifying — so this
    // sets a veto that forces the crushed band regardless of how well the
    // rest of the answer matches lexically or semantically.
    let mut veto = 0.0f32;

    // Near-miss numerics / corrupted hex: actively wrong assertions.
    let mut near_int = 0.0f32;
    let mut near_hex = 0.0f32;
    let mut sub_hex = 0.0f32;
    for gf in &gt.facts {
        if match_credit(gf, &ma.facts) >= 1.0 {
            continue;
        }
        match gf {
            Fact::Int(gs) => {
                let hit = ma.facts.iter().any(|mf| {
                    matches!(mf, Fact::Int(ms)
                        if digits_near_miss(gs, ms)
                        && !gt.facts.iter().any(|g2| facts_match(g2, mf)))
                });
                if hit {
                    near_int += if gs.len() >= 10 { 0.55 } else { 0.45 };
                    veto += 1.0;
                }
            }
            Fact::Hex(gs) => {
                // Corrupted hex (shared prefix) is a near-miss; a completely
                // different address/hash asserted in place of an unmatched
                // ground-truth one is a substitution — both actively wrong.
                let near = ma.facts.iter().any(|mf| {
                    matches!(mf, Fact::Hex(ms)
                        if hex_near_miss(gs, ms)
                        && !gt.facts.iter().any(|g2| facts_match(g2, mf)))
                });
                if near {
                    near_hex += 0.30;
                    veto += 1.0;
                } else {
                    let sub = ma.facts.iter().any(|mf| {
                        matches!(mf, Fact::Hex(ms)
                            if ms.len() == gs.len()
                            && (ms.len() == 42 || ms.len() == 66)
                            && !gt.facts.iter().any(|g2| facts_match(g2, mf)))
                    });
                    if sub {
                        // Wholesale substitution of a critical identifier.
                        sub_hex += if gs.len() == 66 { 0.20 } else { 0.12 };
                        if gs.len() == 66 || gs.len() == 42 {
                            veto += 1.0;
                        }
                    }
                }
            }
            _ => {}
        }
    }
    p_contra += near_int.min(0.70) + near_hex.min(0.45) + sub_hex.min(0.24);

    // Numeric substitution: an unmatched ground-truth number answered with a
    // different unmatched number of COMPARABLE MAGNITUDE (same digit count
    // +-1 for integers, same decade for decimals). The magnitude test is what
    // separates a substituted value ("5 ETH" -> "9 ETH", "14 million" ->
    // "4 million") from an incidental extra number a fuller answer mentions
    // (a confirmation count alongside an omitted 13-digit fee).
    {
        let magnitude = |f: &Fact| -> Option<i32> {
            match f {
                Fact::Int(v) => Some(v.len() as i32),
                Fact::Dec(v) => {
                    let a = if *v < 0.0 { -*v } else { *v };
                    let mut m = 0i32;
                    let mut x = a;
                    while x >= 10.0 && m < 40 {
                        x /= 10.0;
                        m += 1;
                    }
                    Some(m + 1)
                }
                _ => None,
            }
        };
        let numeric_unmatched = |f: &&Fact, other: &[Fact]| -> bool {
            matches!(f, Fact::Int(_) | Fact::Dec(_))
                && !other.iter().any(|o| facts_match(f, o))
        };
        let mut hits = 0u32;
        for gf in gt.facts.iter().filter(|f| numeric_unmatched(f, &ma.facts)) {
            let gm = match magnitude(gf) {
                Some(m) => m,
                None => continue,
            };
            let substituted = ma
                .facts
                .iter()
                .filter(|f| numeric_unmatched(f, &gt.facts))
                .any(|mf| matches!(magnitude(mf), Some(mm) if (mm - gm).abs() <= 1));
            if substituted {
                hits += 1;
            }
        }
        if hits > 0 {
            p_contra += 0.10 * hits.min(2) as f32;
            veto += hits as f32;
        }
    }

    // Negation asymmetry: strong negators the answer adds over the ground
    // truth (mild — the polarity groups carry the real contradiction signal).
    // Skipped when the ground truth is itself a negative statement, where a
    // correct answer legitimately negates too ("no transaction was found").
    let gt_negative = gt.neg_strong > 0 || gt.pol.iter().any(|p| p & 2 != 0);
    if !gt_negative {
        let extra_neg = ma.neg_strong.saturating_sub(gt.neg_strong).min(2);
        p_contra += 0.08 * extra_neg as f32;
    }

    let p_contra = p_contra.min(0.80);

    // --- Anti-gaming precision penalty (value dumping) ---------------------
    let mut extra_units = 0.0f32;
    for mf in &ma.facts {
        if !gt.facts.iter().any(|gf| facts_match(gf, mf)) {
            extra_units += mf.extra_units();
        }
    }
    let excess = (extra_units - 2.0).max(0.0);
    let p_prec = 0.7 * excess / (excess + 4.0);

    // --- Structured-blob penalty -------------------------------------------
    // Answers that are predominantly JSON / key-value syntax (relative to the
    // ground truth's own density, so a structured ground truth neutralizes
    // it) are serialized API responses, not answers. The champion's semantic
    // scoring and the network's live leaderboard both put such blobs below
    // every correct prose answer; ranking them the same way is required for
    // champion agreement on real traffic.
    let blob = (blobness(ma_trim) - blobness(gt_trim)).clamp(0.0, 1.0);

    // The blob factor scales AFTER the contrast curve: a serialized-but-
    // correct answer lands mid-band (below every correct prose answer, above
    // wrong values and errors) instead of being contrast-crushed to zero.
    // Omission-only cushion. An answer that contradicts NOTHING — every value
    // it asserts is right, it is merely incomplete — is a partially correct
    // answer, not a wrong one, and must stay ordered above any answer that
    // substitutes a wrong value. Gated on real coverage (so unrelated text,
    // which matches nothing, gets no lift), on a fact-bearing ground truth,
    // and on zero penalties of any kind (so a value dump cannot buy it).
    // `gt_weight_raw >= 3.0` keeps the cushion off ground truths whose only
    // typed fact is a status word, where "recall" would be 1.0 for any answer
    // that merely repeats the verdict while explaining it wrongly; the text
    // floor requires the answer to actually resemble the truth it omits from.
    let clean = p_contra <= 0.0 && veto <= 0.0 && !veto_proper && p_prec < 0.05;
    let raw = if clean && gt_weight_raw >= 3.0 && recall >= 0.35 && text >= 0.35 {
        raw.max(0.45 + 0.5 * recall)
    } else {
        raw
    };

    let s = (raw * (1.0 - p_contra) - p_prec).clamp(0.0, 1.0);
    let c = (contrast(s) * (1.0 - 0.42 * blob)).clamp(0.0, 0.995);

    // A substituted value is a false claim: force the crushed band whatever
    // the lexical/semantic score says. Kept strictly increasing in c so
    // ordering inside the vetoed class is preserved, and capped far below
    // the low band's reachable range so a vetoed answer can never outrank a
    // merely incomplete one.
    if veto > 0.0 || veto_proper {
        return (0.012 * c).clamp(0.0, 0.995);
    }
    step_band(c)
}

/// Step-with-residual band transform. The node's separation metric is
/// maximized by a step: verdicts on the good side of the threshold land near
/// 1, the rest near 0. The residual slope keeps the transform STRICTLY
/// increasing, so every answer keeps its own place inside its band and the
/// ranking — which is all the Spearman agreement gate measures — is exactly
/// the pre-step ranking. Verbatim (1.0) and empty (0.0) bypass this via the
/// early returns; the high band tops out below 1.0 so only a verbatim match
/// scores 1.0.
/// Piecewise order-preserving band map. High band: near-1 (the step that
/// buys separation on clean pairs). Sloped middle: a misjudged good answer
/// still contributes real margin instead of zero. Low band: wrong answers
/// stay crushed. Strictly increasing everywhere (upward jumps at the
/// breakpoints preserve ordering); verbatim/empty bypass via early returns.
fn step_band(c: f32) -> f32 {
    const T_HI: f32 = 0.60;
    const T_MID: f32 = 0.40;
    if c >= T_HI {
        (0.96 + 0.035 * c).min(0.995)
    } else if c >= T_MID {
        0.25 + 1.5 * (c - T_MID)
    } else {
        0.04 * c
    }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/// Rank a miner answer against the ground truth. Returns a score in [0,1].
/// (ptr,len) pairs are UTF-8 strings in fixed order: question, ground_truth,
/// miner_answer. The question is used only to discount ground-truth facts the
/// question already gives away (a good answer need not echo the asked-about
/// hash) — the ground truth alone still defines correctness.
#[no_mangle]
pub extern "C" fn rank_answer(
    q_ptr: i32,
    q_len: i32,
    gt_ptr: i32,
    gt_len: i32,
    ma_ptr: i32,
    ma_len: i32,
) -> f32 {
    let question = unsafe { read_str(q_ptr, q_len) };
    let ground_truth = unsafe { read_str(gt_ptr, gt_len) };
    let miner_answer = unsafe { read_str(ma_ptr, ma_len) };
    let s = score(&question, &ground_truth, &miner_answer);
    if s.is_finite() {
        s.clamp(0.0, 1.0)
    } else {
        0.0
    }
}
