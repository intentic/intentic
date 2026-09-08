// Costs are tokens, not lines: stripping comments shrinks line count while densifying what remains, which lines can't
// see. A character-driven estimator, calibrated (`nav calibrate`) to stay within real BPE's characters-per-token band;
// an absolute count is order-of-magnitude, a delta is real.

// Digraphs/trigraphs a code vocabulary carries as one token; not exhaustive, missing one costs one token.
const GLUED = new Set([
    "=>",
    "==",
    "===",
    "!=",
    "!==",
    "<=",
    ">=",
    "&&",
    "||",
    "??",
    "?.",
    "::",
    "++",
    "--",
    "+=",
    "-=",
    "*=",
    "/=",
    "%=",
    "**",
    "//",
    "/*",
    "*/",
    "<>",
    "</",
    "/>",
    "${",
    "){",
    "()",
    "[]",
    "{}",
    "();",
    ");",
    "};",
    "});",
    "()=>",
    "...",
    "?:",
    "|>",
    "->",
    "<<",
    ">>",
    "&=",
    "|=",
    "^=",
]);

// One identifier sub-word: short ones are one token, longer ones chop into ~6-char pieces, mimicking BPE.
const subWordTokens = (word) => (word.length <= 7 ? 1 : 1 + Math.ceil((word.length - 7) / 6));

// Splits camelCase/PascalCase/snake_case/SCREAMING_CASE into vocabulary-sized pieces (`getUserById` → 3, not 1 or 11).
const splitIdentifier = (identifier) =>
    identifier
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
        .split(/[\s_$]+/u)
        .filter(Boolean);

// The estimator: one linear pass, no per-character allocation, no regex backtracking.
export const estimateTokens = (text) => {
    let tokens = 0;
    let index = 0;
    const length = text.length;

    while (index < length) {
        const char = text[index];

        // Horizontal whitespace run: merges like BPE indentation (4 spaces ≈ 1 token); a lone space costs nothing.
        if (char === " " || char === "\t") {
            let run = 0;
            while (index < length && (text[index] === " " || text[index] === "\t")) {
                run += 1;
                index += 1;
            }
            tokens += run <= 1 ? 0 : Math.ceil(run / 4);
            continue;
        }

        // A newline run merges the same way an indentation run does, one token per two newlines.
        if (char === "\n" || char === "\r") {
            let run = 0;
            while (index < length && (text[index] === "\n" || text[index] === "\r")) {
                run += 1;
                index += 1;
            }
            tokens += Math.ceil(run / 2);
            continue;
        }

        // Identifiers and keywords.
        if (/[A-Za-z_$]/u.test(char)) {
            let end = index;
            while (end < length && /[A-Za-z0-9_$]/u.test(text[end])) {
                end += 1;
            }
            for (const part of splitIdentifier(text.slice(index, end))) {
                tokens += subWordTokens(part);
            }
            index = end;
            continue;
        }

        // Numbers, including hex, exponents and separators: one token unless very long.
        if (/[0-9]/u.test(char)) {
            let end = index;
            while (end < length && /[0-9a-fA-FxXoObB._]/u.test(text[end])) {
                end += 1;
            }
            tokens += Math.max(1, Math.ceil((end - index) / 4));
            index = end;
            continue;
        }

        // Punctuation, longest glued sequence first.
        const four = text.slice(index, index + 4);
        const three = text.slice(index, index + 3);
        const two = text.slice(index, index + 2);
        if (GLUED.has(four)) {
            tokens += 1;
            index += 4;
        } else if (GLUED.has(three)) {
            tokens += 1;
            index += 3;
        } else if (GLUED.has(two)) {
            tokens += 1;
            index += 2;
        } else {
            tokens += 1;
            index += 1;
        }
    }

    return tokens;
};

// The real tokenizer, loaded lazily and by name so a checkout without it never hits an import error.
let realEncoder;
const loadReal = async () => {
    if (realEncoder !== undefined) {
        return realEncoder;
    }
    try {
        const mod = await import("gpt-tokenizer/model/gpt-4o");
        realEncoder = (text) => mod.encode(text).length;
    } catch {
        realEncoder = null;
    }
    return realEncoder;
};

// Picks a counter for this run; returns the function and the label recorded in the output, so a number's tokenizer is
// always known later.
export const tokenCounter = async () => {
    if (process.env.NAV_TOKENIZER === "real") {
        const real = await loadReal();
        if (real) {
            return { count: real, label: "gpt-tokenizer/o200k_base" };
        }
        process.stderr.write("nav: NAV_TOKENIZER=real but gpt-tokenizer is not installed; using the estimator\n");
    }
    return { count: estimateTokens, label: "estimator/v1" };
};
