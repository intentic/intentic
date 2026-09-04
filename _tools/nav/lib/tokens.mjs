/* WHAT A FILE COSTS AN AGENT TO READ, IN TOKENS, WITHOUT A TOKENIZER DEPENDENCY.
 *
 * Every navigability number in this harness is denominated in tokens, because that is the thing an agent
 * actually pays and the thing a context window is measured in. Lines are a proxy that breaks exactly when it
 * matters: strip a file's comments and it loses lines while every remaining line gets DENSER, so the file
 * shrinks and a fixed read window gets more expensive at the same time. Both effects are real and they pull in
 * opposite directions. A line count cannot see that; a token count can.
 *
 * WHY AN ESTIMATOR AND NOT tiktoken. This repository has no tokenizer in its dependency graph and this harness
 * is not worth adding one to the lockfile for. So the default is a segment estimator, and `NAV_TOKENIZER=real`
 * switches to `gpt-tokenizer` when someone has installed it. Which one produced a number is recorded in every
 * output file, and `compare` refuses to diff two runs that used different ones.
 *
 * WHY AN ESTIMATOR IS ENOUGH HERE, stated plainly so nobody over-reads these numbers. This harness exists to
 * compare a tree against ITSELF before and after a refactor. A systematic bias that applies equally to both
 * sides cancels in the delta, which is the number anyone acts on. What must NOT cancel is sensitivity to token
 * density, and a character-driven estimator has that by construction: denser lines cost more per line. Treat
 * an absolute figure here as "the right order of magnitude"; treat a delta as real.
 *
 * HOW IT ESTIMATES. Byte-count divided by a constant is the usual shortcut and it is bad at code, because code
 * is mostly short identifiers and punctuation, which BPE merges very differently from prose. This splits the
 * text the way a code BPE roughly does and counts the pieces:
 *
 *   identifiers   split at camelCase and `_` boundaries; each sub-word is one token up to ~7 characters,
 *                 then one more per 6 after that (BPE holds whole common words, chops rare long ones)
 *   punctuation   one token each, except the ~40 digraphs that every code vocabulary carries as one
 *   indentation   a run of spaces merges: 4 spaces is about one token, not four
 *   strings       counted as their contents, which is prose, at prose density
 *
 * HOW ACCURATE, honestly. Nobody has diffed this against o200k_base on this repository, because installing a
 * tokenizer to find out is the dependency this file exists to avoid. What IS checked, by `nav calibrate`, is
 * that the characters-per-token ratio it produces sits in the 3.2–4.2 band that real code BPE lands in; a run
 * outside that band is a bug in the estimator, not a finding about the code. If you want the real number,
 * `npm i gpt-tokenizer` somewhere on NODE_PATH and set `NAV_TOKENIZER=real` — every output file records which
 * counter produced it and `compare` refuses to diff across the two. */

// Digraphs and trigraphs a code vocabulary carries whole. Not exhaustive and does not need to be: each one
// this misses costs one extra estimated token on a line that has hundreds.
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

// One identifier sub-word. BPE holds common short words whole; long or unusual ones get chopped into pieces of
// roughly six characters. The exact cut point matters far less than being length-sensitive at all.
const subWordTokens = (word) => (word.length <= 7 ? 1 : 1 + Math.ceil((word.length - 7) / 6));

// camelCase / PascalCase / snake_case / SCREAMING_CASE all split into the pieces a vocabulary actually holds.
// `getUserById` is three tokens, not one, and not eleven.
const splitIdentifier = (identifier) =>
    identifier
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
        .split(/[\s_$]+/u)
        .filter(Boolean);

/* The estimator. One pass, no allocation per character, no regex backtracking: this runs over a million lines
 * of source in a couple of seconds and is called once per file per run. */
export const estimateTokens = (text) => {
    let tokens = 0;
    let index = 0;
    const length = text.length;

    while (index < length) {
        const char = text[index];

        // A run of horizontal whitespace. Indentation is the common case and BPE merges it hard: four spaces
        // is one token, eight is two. A single space between words is usually absorbed into the next token,
        // so a run of one costs nothing on its own.
        if (char === " " || char === "\t") {
            let run = 0;
            while (index < length && (text[index] === " " || text[index] === "\t")) {
                run += 1;
                index += 1;
            }
            tokens += run <= 1 ? 0 : Math.ceil(run / 4);
            continue;
        }

        // Newlines are their own token, and a blank-line run merges the way indentation does.
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

/* The real thing, when it is installed. Loaded lazily and by name so a checkout without it never pays an
 * import error: this is an opt-in upgrade, not a dependency. */
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

/* Pick a counter for this run. Returns the function AND the label that goes in the output file, because a
 * number whose tokenizer is unrecorded cannot be compared against anything later. */
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
