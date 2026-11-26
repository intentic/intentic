import type { CiLocalMain } from "@intentic/sandbox-contract/schemas/ci";

/* WHAT THIS SANDBOX'S OWN TEST RUNS SAW FAIL AT MAIN, in the words `agents ci` prints below what main's CI is known to fail
   on (GET /ci/main/local). 2026-11-19: `agents ci` said "nothing known to fail" while sixteen tests failed on main, in
   suites CI does not run; the output filter records every test run, and one on a clean tree at a main commit is that
   commit's baseline (output-cleaners' test-outcomes.mjs). The record is the sandbox's own, under the history root, so
   this half stayed in the core when main's CI half moved to the pipelines extension (2026-11-26), which asks for these
   words and prints them after its own. */

// Enough of a commit for `git merge-base --is-ancestor` to find it.
const SHA_CHARS = 10;
// How many of one commit's failing tests the words name before counting the rest.
const LOCAL_SHOWN = 20;

const ago = (ms: number): string => {
    const minutes = Math.max(0, Math.round(ms / 60_000));
    if (minutes < 60) {
        return `${minutes}m`;
    }
    const hours = Math.round(minutes / 60);
    return hours < 48 ? `${hours}h` : `${Math.round(hours / 24)}d`;
};

const when = (at: number, now: number): string => `${new Date(at).toISOString().slice(0, 16).replace("T", " ")} UTC (${ago(now - at)} ago)`;

const localRepoLines = (local: CiLocalMain, now: number): string[] => {
    const newest = local.runs[0];
    const by = newest?.by === undefined ? "" : ` by ${newest.by}`;
    const head = `${local.repo} · main@${local.sha.slice(0, SHA_CHARS)}: ${local.runs.length} run${local.runs.length === 1 ? "" : "s"} there, newest \`${newest?.command ?? ""}\`${by}, ${when(local.at, now)}`;
    if (local.failed.length === 0) {
        return [`${head}; none failed a test.`];
    }
    const more = local.failed.length > LOCAL_SHOWN ? [`    … and ${local.failed.length - LOCAL_SHOWN} more`] : [];
    const failed = local.failed.slice(0, LOCAL_SHOWN).map((failure) => `    - ${failure.test}${failure.line === undefined ? "" : ` — ${failure.line}`}`);
    return [`${head}; failing:`, ...failed, ...more];
};

/** The words for what the recorded runs saw fail at main commits, opening with a blank line; empty when none is recorded. */
export const localMainText = (local: readonly CiLocalMain[], now: number): string =>
    local.length === 0
        ? ""
        : [
              "",
              "What this sandbox's own test runs saw fail on clean trees at main commits (not CI, so suites CI does not run are here too):",
              "",
              ...local.flatMap((entry) => localRepoLines(entry, now)),
              "",
              "A test failing at the commit your worktree forked from is not your change's. A failed test run in your worktree ends with a digest that labels each failure against these.",
          ].join("\n");
