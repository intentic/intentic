/* HOW STRONG A TEST FILE'S ASSERTIONS ARE, as three numbers, and whether a second version of the file is weaker.
 *
 * The pure half of the assertion ratchet, shared by the push gate (_tools/scripts/assertion-ratchet.mjs, which
 * runs it over a commit range or the working tree, importing this file by relative path because a pre-push hook
 * runs on a clone that may never have installed) and by the daemon's turn-ending check
 * (_sandbox/sandbox/src/agent/agent-tests.ts, importing it as @intentic/constants/assertion-measure), which asks
 * the same question of the test files a turn touched and tells the model while it can still act. One copy, so
 * the two readers cannot disagree.
 *
 * WHY. On 2026-08-31 eight commits in fifty minutes "relaxed" about 180 test files. `toEqual({ …, message:
 * "Reached Example, authenticated as ada." })` became `toMatchObject({ … })` plus `toContain("ada")`; `"9 of 12
 * files still in your workspace"` became `toContain("9")` and `toContain("12")`; `"Start your first agent"`
 * became `"first agent"`. Every suite stayed green, every gate said yes, and each of those tests can now barely
 * fail. AGENTS.md forbids exactly this ("an assertion that cannot fail is worse than no test") and no linter can
 * enforce it: the shape of a weak `toContain` is the shape of a strong one. What CAN be seen is the direction
 * of travel between two versions of the same file, which is what this measures.
 *
 * THREE NUMBERS PER FILE: EXACT matchers (toBe, toEqual, toStrictEqual, toHaveLength, toHaveBeenCalledWith,
 * snapshots…), LOOSE matchers (toContain, toMatch, toMatchObject, toBeTruthy, toBeGreaterThan, expect.any…), and
 * the characters of literal text the assertions pin down (every string, regex and template run inside a
 * matcher's argument list, comments excluded). A file is weaker in either of two shapes:
 *
 *   · a DOWNGRADE: fewer exact matchers and more loose ones, the `toEqual` → `toMatchObject` move;
 *   · a NARROWING: the asserted text shrinks by more than a quarter while the file keeps as many tests as it had,
 *     the "first agent" move. Tests removed with their text are not a narrowing, and the test count says so.
 *
 * A HEURISTIC, AND SAID TO BE ONE. A refactor that replaces twenty `toBe` lines with one `toEqual` of a whole
 * object reads as fewer exact matchers; a suite that switches from asserting prose to asserting structure reads
 * as narrowing. Both are legitimate, and both are exactly the changes a reviewer should be told about, which is
 * why the gate refuses only an UNDECLARED weakening and the turn-ending check reports rather than refuses.
 *
 * Deliberately regex over source, not an AST: this runs from a pre-push hook on a clone that may never have
 * installed, so it can import nothing, and the matchers it counts are names, which a regex reads as well as a
 * parser does. It cannot see a matcher called through a helper (`expectRow(row).toBe(…)` counts, `check(row)`
 * does not), which is the direction of error that under-reports rather than nags. */

// Asserted text that shrinks past this fraction of what it was, with no test removed, is a narrowing.
export const NARROWING = 0.75;

/* The vocabulary. Exact matchers pin a value; loose ones admit a family of them. `toThrow` and `toHaveProperty`
 * are both depending on their arguments (a message or a value makes them exact) and are counted as neither, so
 * a file that trades between them moves no number. Asymmetric matchers (`expect.any`, `objectContaining`) loosen
 * whatever exact matcher they sit inside, so each one counts as loose. */
export const EXACT = [
    "toBe",
    "toEqual",
    "toStrictEqual",
    "toHaveLength",
    "toHaveBeenCalledWith",
    "toHaveBeenLastCalledWith",
    "toHaveBeenNthCalledWith",
    "toHaveBeenCalledTimes",
    "toHaveBeenCalledOnce",
    "toHaveReturnedWith",
    "toHaveLastReturnedWith",
    "toMatchInlineSnapshot",
    "toMatchSnapshot",
    "toMatchFileSnapshot",
    "toThrowErrorMatchingInlineSnapshot",
    "toThrowErrorMatchingSnapshot",
    "toBeNull",
    "toBeUndefined",
    "toBeNaN",
    "toBeCloseTo",
];
export const LOOSE = [
    "toContain",
    "toContainEqual",
    "toMatch",
    "toMatchObject",
    "toBeTruthy",
    "toBeFalsy",
    "toBeDefined",
    "toBeGreaterThan",
    "toBeGreaterThanOrEqual",
    "toBeLessThan",
    "toBeLessThanOrEqual",
    "toBeInstanceOf",
    "toBeTypeOf",
    "toSatisfy",
    "toHaveBeenCalled",
    "toHaveReturned",
    "toBeOneOf",
];
const exact = new Set(EXACT);
const loose = new Set(LOOSE);
const ASYMMETRIC = /\bexpect\.(any|anything|stringContaining|stringMatching|objectContaining|arrayContaining|closeTo)\s*\(/g;
const MATCHER = /\.(to[A-Z][A-Za-z]*)\s*\(/g;
const TEST_CASE = /^\s*(?:test|it)(?:\.(?:each|skip|only|concurrent|todo|fails|skipIf|runIf))?\s*\(/gm;

/* The literal text a matcher's argument list pins down: from the `(` that opens it to the `)` that closes it,
 * every string literal's characters, every regex's source, and every static run of a template. Walked by hand
 * because a matcher's argument is routinely a multi-line object with nested calls, which no single regex can
 * bound.
 *
 * COMMENTS ARE SKIPPED FIRST, and that is not tidiness. Assertions here are routinely commented one by one,
 * the prose says "the owner's" and "the agent's", and to a walker that reads an apostrophe as an opening quote
 * that comment is a string running to the next apostrophe — over the `)` that closes the matcher, over the
 * tests below it, to the end of the file. The number that came back was not an overcount of one file's text so
 * much as a coin flip on how many apostrophes the prose happened to hold, and editing a comment landed a
 * "narrowing" on a file whose assertions nobody had touched.
 *
 * A TEMPLATE'S STATIC RUNS COUNT, only its `${…}` does not. `${STATE_DIR}/config/safety.md` pins seventeen
 * characters of path and one interpolation, and reading the whole literal as computed made every assertion in
 * a repository that composes its paths from constants — which this one requires, see _tools/checks/path-literals.mjs —
 * look like an assertion about nothing. */
// Past a template's `${…}`, by brace depth: the expression inside is computed, so none of it is asserted text.
const pastInterpolation = (source, from) => {
    let braces = 1;
    let i = from + 2;
    for (; i < source.length && braces > 0; i += 1) {
        braces += source[i] === "{" ? 1 : 0;
        braces -= source[i] === "}" ? 1 : 0;
    }
    return i;
};

// A template literal, from its opening backtick: the characters of its static runs, and where it ends.
const templateChars = (source, from) => {
    let chars = 0;
    let run = from + 1;
    let i = run;
    while (i < source.length && source[i] !== "`") {
        if (source[i] === "\\") {
            i += 2;
        } else if (source[i] === "$" && source[i + 1] === "{") {
            chars += i - run;
            i = pastInterpolation(source, i);
            run = i;
        } else {
            i += 1;
        }
    }
    return { chars: chars + Math.min(i, source.length) - run, end: i };
};

const assertedChars = (source, from) => {
    let depth = 0;
    let chars = 0;
    for (let i = from; i < source.length; i += 1) {
        const ch = source[i];
        if (ch === "/" && source[i + 1] === "/") {
            const end = source.indexOf("\n", i);
            if (end === -1) {
                return chars;
            }
            i = end;
        } else if (ch === "/" && source[i + 1] === "*") {
            const end = source.indexOf("*/", i + 2);
            if (end === -1) {
                return chars;
            }
            i = end + 1;
        } else if (ch === "(") {
            depth += 1;
        } else if (ch === ")") {
            depth -= 1;
            if (depth === 0) {
                return chars;
            }
        } else if (ch === '"' || ch === "'") {
            const quote = ch;
            let j = i + 1;
            for (; j < source.length && source[j] !== quote; j += 1) {
                if (source[j] === "\\") {
                    j += 1;
                }
            }
            chars += j - i - 1;
            i = j;
        } else if (ch === "`") {
            const template = templateChars(source, i);
            chars += template.chars;
            i = template.end;
        } else if (ch === "/" && /[(,\s=]/.test(source[i - 1] ?? "(")) {
            // A regex literal in argument position: its source is asserted text like a string's.
            let j = i + 1;
            for (; j < source.length && source[j] !== "/" && source[j] !== "\n"; j += 1) {
                if (source[j] === "\\") {
                    j += 1;
                }
            }
            chars += j - i - 1;
            i = j;
        }
    }
    return chars;
};

// The three numbers, and the test count that tells a narrowing from a deletion.
export const measure = (source) => {
    let exactCount = 0;
    let looseCount = 0;
    let chars = 0;
    for (const match of source.matchAll(MATCHER)) {
        const name = match[1];
        if (exact.has(name)) {
            exactCount += 1;
        } else if (loose.has(name)) {
            looseCount += 1;
        }
        chars += assertedChars(source, match.index + match[0].length - 1);
    }
    looseCount += [...source.matchAll(ASYMMETRIC)].length;
    const tests = [...source.matchAll(TEST_CASE)].length;
    return { exact: exactCount, loose: looseCount, chars, tests };
};

// Weaker, in either of the two shapes the header names. `before` absent (a new file) can only be stronger.
export const weakened = (before, after) => {
    if (before === undefined) {
        return undefined;
    }
    if (after.exact < before.exact && after.loose > before.loose) {
        return "downgrade";
    }
    if (before.chars > 0 && after.chars < before.chars * NARROWING && after.tests >= before.tests) {
        return "narrowing";
    }
    return undefined;
};

// One line per weakened file, the numbers a reader needs to judge the heuristic for themselves.
export const describeWeakening = (path, shape, before, after) =>
    `${path}: ${shape} (exact ${before.exact}→${after.exact}, loose ${before.loose}→${after.loose}, asserted chars ${before.chars}→${after.chars}, tests ${before.tests}→${after.tests})`;
