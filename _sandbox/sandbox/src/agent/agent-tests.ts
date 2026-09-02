import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { defaultGit, type GitRunner } from "@intentic/scaffold";

/* THE `verify-tests` BUILT-IN: what a turn did to its tests, read when the turn tries to end.
 *
 * A green suite answers one question, does the code pass the tests, and the two ways a model makes that answer
 * worthless both leave it green. It WIDENS an assertion until the failing test passes (`toEqual({…})` becomes
 * `toMatchObject({…})`, an exact string becomes `toContain("9")`), or it writes a test that passes without the
 * change it is meant to cover. On 2026-08-31 eight commits in fifty minutes did the first to about 180 files;
 * the second is the reason agent-test-strength.ts exists. AGENTS.md forbids both, and a paragraph in AGENTS.md is
 * weighed against everything else in the context; a fact about the file just edited, delivered at the Stop, is
 * read.
 *
 * TWO MEASUREMENTS, ONE FOLLOW-UP. For every test file the turn touched (read from the tree, so a file written by
 * a heredoc counts like one written by Edit):
 *
 *   THE RATCHET compares the file's assertions with the same file at HEAD, three numbers each way, exact
 *   matchers, loose matchers, and the characters of literal text the matchers pin down, and reports a file that
 *   got weaker in either of two shapes: a DOWNGRADE (fewer exact, more loose) or a NARROWING (the asserted text
 *   shrank by more than a quarter with no test removed). The same measure the push gate applies to a commit range
 *   (_tools/scripts/assertion-measure.mjs, which says why the vocabulary is what it is); there it refuses an
 *   undeclared weakening, here it tells the model while the model can still act, which is the cheaper moment
 *   by a whole push. The two implementations are held to each other by agent-tests.test.ts.
 *
 *   THE FAULT CHECK re-runs the test with the turn's own source changes served from HEAD and reports a test that
 *   still passes (agent-test-strength.ts). It used to fire on the first edit of each test file, on the first
 *   draft, with a 20-second budget and only where the edit tools could see it; at the Stop it measures the
 *   finished test, every touched one, with the patience this moment already has.
 *
 * IT REPORTS, IT NEVER REFUSES, and the message says which two answers need no work: a test written ahead of its
 * implementation, and a refactor's test that passes either way. Both measurements are heuristics that a reviewer
 * would want to hear about, not verdicts, and a gate here would fight correct work several times for every weak
 * test it caught. */

// What a test file is called, everywhere the daemon asks: the ratchet, the fault check, the first-edit note.
export const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;

/* Said once per turn, on the first edit of a test file, when a `verify-tests` rule stands (rules/turn-ending.ts).
 * Two sentences, at the moment they apply, the same economy the dependency notice keeps: the rules exist in
 * AGENTS.md and are weighed there against everything else in the context; here they are the only thing in the
 * tool result, about the file the model has just opened. */
export const TEST_WRITING_NOTE =
    "Editing a test: derive fixture facts from their source (a schema's default, the tree, the same call the code makes) rather " +
    "than transcribing them, and fix a failing assertion by updating the expected value to the new truth, never by widening the " +
    "matcher. The test files this turn touches are re-read when it ends: an assertion weaker than at HEAD, and a new test that " +
    "passes against the pre-turn code, both come back as a follow-up.";

/* ── the measure, mirrored from _tools/scripts/assertion-measure.mjs ───────────────────────────────────────── */

export interface AssertionMeasure {
    readonly exact: number;
    readonly loose: number;
    readonly chars: number;
    readonly tests: number;
}

export type Weakening = "downgrade" | "narrowing";

// Asserted text that shrinks past this fraction of what it was, with no test removed, is a narrowing.
const NARROWING = 0.75;

const EXACT = new Set([
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
]);
const LOOSE = new Set([
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
]);
const ASYMMETRIC = /\bexpect\.(any|anything|stringContaining|stringMatching|objectContaining|arrayContaining|closeTo)\s*\(/g;
const MATCHER = /\.(to[A-Z][A-Za-z]*)\s*\(/g;
const TEST_CASE = /^\s*(?:test|it)(?:\.(?:each|skip|only|concurrent|todo|fails|skipIf|runIf))?\s*\(/gm;
const QUOTES = new Set(['"', "'", "`"]);

interface Span {
    // The index the scan resumes from: the closing delimiter, or the end of the source.
    readonly end: number;
    readonly chars: number;
}

// A quoted literal opening at `from`. A template literal is cut at its first `${`: what follows is computed, not
// asserted, and the scan resumes at the template's closing quote.
const literalSpan = (source: string, from: number): Span => {
    const quote = source[from];
    let j = from + 1;
    for (; j < source.length && source[j] !== quote; j += 1) {
        if (source[j] === "\\") {
            j += 1;
        } else if (quote === "`" && source[j] === "$" && source[j + 1] === "{") {
            break;
        }
    }
    const end = quote === "`" && source[j] === "$" ? source.indexOf("`", j) : j;
    return { end: end === -1 ? source.length : end, chars: j - from - 1 };
};

// A regex literal opening at `from`: its source is asserted text like a string's.
const regexSpan = (source: string, from: number): Span => {
    let j = from + 1;
    for (; j < source.length && source[j] !== "/" && source[j] !== "\n"; j += 1) {
        if (source[j] === "\\") {
            j += 1;
        }
    }
    return { end: j, chars: j - from - 1 };
};

// A `/` in argument position opens a regex; after an operand it is division, and `//` or `/*` is a comment.
const opensRegex = (source: string, at: number): boolean =>
    source[at] === "/" && /[(,\s=]/.test(source[at - 1] ?? "(") && source[at + 1] !== "/" && source[at + 1] !== "*";

// The literal text a matcher's argument list pins down, from its `(` to the matching `)`. Walked by hand because
// a matcher's argument is routinely a multi-line object with nested calls, which no single regex can bound.
const assertedChars = (source: string, from: number): number => {
    let depth = 0;
    let chars = 0;
    for (let i = from; i < source.length; i += 1) {
        const ch = source[i] ?? "";
        if (ch === "(") {
            depth += 1;
        } else if (ch === ")") {
            depth -= 1;
            if (depth === 0) {
                return chars;
            }
        } else if (QUOTES.has(ch) || opensRegex(source, i)) {
            const span = ch === "/" ? regexSpan(source, i) : literalSpan(source, i);
            chars += span.chars;
            i = span.end;
        }
    }
    return chars;
};

export const measureAssertions = (source: string): AssertionMeasure => {
    let exact = 0;
    let loose = 0;
    let chars = 0;
    for (const match of source.matchAll(MATCHER)) {
        const name = match[1] ?? "";
        if (EXACT.has(name)) {
            exact += 1;
        } else if (LOOSE.has(name)) {
            loose += 1;
        }
        chars += assertedChars(source, match.index + match[0].length - 1);
    }
    loose += [...source.matchAll(ASYMMETRIC)].length;
    const tests = [...source.matchAll(TEST_CASE)].length;
    return { exact, loose, chars, tests };
};

// Weaker, in either of the two shapes the header names. `before` absent (a new file) can only be stronger.
export const weakened = (before: AssertionMeasure | undefined, after: AssertionMeasure): Weakening | undefined => {
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

/* ── the built-in ─────────────────────────────────────────────────────────────────────────────────────────── */

// How many touched test files each measurement reads. The ratchet is a file read and a `git show`, so its cap
// is only against a turn that rewrote a hundred suites; the fault check runs a package's vitest per file, and
// three of those at the Stop is already most of a minute in the slow packages.
const RATCHET_FILES = 20;
const FAULT_FILES = 3;

// The test re-run against HEAD's source: the source files that were restored, or undefined for no finding
// (agent-test-strength.ts passesAgainstHead).
export type FaultCheck = (testFile: string) => Promise<readonly string[] | undefined>;

export interface VerifyTestsDeps {
    // The tree the turn worked in, where git runs and what `changed` is relative to.
    readonly root: string;
    // The paths the tree says the turn changed, root-relative (git/changes.ts dirtyPathsAcross).
    readonly changed: () => Promise<readonly string[]>;
    // Absent ⇒ only the ratchet speaks.
    readonly faults?: FaultCheck | undefined;
    readonly git?: GitRunner | undefined;
    readonly read?: ((path: string) => Promise<string | undefined>) | undefined;
}

const readOrUndefined = (path: string): Promise<string | undefined> => readFile(path, "utf8").catch(() => undefined);

const describeWeakening = (path: string, shape: Weakening, before: AssertionMeasure, after: AssertionMeasure): string =>
    `- ${path} got weaker than at HEAD: ${shape} (exact ${before.exact}→${after.exact}, loose ${before.loose}→${after.loose}, ` +
    `asserted chars ${before.chars}→${after.chars}, tests ${before.tests}→${after.tests}).`;

const describePassing = (path: string, restored: readonly string[]): string =>
    `- ${path} passes against the code as it was before this turn (re-run with ${restored.join(", ")} restored to HEAD): ` +
    `it does not depend on what the change did, and would stay green if that behaviour broke.`;

// One line per touched test file whose assertions are weaker than the same file at HEAD.
const ratchetFindings = async (deps: VerifyTestsDeps, files: readonly string[]): Promise<string[]> => {
    const git = deps.git ?? defaultGit;
    const read = deps.read ?? readOrUndefined;
    const findings: string[] = [];
    for (const path of files) {
        const after = await read(join(deps.root, path));
        // Deleted: a deletion is not a weakening of anything, and review sees it.
        if (after === undefined) {
            continue;
        }
        // No HEAD version means the file is new this turn, which can only be stronger.
        const before = await git(deps.root, ["show", `HEAD:${path}`])
            .then((result) => measureAssertions(result.stdout))
            .catch(() => undefined);
        const now = measureAssertions(after);
        const shape = weakened(before, now);
        if (shape !== undefined && before !== undefined) {
            findings.push(describeWeakening(path, shape, before, now));
        }
    }
    return findings;
};

// One line per touched test file that still passes with the turn's source changes reverted.
const faultFindings = async (faults: FaultCheck, root: string, files: readonly string[]): Promise<string[]> => {
    const findings: string[] = [];
    for (const path of files) {
        const restored = await faults(join(root, path)).catch(() => undefined);
        if (restored !== undefined) {
            findings.push(describePassing(path, restored));
        }
    }
    return findings;
};

// What to do about each kind of finding, said only for the kinds found.
const guidance = (weaker: number, passing: number): string[] => [
    ...(weaker > 0
        ? [
              "A failing test is fixed by updating the value it expects to the new truth, not by widening the matcher. Restore the " +
                  "assertions that got weaker, or say plainly why the weakening is right (a refactor from prose to structure is one honest reason).",
          ]
        : []),
    ...(passing > 0
        ? [
              "A test that passes without the change needs the assertion that would fail without it, usually an exact value at a boundary " +
                  "where the current assertion is relational. Two answers need no work: the implementation is not written yet, or this is a " +
                  "refactor and the test passing either way is the point.",
          ]
        : []),
];

// What this turn should be told about its tests, or nothing: the common answer, and it costs a filter.
export const verifyTestsMessage = async (deps: VerifyTestsDeps): Promise<string | undefined> => {
    const files = (await deps.changed().catch((): readonly string[] => [])).filter((path) => TEST_FILE.test(path));
    if (files.length === 0) {
        return undefined;
    }
    const weaker = await ratchetFindings(deps, files.slice(0, RATCHET_FILES));
    const passing = deps.faults === undefined ? [] : await faultFindings(deps.faults, deps.root, files.slice(0, FAULT_FILES));
    if (weaker.length === 0 && passing.length === 0) {
        return undefined;
    }
    return ["Before finishing, about the test files this turn touched:", ...weaker, ...passing, "", ...guidance(weaker.length, passing.length)].join(
        "\n",
    );
};
