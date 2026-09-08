import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type AssertionMeasure, measureFile, TEST_FILE, type Weakening, weakened } from "@intentic/constants/assertion-measure";
import { defaultGit, type GitRunner } from "@intentic/scaffold";

// verify-tests, read at the Stop: flags a test whose assertions were widened until a failing check passed, or a new
// test that passes without the change it covers. Two measurements report, never refuse: the ratchet (assertion strength
// vs HEAD) and the fault check (re-run with this turn's source reverted, agent-test-strength.ts).


// Shown once per turn, on the first edit of a test file (rules/turn-ending.ts). Kept to two sentences: unlike
// AGENTS.md's rules, this is the only thing in that tool result competing for attention.
export const TEST_WRITING_NOTE =
    "Editing a test: derive fixture facts from their source (a schema's default, the tree, the same call the code makes) rather " +
    "than transcribing them, and fix a failing assertion by updating the expected value to the new truth, never by widening the " +
    "matcher. The test files this turn touches are re-read when it ends: an assertion weaker than at HEAD comes back as a " +
    "follow-up, and so does a new test that passes against the pre-turn code, wherever the suite can be re-run.";


// ── the built-in ──

// Ratchet reads are cheap; the fault check runs a vitest per file, so 3 is most of a minute in slow packages.
const RATCHET_FILES = 20;
const FAULT_FILES = 3;

// Re-runs a test against HEAD's source; returns the restored files, or undefined for no finding.
export type FaultCheck = (testFile: string) => Promise<readonly string[] | undefined>;

export interface VerifyTestsDeps {
    // Tree the turn worked in; git runs here and `changed` is relative to it.
    readonly root: string;
    // Root-relative paths the tree says changed (git/changes.ts dirtyPathsAcross).
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
        // No HEAD means the file is new, only ever stronger; both sides are measured by the file's own language.
        const before = await git(deps.root, ["show", `HEAD:${path}`])
            .then((result) => measureFile(result.stdout, path))
            .catch(() => undefined);
        const now = measureFile(after, path);
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
