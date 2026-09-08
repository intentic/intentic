// Three numbers per test file (exact matchers, loose matchers, asserted-text characters) that flag a weaker second
// version; shared by the push gate and the daemon's turn-ending check so both agree. Regex over source, not an AST,
// since the push gate runs before install.

// Asserted text that shrinks past this fraction of what it was, with no test removed, is a narrowing.
export const NARROWING = 0.75;

// Test file naming this ratchet knows: `foo.test.ts`/`foo.spec.tsx`, or pytest's `test_foo.py`/`foo_test.py`.
export const TEST_FILE = /(\.(test|spec)\.[cm]?[jt]sx?|(^|\/)(test_[^/]+|[^/]+_test)\.py)$/;

// toThrow/toHaveProperty count as neither (an argument makes them exact); expect.any always counts as loose.
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

// Text a matcher's argument list pins, walked by hand (args can be multi-line, nested calls). Comments are stripped
// first so a comment's apostrophe can't read as an open quote; a template's static runs count, its `${…}` does not.
// Skips past a template's `${…}` by brace depth; the expression inside is computed, not asserted text.
const pastInterpolation = (source, from) => {
    let braces = 1;
    let i = from + 2;
    for (; i < source.length && braces > 0; i += 1) {
        braces += source[i] === "{" ? 1 : 0;
        braces -= source[i] === "}" ? 1 : 0;
    }
    return i;
};

// A template literal from its opening backtick: the character count of its static runs, and where it ends.
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
            // A regex literal in argument position; its source counts as asserted text like a string's.
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

// Same three numbers over Python's `assert` statements and unittest methods, mapped onto the same vocabulary (`==`/`is`
// exact, `in`/comparisons/bare assert loose, `approx(...)` loosens). A compound assert counts toward both exact and
// loose. assertRaises counts as neither, like toThrow.
export const PY_EXACT = [
    "assertEqual",
    "assertNotEqual",
    "assertIs",
    "assertIsNot",
    "assertIsNone",
    "assertIsNotNone",
    "assertListEqual",
    "assertDictEqual",
    "assertSetEqual",
    "assertTupleEqual",
    "assertSequenceEqual",
    "assertMultiLineEqual",
    "assertCountEqual",
    "assertAlmostEqual",
];
export const PY_LOOSE = [
    "assertTrue",
    "assertFalse",
    "assertIn",
    "assertNotIn",
    "assertIsInstance",
    "assertNotIsInstance",
    "assertGreater",
    "assertGreaterEqual",
    "assertLess",
    "assertLessEqual",
    "assertRegex",
    "assertNotRegex",
    "assertWarns",
    "assertLogs",
];
const pyExact = new Set(PY_EXACT);
const pyLoose = new Set(PY_LOOSE);

const PY_EXACT_OP = /==|!=|\bis\b/;
const PY_LOOSE_OP = /\bin\b|<=|>=|<|>|\bisinstance\s*\(|\bapprox\s*\(/;
const PY_ASSERT = /^[ \t]*assert\b/gm;
const PY_METHOD = /\bassert[A-Z][A-Za-z]*\s*\(/g;
const PY_TEST_CASE = /^[ \t]*(?:async\s+)?def\s+test\w*\s*\(/gm;

// One pass blanks every comment and string's contents (same length as source, so offsets line up) and counts each
// string's characters by position. Must be one pass: a `#` inside a string is not a comment and a quote inside a
// comment doesn't open a string; triple-quoted strings are tracked since a docstring spans lines.
// Blanks one string literal in `code`, counts its characters in `text`, and returns where it ends. A single-quoted
// string stops at the next newline so one stray quote can't blank the rest of the file.
const blankString = (source, code, text, start) => {
    const ch = source[start];
    const quote = source.startsWith(ch.repeat(3), start) ? ch.repeat(3) : ch;
    let i = start + quote.length;
    while (i < source.length && !source.startsWith(quote, i)) {
        if (quote.length === 1 && source[i] === "\n") {
            return i;
        }
        text[i] = 1;
        code[i] = " ";
        i += source[i] === "\\" ? 2 : 1;
    }
    return Math.min(i + quote.length - 1, source.length - 1);
};

const blankComment = (source, code, start) => {
    let i = start;
    while (i < source.length && source[i] !== "\n") {
        code[i] = " ";
        i += 1;
    }
    return i;
};

const blankPython = (source) => {
    const code = [...source];
    const text = new Uint8Array(source.length);
    for (let i = 0; i < source.length; i += 1) {
        const ch = source[i];
        if (ch === "#") {
            i = blankComment(source, code, i);
        } else if (ch === '"' || ch === "'") {
            i = blankString(source, code, text, i);
        }
    }
    return { code: code.join(""), text };
};

const OPENERS = new Set(["(", "[", "{"]);
const CLOSERS = new Set([")", "]", "}"]);

// End of the statement starting at `from`: first newline at bracket depth zero, not escaped by a trailing backslash.
// Reads the blanked code, so a bracket or backslash inside a string can't extend it.
const statementEnd = (code, from) => {
    let depth = 0;
    for (let i = from; i < code.length; i += 1) {
        const ch = code[i];
        depth += OPENERS.has(ch) ? 1 : 0;
        depth -= CLOSERS.has(ch) ? 1 : 0;
        const ends = ch === "\n" && depth <= 0 && code[i - 1] !== "\\";
        if (ends) {
            return i;
        }
    }
    return code.length;
};

const charsIn = (text, from, to) => {
    let chars = 0;
    for (let i = from; i < to; i += 1) {
        chars += text[i];
    }
    return chars;
};

// Classifies each `assert` statement by the operators it uses.
const assertStatements = (code, text) => {
    const totals = { exact: 0, loose: 0, chars: 0 };
    for (const match of code.matchAll(PY_ASSERT)) {
        const end = statementEnd(code, match.index);
        const statement = code.slice(match.index, end);
        const isExact = PY_EXACT_OP.test(statement);
        // No operator at all is a bare truthiness assert; it admits anything that is not falsy.
        totals.exact += isExact ? 1 : 0;
        totals.loose += PY_LOOSE_OP.test(statement) || !isExact ? 1 : 0;
        totals.chars += charsIn(text, match.index, end);
    }
    return totals;
};

// unittest's assertion methods, classified by name like a matcher.
const assertMethods = (code, text) => {
    const totals = { exact: 0, loose: 0, chars: 0 };
    for (const match of code.matchAll(PY_METHOD)) {
        const name = match[0].slice(0, match[0].search(/\s*\(/));
        // A name in neither set (assertRaises, a project helper) counts as neither, and its text is not counted.
        if (!pyExact.has(name) && !pyLoose.has(name)) {
            continue;
        }
        totals.exact += pyExact.has(name) ? 1 : 0;
        totals.loose += pyLoose.has(name) ? 1 : 0;
        totals.chars += charsIn(text, match.index, statementEnd(code, match.index));
    }
    return totals;
};

export const measurePython = (source) => {
    const { code, text } = blankPython(source);
    const statements = assertStatements(code, text);
    const methods = assertMethods(code, text);
    return {
        exact: statements.exact + methods.exact,
        loose: statements.loose + methods.loose,
        chars: statements.chars + methods.chars,
        tests: [...code.matchAll(PY_TEST_CASE)].length,
    };
};

// Decides which measure a file gets, by extension, so both readers agree. An unrecognized file falls to the TypeScript
// measure, which reads it as zero of everything, so it's silently unmeasured rather than wrongly flagged.
export const measureFile = (source, path) => (path.endsWith('.py') ? measurePython(source) : measure(source));

// Weaker, in either of the two shapes measured. A new file, with no before, can only be stronger.
export const weakened = (before, after) => {
    if (before === undefined) {
        return undefined;
    }
    // More text pinned than before rules out a toEqual→toMatchObject move, whatever the matcher counts did.
    if (after.exact < before.exact && after.loose > before.loose && after.chars <= before.chars) {
        return "downgrade";
    }
    if (before.chars > 0 && after.chars < before.chars * NARROWING && after.tests >= before.tests) {
        return "narrowing";
    }
    return undefined;
};

// One line per weakened file, with the numbers a reader needs to judge the heuristic themselves.
export const describeWeakening = (path, shape, before, after) =>
    `${path}: ${shape} (exact ${before.exact}→${after.exact}, loose ${before.loose}→${after.loose}, asserted chars ${before.chars}→${after.chars}, tests ${before.tests}→${after.tests})`;
