// Tokens without a tokenizer. One pass over the text splits it the way o200k_base's pre-tokenizer does: a word with
// the space or punctuation before it, digits in threes, a punctuation run, a whitespace run. Each piece is then priced by
// its kind and length. The prices are o200k_base's own counts per piece, fitted by least squares over 12 MB of what the
// product's budgets count: webq and fileq markdown, Bash output (ls, logs, JSON, test runs, diffs, base64), and source.
// 2026-11-26: on held-out text it is within 4% of o200k_base on average and 8% on the worst content type, and within 4%
// on minified bundles it never saw. Four characters to a token was 18% off on average, 30% under on `ls` and 61% under
// on base64; nav's code estimator was 31% off. o200k_base is the public reference; Claude's own tokenizer is not
// published, so a count here is a close estimate for it, not its exact one. A piece is never split by the price, so a
// cut at a piece boundary is a cut the estimate agrees with.
//
// Self-contained on purpose: nav's .mjs loads this file directly, and output-cleaners keeps a build-step-free copy
// (src/token-estimate.mjs) that its tests hold to this one.

// Character classes.
const PUNCT = 0;
const UPPER = 1;
const LOWER = 2;
const DIGIT = 3;
const SPACE = 4;
const NEWLINE = 5;
// CJK, kana and hangul: about three quarters of a token each.
const DENSE = 6;
// Arrows, check marks, box drawing, emoji.
const SYMBOL = 7;
// Accented Latin (ą, é, ß).
const ACCENTED = 8;
// The second half of a surrogate pair, which rides with the first.
const TRAIL = 9;
// Letters of another alphabet: Greek, Cyrillic, Armenian, Hebrew, Arabic, Indic.
const SCRIPT = 10;
const END = -1;

// Prices, fitted to o200k_base's count per piece.
// A word this long or shorter is one token.
const WORD_FREE = 6;
// Each letter past that.
const WORD_STEP = 0.09;
// A piece with nothing before it (the second half of `getUser`) splits a little more often, a Capitalized one too.
const BARE_WORD = 0.1;
const CAPITALIZED = 0.12;
// A word behind punctuation (`.map`, `_id`, `"key`), and per letter of it.
const GLUED_WORD = 0.07;
const GLUED_STEP = 0.06;
// Per letter past the first of an ALL-CAPS piece, and of one after a space or punctuation.
const CAPS_STEP = 0.16;
const CAPS_SPACED_STEP = 0.1;
// Per letter past the first of a mixed-case piece (`HTTPServer`, `IDs`).
const MIXED_STEP = 0.25;
// Per letter past the first of a CAPS or mixed piece glued to a letter or digit: base64, hex, hashes.
const NOISE_STEP = 0.46;
// Per letter of these, on top of the word.
const ACCENTED_LETTER = 0.74;
const SCRIPT_LETTER = 0.11;
const DENSE_CHAR = 0.76;
// A run of mixed punctuation this long is one token, and each character past it costs this.
const PUNCT_FREE = 2;
const PUNCT_STEP = 0.11;
// Each symbol past the first in a run.
const SYMBOL_STEP = 0.2;
// Runs of one repeated character (`--------`, `════`) are vocabulary of their own.
const REPEAT_RUN = 64;
const REPEAT_SYMBOL_RUN = 8;
const SPACE_RUN = 100;

// Every UTF-16 code unit's class, built once (64 KB): one lookup per character in the pass.
const WIDE_RANGES: readonly (readonly [number, number, number])[] = [
    [0x85, 0x85, NEWLINE],
    [0xa0, 0xa0, SPACE],
    [0xaa, 0xaa, ACCENTED],
    [0xb5, 0xb5, ACCENTED],
    [0xba, 0xba, ACCENTED],
    [0xc0, 0xd6, ACCENTED],
    [0xd8, 0xf6, ACCENTED],
    [0xf8, 0x24f, ACCENTED],
    [0x370, 0x52f, SCRIPT],
    [0x531, 0x58f, SCRIPT],
    [0x5d0, 0x6ff, SCRIPT],
    [0x900, 0xdff, SCRIPT],
    [0x1e00, 0x1eff, ACCENTED],
    [0x1f00, 0x1fff, SCRIPT],
    [0x2000, 0x200a, SPACE],
    [0x2028, 0x2029, NEWLINE],
    [0x202f, 0x202f, SPACE],
    [0x205f, 0x205f, SPACE],
    [0x3000, 0x3000, SPACE],
    [0x3040, 0x30ff, DENSE],
    [0x3400, 0x9fff, DENSE],
    [0xac00, 0xd7af, DENSE],
    [0xdc00, 0xdfff, TRAIL],
    [0xf900, 0xfaff, DENSE],
    [0xff66, 0xffdc, DENSE],
];

const asciiClass = (code: number): number => {
    if (code >= 65 && code <= 90) {
        return UPPER;
    }
    if (code >= 97 && code <= 122) {
        return LOWER;
    }
    if (code >= 48 && code <= 57) {
        return DIGIT;
    }
    if (code === 10 || code === 13) {
        return NEWLINE;
    }
    return code === 32 || code === 9 || code === 11 || code === 12 ? SPACE : PUNCT;
};

const CLASSES = new Uint8Array(0x10000).fill(SYMBOL);
for (let code = 0; code < 128; code += 1) {
    CLASSES[code] = asciiClass(code);
}
for (const [low, high, kind] of WIDE_RANGES) {
    CLASSES.fill(kind, low, high + 1);
}

const classAt = (text: string, index: number): number => (index < 0 || index >= text.length ? END : (CLASSES[text.charCodeAt(index)] ?? SYMBOL));

const isLetter = (kind: number): boolean => kind === UPPER || kind === LOWER || kind === DENSE || kind === ACCENTED || kind === SCRIPT;
const isLowerish = (kind: number): boolean => kind === LOWER || kind === DENSE || kind === ACCENTED || kind === SCRIPT;
const isPunct = (kind: number): boolean => kind === PUNCT || kind === SYMBOL || kind === TRAIL;

// The piece just read: where it ends and what it costs. One object reused for every piece, so the pass allocates
// nothing per piece; every reader below fills both fields.
const piece = { end: 0, cost: 0 };

// The letters of a word, by shape: a lowercase or Capitalized word is one token up to WORD_FREE letters.
const letterCost = (length: number, uppers: number, prefixed: boolean, stuck: boolean): number => {
    const lowers = length - uppers;
    if (length === 0) {
        return 0;
    }
    if (stuck && uppers > 0 && (lowers === 0 || uppers > 1)) {
        return 1 + (length - 1) * NOISE_STEP;
    }
    if (lowers === 0) {
        return 1 + (length - 1) * (prefixed ? CAPS_SPACED_STEP : CAPS_STEP);
    }
    if (uppers > 1) {
        return 1 + (length - 1) * MIXED_STEP;
    }
    return 1 + Math.max(0, length - WORD_FREE) * WORD_STEP + (prefixed ? 0 : BARE_WORD) + (uppers === 1 ? CAPITALIZED : 0);
};

// The letters of the word being read, by kind; filled by readLetters, like `piece`.
const letters = { uppers: 0, dense: 0, accented: 0, script: 0 };

// Capitals followed by lowercase, or capitals alone (`HTTPServer` is one piece, `getUserById` is four). Returns where
// the letters end.
const readLetters = (text: string, start: number): number => {
    letters.uppers = 0;
    letters.dense = 0;
    letters.accented = 0;
    letters.script = 0;
    let index = start;
    let kind = classAt(text, index);
    while (kind === UPPER || kind === DENSE) {
        letters.uppers += kind === UPPER ? 1 : 0;
        letters.dense += kind === DENSE ? 1 : 0;
        index += 1;
        kind = classAt(text, index);
    }
    if (letters.uppers > 0 && !isLowerish(kind)) {
        return index;
    }
    while (isLowerish(kind)) {
        letters.dense += kind === DENSE ? 1 : 0;
        letters.accented += kind === ACCENTED ? 1 : 0;
        letters.script += kind === SCRIPT ? 1 : 0;
        index += 1;
        kind = classAt(text, index);
    }
    return index;
};

// A word with the one character before it, if any: a space is free, punctuation costs a little.
const readWord = (text: string, start: number, first: number): void => {
    const prefixed = !isLetter(first);
    const glued = prefixed && text.charCodeAt(start) !== 32;
    const before = classAt(text, start - 1);
    const stuck = !prefixed && (isLetter(before) || before === DIGIT);
    const bodyStart = prefixed ? start + 1 : start;
    const end = readLetters(text, bodyStart);
    const length = end - bodyStart - letters.dense;
    const cost =
        letterCost(length, letters.uppers, prefixed, stuck) +
        letters.dense * DENSE_CHAR +
        letters.accented * ACCENTED_LETTER +
        letters.script * SCRIPT_LETTER;
    piece.end = end;
    piece.cost = Math.max(1, cost) + (glued ? GLUED_WORD + length * GLUED_STEP : 0);
};

// Up to three digits, one token.
const readNumber = (text: string, start: number): void => {
    let index = start + 1;
    while (index < start + 3 && classAt(text, index) === DIGIT) {
        index += 1;
    }
    piece.end = index;
    piece.cost = 1;
};

// A punctuation run with the one space before it, and the newlines after it.
const readPunct = (text: string, start: number, first: number): void => {
    let index = first === SPACE ? start + 1 : start;
    const head = text.charCodeAt(index);
    let plain = 0;
    let symbols = 0;
    let same = true;
    let kind = classAt(text, index);
    while (isPunct(kind)) {
        same &&= text.charCodeAt(index) === head;
        plain += kind === PUNCT ? 1 : 0;
        symbols += kind === SYMBOL ? 1 : 0;
        index += 1;
        kind = classAt(text, index);
    }
    while (kind === NEWLINE) {
        index += 1;
        kind = classAt(text, index);
    }
    piece.end = index;
    if (same && plain + symbols > 1) {
        piece.cost = plain > 0 ? 1 + Math.floor(plain / REPEAT_RUN) : Math.ceil(symbols / REPEAT_SYMBOL_RUN);
        return;
    }
    piece.cost = 1 + Math.max(0, plain - PUNCT_FREE) * PUNCT_STEP + Math.max(0, symbols - (plain > 0 ? 0 : 1)) * SYMBOL_STEP;
};

// Whitespace through its last newline is one piece. A run of spaces without one gives its last space to the word or
// punctuation after it.
const readSpace = (text: string, start: number): void => {
    let index = start;
    let lastNewline = -1;
    for (let kind = classAt(text, index); kind === SPACE || kind === NEWLINE; kind = classAt(text, index)) {
        lastNewline = kind === NEWLINE ? index : lastNewline;
        index += 1;
    }
    if (lastNewline >= 0) {
        piece.end = lastNewline + 1;
        piece.cost = 1;
        return;
    }
    piece.end = index - start >= 2 && index < text.length ? index - 1 : index;
    piece.cost = 1 + Math.floor((piece.end - start) / SPACE_RUN);
};

const readPiece = (text: string, start: number): void => {
    const kind = classAt(text, start);
    const next = classAt(text, start + 1);
    if (isLetter(kind) || ((kind === PUNCT || kind === SPACE || kind === SYMBOL) && isLetter(next))) {
        readWord(text, start, kind);
    } else if (kind === DIGIT) {
        readNumber(text, start);
    } else if (isPunct(kind) || (text.charCodeAt(start) === 32 && (next === PUNCT || next === SYMBOL))) {
        readPunct(text, start, kind);
    } else {
        readSpace(text, start);
    }
};

interface Scanned {
    readonly tokens: number;
    // Where the walk stopped: the text's length, or the start of the first piece that did not fit.
    readonly end: number;
}

// Walks piece by piece until the next one would take the count past `budget`.
const scan = (text: string, budget: number): Scanned => {
    let tokens = 0;
    let index = 0;
    while (index < text.length) {
        readPiece(text, index);
        if (tokens + piece.cost > budget) {
            break;
        }
        tokens += piece.cost;
        index = piece.end;
    }
    return { tokens, end: index };
};

// The estimate: the prices are averages, so the sum is rounded to the nearest token, and any text costs at least one.
export const estimateTokens = (text: string): number => (text === "" ? 0 : Math.max(1, Math.round(scan(text, Number.POSITIVE_INFINITY).tokens)));

// The longest prefix of `text` the estimate puts at `budget` tokens or fewer, cut between pieces (never inside a word,
// a number or a surrogate pair), in one pass: the whole text when estimateTokens says it fits, and otherwise a prefix
// whose estimate is at most `budget`. The half token is estimateTokens' rounding, so the two never disagree.
export const sliceToTokens = (text: string, budget: number): string => {
    const { end } = scan(text, Math.max(0, budget) + 0.5 - 1e-9);
    return end >= text.length ? text : text.slice(0, end);
};
