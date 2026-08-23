//! Truvian — Telegraph Protocol scoring module for the ONCHAIN_TX_LOOKUP intent.
//!
//! Contract (C ABI, wasm32-unknown-unknown, zero imports):
//!   alloc(size: i32) -> i32
//!   dealloc(ptr: i32, size: i32)
//!   rank_answer(q_ptr, q_len, gt_ptr, gt_len, ma_ptr, ma_len) -> f32 in [0,1]
//!
//! Strategy: ONCHAIN_TX_LOOKUP is a Tier A deterministic intent — there is ONE
//! right answer. Instead of generic semantic similarity (the current champion),
//! we extract *typed on-chain facts* (tx hashes, addresses, integers/wei values,
//! decimal numbers, tx-status keywords) from the ground truth and score the
//! miner answer by weighted recall of those facts, blended with a word-overlap
//! similarity component, with an anti-gaming precision penalty for answers
//! stuffed with contradicting hex values / numbers, and a contradiction penalty
//! for wrong tx status.
//!
//! Determinism: only Vec-based, sorted data structures; no hash maps, no
//! randomness, no time, no I/O. Fixed iteration order everywhere.

use std::alloc::{alloc as raw_alloc, dealloc as raw_dealloc, Layout};

// ---------------------------------------------------------------------------
// Host memory contract
// ---------------------------------------------------------------------------

/// Allocate `size` bytes and return the pointer. The host (wazero) writes the
/// UTF-8 input strings here before calling `rank_answer`.
#[no_mangle]
pub extern "C" fn alloc(size: i32) -> i32 {
    let size = if size <= 0 { 1 } else { size as usize };
    // Layout with align 1: raw byte buffers for UTF-8 strings.
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
// Typed fact extraction
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq)]
enum Fact {
    /// 0x-prefixed hex, lowercased. len == 66 → tx hash, len == 42 → address,
    /// anything else → other hex blob (topics, calldata fragments, ...).
    Hex(String),
    /// Integer, normalized digit string (commas stripped, leading zeros
    /// stripped). Kept as a string so 78-digit uint256 values compare exactly.
    Int(String),
    /// Number with a decimal point; compared with tiny relative tolerance.
    Dec(f64),
    /// Transaction status: true = success group, false = failed/reverted group.
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

    /// Anti-gaming penalty units for a fact present in the answer but absent
    /// from the ground truth. Small numbers are near-free supporting detail;
    /// contradicting hex values and big integers are what value-dumping needs.
    fn extra_units(&self) -> f32 {
        match self {
            Fact::Hex(_) => 1.0,
            Fact::Int(s) => {
                if s.len() >= 10 {
                    1.0
                } else {
                    0.25
                }
            }
            Fact::Dec(_) => 0.25,
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

/// Does ground-truth fact `gt` count as matched by miner fact `ma`?
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

fn is_cjk_or_symbol(c: char) -> bool {
    // CJK / Hangul / Kana / fullwidth / emoji: treat each char as its own
    // token so non-space-delimited languages still produce overlap signal.
    (c as u32) >= 0x2E80 && !c.is_whitespace()
}

fn classify_status(word: &str) -> Option<bool> {
    // Order matters: "unsuccessful" must classify as failure.
    if word.starts_with("unsuccess") {
        Some(false)
    } else if word.starts_with("success") || word.starts_with("succeed") {
        Some(true)
    } else if word.starts_with("fail") || word.starts_with("revert") {
        Some(false)
    } else {
        None
    }
}

/// Lex a text into (typed facts, similarity tokens).
///
/// Similarity tokens are every lexeme (words, numbers, hex strings) lowercased,
/// used for the word-overlap component.
fn extract(text: &str) -> (Vec<Fact>, Vec<String>) {
    let chars: Vec<char> = text.chars().collect();
    let n = chars.len();
    let mut facts: Vec<Fact> = Vec::new();
    let mut sim: Vec<String> = Vec::new();
    let mut i = 0usize;

    while i < n {
        let c = chars[i];

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
            sim.push(tok.clone());
            facts.push(Fact::Hex(tok));
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
                sim.push(raw.clone());
            } else {
                let trimmed = raw.trim_start_matches('0');
                let norm = if trimmed.is_empty() { "0" } else { trimmed };
                facts.push(Fact::Int(norm.to_string()));
                sim.push(norm.to_string());
            }
            i = j;
            continue;
        }

        // CJK / emoji: one char = one similarity token
        if is_cjk_or_symbol(c) {
            sim.push(c.to_string());
            i += 1;
            continue;
        }

        // Alphabetic word (Latin, Cyrillic, ... — below the CJK ranges)
        if c.is_alphabetic() {
            let mut j = i;
            while j < n && chars[j].is_alphabetic() && !is_cjk_or_symbol(chars[j]) {
                j += 1;
            }
            let word: String = chars[i..j].iter().collect::<String>().to_lowercase();
            if let Some(s) = classify_status(&word) {
                facts.push(Fact::Status(s));
            }
            sim.push(word);
            i = j;
            continue;
        }

        i += 1;
    }

    // Deterministic dedup of facts by content key (Vec-based, no hash maps).
    facts.sort_by(|a, b| a.key().cmp(&b.key()));
    facts.dedup_by(|a, b| a.key() == b.key());

    (facts, sim)
}

// ---------------------------------------------------------------------------
// Similarity + scoring
// ---------------------------------------------------------------------------

/// Dice coefficient over sorted token multisets (deterministic two-pointer
/// merge; multiplicity-aware).
fn dice_similarity(a: &mut Vec<String>, b: &mut Vec<String>) -> f32 {
    if a.is_empty() || b.is_empty() {
        return 0.0;
    }
    a.sort();
    b.sort();
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

fn score(ground_truth: &str, miner_answer: &str) -> f32 {
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

    let (gt_facts, mut gt_sim) = extract(gt_trim);
    let (ma_facts, mut ma_sim) = extract(ma_trim);

    let text_sim = dice_similarity(&mut gt_sim, &mut ma_sim);

    let gt_weight_total: f32 = gt_facts.iter().map(|f| f.weight()).sum();

    // Fallback: ground truth has no extractable typed facts → pure text
    // similarity (capped so only a verbatim match reaches 1.0).
    if gt_weight_total <= 0.0 {
        return text_sim.clamp(0.0, 0.995);
    }

    // Weighted recall of ground-truth facts found in the miner answer.
    let mut matched_weight = 0.0f32;
    for gf in &gt_facts {
        if ma_facts.iter().any(|mf| facts_match(gf, mf)) {
            matched_weight += gf.weight();
        }
    }
    let recall = matched_weight / gt_weight_total;

    // Anti-gaming precision penalty: distinct hex values / big integers in the
    // answer that contradict (are absent from) the ground truth. A small free
    // allowance keeps normal supporting detail unpenalized.
    let mut extra_units = 0.0f32;
    for mf in &ma_facts {
        if !gt_facts.iter().any(|gf| facts_match(gf, mf)) {
            extra_units += mf.extra_units();
        }
    }
    let excess = (extra_units - 2.0).max(0.0);
    let precision_penalty = 0.5 * excess / (excess + 6.0);

    // Status contradiction penalty: ground truth asserts one status, answer
    // asserts the opposite.
    let gt_status = gt_facts.iter().find_map(|f| match f {
        Fact::Status(s) => Some(*s),
        _ => None,
    });
    let mut status_penalty = 0.0f32;
    if let Some(s) = gt_status {
        let ma_has_correct = ma_facts.iter().any(|f| matches!(f, Fact::Status(x) if *x == s));
        let ma_has_opposite = ma_facts.iter().any(|f| matches!(f, Fact::Status(x) if *x != s));
        if ma_has_opposite {
            status_penalty = if ma_has_correct { 0.05 } else { 0.15 };
        }
    }

    let base = 0.78 * recall + 0.22 * text_sim;
    (base - precision_penalty - status_penalty).clamp(0.0, 0.995)
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/// Rank a miner answer against the ground truth. Returns a score in [0,1].
/// (ptr,len) pairs are UTF-8 strings in fixed order: question, ground_truth,
/// miner_answer. The question is unused — ONCHAIN_TX_LOOKUP is deterministic
/// and the ground truth alone defines correctness.
#[no_mangle]
pub extern "C" fn rank_answer(
    _q_ptr: i32,
    _q_len: i32,
    gt_ptr: i32,
    gt_len: i32,
    ma_ptr: i32,
    ma_len: i32,
) -> f32 {
    let ground_truth = unsafe { read_str(gt_ptr, gt_len) };
    let miner_answer = unsafe { read_str(ma_ptr, ma_len) };
    let s = score(&ground_truth, &miner_answer);
    if s.is_finite() {
        s.clamp(0.0, 1.0)
    } else {
        0.0
    }
}
