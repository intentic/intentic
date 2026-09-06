/* HOW STRONG A TEST FILE'S ASSERTIONS ARE, as three numbers, and whether a second version of the file is weaker.
 *
 * The pure half of the assertion ratchet, shared by the push gate (_tools/scripts/verify/assertion-ratchet.mjs, which
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
 *   · a DOWNGRADE: fewer exact matchers and more loose ones AND no more asserted text than before, the
 *     `toEqual` → `toMatchObject` move. That third clause is what tells the move from its opposite. The move
 *     always SHEDS pinned text — it replaces a whole expected object with a fragment of one — so a file that
 *     ends up pinning more text than it did is doing something else, whatever its matcher mix did. Without the
 *     clause the rule read absolute counts with no sense of scale, and a suite that grew by five tests and 247
 *     characters of expectation was refused for turning one `toEqual({})` — an exact matcher asserting that a
 *     result is EMPTY — into `toMatchObject({ permissionDecision: "deny" })`, which pins a value the old
 *     assertion could not see. One matcher moved from the exact column to the loose one and the file got
 *     stronger. Over the 400 commits before this clause was written it changes exactly one verdict, and that
 *     one was wrong.
 *   · a NARROWING: the asserted text shrinks by more than a quarter while the file keeps as many tests as it had,
 *     the "first agent" move. Tests removed with their text are not a narrowing, and the test count says so.
 *     Deliberately left on absolute ratio with no floor and no exemption for a file whose matcher mix improved:
 *     both were tried against the same 400 commits and both cost more than they bought. A floor big enough to
 *     excuse an 85→52 character file exempts 60% of the repository's test files, because the median test file
 *     pins only 110 characters; and exempting "the exact count went up while the loose count went down" lets a
 *     commit gut six text assertions and buy the exemption with one added `toBe`, which is a real commit
 *     (daf77486) this would then have missed. Of the 62 narrowings in that range, 60 sit on commits whose own
 *     subject says they relaxed assertions. The two that do not are a `toEqual({…})` replaced by
 *     `toBeUndefined()` and a 33-character trim — both worth a reviewer's eye, which is all a flag asks for.
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

/* WHICH FILES THIS IS ASKED ABOUT, one copy for both readers. It lived twice — once in the push gate and once
 * in the daemon's built-in — and the two spellings were identical right up until one of them learned about a
 * second language, at which point the gate and the turn-ending check would have been measuring different sets
 * of files while both claiming to hold the same line.
 *
 * Two conventions, because two ecosystems name their tests: `foo.test.ts` / `foo.spec.tsx`, and pytest's own
 * collection rule, `test_foo.py` / `foo_test.py`. Anything else — a `conftest.py`, a fixture module, a helper
 * beside a suite — is not a test file to the tools that run them and is not one here. */
export const TEST_FILE = /(\.(test|spec)\.[cm]?[jt]sx?|(^|\/)(test_[^/]+|[^/]+_test)\.py)$/;

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

/* ── PYTHON ───────────────────────────────────────────────────────────────────────────────────────────────────
 *
 * The same three numbers, read off a language whose assertions are STATEMENTS rather than matcher calls. What is
 * being measured is identical — how much a file pins down — so the vocabulary is mapped onto the one above
 * rather than invented: `assert a == b` is `toBe`, `assert a in b` is `toContain`, a bare `assert value` is
 * `toBeTruthy`, and `assert x == approx(y)` is loosened by its `approx` the way an `expect.any` loosens the
 * matcher it sits inside. unittest's method names map the same way, and `assertRaises` is counted as neither for
 * the reason `toThrow` is: a message argument makes it exact and no argument makes it loose, so a file that
 * trades between them should move no number.
 *
 * A COMPOUND ASSERT COUNTS AS BOTH. `assert "x" in got and len(got) == 3` is one statement doing two things,
 * and the JS side would have counted it as two matchers; counting it as one or the other here would let a file
 * hide a loosening behind an exact operator on the same line.
 *
 * The one place this reads less than the TypeScript half: an assertion whose comparison is hidden in a helper
 * (`assert_row_matches(row)`) counts as a bare truthiness assert, which is under-reporting, the direction the
 * header already commits to. */
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

/* ONE WALK, TWO OUTPUTS: a copy of the source with every comment and every string's CONTENTS replaced by
 * spaces, and a count of how many characters each string held, by position. Same length as the source, so an
 * offset into one is an offset into the other — which is what lets the operator scan read code that cannot
 * contain a quoted `==`, while the text count reads the strings that scan just blanked.
 *
 * Doing it in one pass, strings and comments together, is the whole point: a `#` inside a string is not a
 * comment and a quote inside a comment does not open a string. The TypeScript half's header records what the
 * other order costs — an apostrophe in a comment swallowing the rest of the file. Triple-quoted strings are
 * tracked because a docstring spans lines and everything after it would otherwise read as code. */
// One string literal, blanked in `code` and counted in `text`: where it ends, so the walk resumes past it. A
// single-quoted string cannot cross a newline — an unterminated one is a syntax error, and stopping at the line
// end keeps one stray quote from blanking the rest of the file.
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

// Where the statement starting at `from` ends: the first newline at bracket depth zero that is not escaped by a
// trailing backslash. Read off the blanked code, so a bracket or a backslash inside a string cannot extend it.
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

// The `assert` statements: one classification per statement, by the operators it uses.
const assertStatements = (code, text) => {
    const totals = { exact: 0, loose: 0, chars: 0 };
    for (const match of code.matchAll(PY_ASSERT)) {
        const end = statementEnd(code, match.index);
        const statement = code.slice(match.index, end);
        const isExact = PY_EXACT_OP.test(statement);
        // No operator at all is a bare truthiness assert, which admits every value that is not falsy.
        totals.exact += isExact ? 1 : 0;
        totals.loose += PY_LOOSE_OP.test(statement) || !isExact ? 1 : 0;
        totals.chars += charsIn(text, match.index, end);
    }
    return totals;
};

// unittest's assertion methods: classified by name, like a matcher.
const assertMethods = (code, text) => {
    const totals = { exact: 0, loose: 0, chars: 0 };
    for (const match of code.matchAll(PY_METHOD)) {
        const name = match[0].slice(0, match[0].search(/\s*\(/));
        // A name in neither set is one this deliberately counts as neither (assertRaises), or a project's own
        // helper. Its text is not counted either: nothing here knows what it pins.
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

/* THE ENTRY POINT BOTH READERS CALL. Which measure a file gets is decided here, once, from its name: the push
 * gate and the turn-ending check must never disagree about what a file's numbers mean. A test file this cannot
 * recognise gets the TypeScript measure, which reads a foreign language as zero of everything — no matchers, no
 * asserted text — and `weakened` then finds nothing, so an unknown language is silently unmeasured rather than
 * loudly wrong. */
export const measureFile = (source, path) => (path.endsWith('.py') ? measurePython(source) : measure(source));

// Weaker, in either of the two shapes the header names. `before` absent (a new file) can only be stronger.
export const weakened = (before, after) => {
    if (before === undefined) {
        return undefined;
    }
    // The third clause is the scale the first two have none of: see the header. A file that pins MORE text than
    // it did is not making the `toEqual` → `toMatchObject` move, whichever way its matcher counts went.
    if (after.exact < before.exact && after.loose > before.loose && after.chars <= before.chars) {
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
