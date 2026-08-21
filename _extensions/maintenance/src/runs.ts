import { STATE_DIR } from "@intentic/sandbox-contract";
import type { ChoreOutcome } from "@intentic/sandbox-contract";

/* A CHORE RUN is one chore, in one repository, started at one moment, and like every other agent-producing
 * surface in this workspace it is backed by FILES rather than by any store this extension owns.
 *
 *  • The run survives everything. Archive the fleet agent, discard it, close the browser, rebuild the image: the
 *    manifest and whatever the agent concluded are still on disk, because nothing about them lives in the
 *    registry or in extension settings.
 *  • Live status needs no store either. The conversation id is DERIVED from the run id, so joining a run to the
 *    fleet is a filter over `GET /agents`, not bookkeeping that can drift.
 *
 * The directory sits under the workspace's `.intentic`, which is outside every repo (the root repo excludes it)
 * and is bound back SHARED for isolated turns, so the agent writing its result from inside its own worktree
 * writes into the same tree the browser reads, with nothing to land and no git noise.
 *
 * WHY THE AGENT WRITES A FILE AND NOT THE LEDGER. The ledger is a daemon route, and reaching it from a turn would
 * mean giving the agent a token and a client it does not otherwise need. Writing one small JSON file is something
 * every agent can already do, and the extension promotes finished runs into the ledger when it sees them (see
 * useRuns.promote). The promotion is idempotent and re-runs on every poll, so a browser that was closed when the
 * turn finished picks it up the next time it opens, nothing is lost by not being watched. */

export const RUNS_DIR = `${STATE_DIR}/records/chores/runs`;

const runDir = (runId: string): string => `${RUNS_DIR}/${runId}`;
export const runManifestPath = (runId: string): string => `${runDir(runId)}/run.json`;
export const resultPath = (runId: string): string => `${runDir(runId)}/result.json`;

/* How many runs deep anything that reads RESULTS goes. A bound on the walk, not on what can be run: only recent
 * runs carry news, and a workspace with hundreds of run directories must not spend a request each to render a
 * list. Shared by the promotion pass and the panel's history so the two can never disagree about what "recent"
 * means. */
export const SCAN_RUNS = 30;

// The conversationId's own regex bounds it to 64 characters (it lands in branch names and paths), so this is a
// hard ceiling rather than a style choice.
const CONVERSATION_ID_MAX = 64;
const PREFIX = `mt`;

// Every conversation this extension starts. A prefix filter over `GET /agents` is how a run finds its agent, so
// this is the join key and not merely a naming convention.
export const ANY_RUN_PREFIX = `${PREFIX}-`;

/* `r` + a base-36 millisecond, plus a per-process counter. Acceptance can get away without the counter because
 * its runs fan out over slugs that differ; here one run IS one chore, so the run id alone has to be unique, and
 * "run this chore in every repository" starts several within the same millisecond. */
let sequence = 0;
export const runIdAt = (epochMs: number): string => `r${epochMs.toString(36)}${(sequence++).toString(36)}`;

// The chore id is what gets cut when the two together would overflow: the RUN id is how a card is attributed back
// to its run, so it must survive intact. In practice neither is close, a run id is ~10 characters and the
// longest chore id in the book is 21.
export const conversationIdOf = (runId: string): string => `${PREFIX}-${runId}`.slice(0, CONVERSATION_ID_MAX);

export interface RunManifest {
    readonly runId: string;
    readonly createdAt: number;
    readonly repo: string;
    readonly chore: string;
    // The evidence the run was started against, copied in at launch so the ledger entry this becomes can answer
    // "did it run against THIS?" without re-deriving a verdict from measurements that have since moved.
    readonly digest: string;
    readonly conversationId: string;
    // What the row said at the moment the turn started, for a history entry that is readable a month later
    // without reconstructing the evidence.
    readonly headline: string;
}

// What the agent writes when it is done. Deliberately three fields: anything longer is a report, and the report
// is the transcript, which is one click away from the run row and does not need copying into a JSON file.
export interface RunResult {
    readonly outcome: ChoreOutcome;
    readonly summary: string;
}

const OUTCOMES = new Set<string>([`acted`, `reported`, `clean`]);

/* A manifest that is half-written, or written by a build whose shape has since changed, is SKIPPED rather than
 * thrown on: one bad directory must not blank the whole history. */
export const parseManifest = (text: string): RunManifest | undefined => {
    try {
        const parsed: unknown = JSON.parse(text);
        if (typeof parsed !== `object` || parsed === null) {
            return undefined;
        }
        const manifest = parsed as Partial<RunManifest>;
        const { runId, repo, chore } = manifest;
        if (typeof runId !== `string` || typeof repo !== `string` || typeof chore !== `string`) {
            return undefined;
        }
        return {
            createdAt: 0,
            digest: ``,
            headline: ``,
            conversationId: conversationIdOf(runId),
            ...manifest,
            runId,
            repo,
            chore,
        };
    } catch {
        return undefined;
    }
};

/* A result the agent never wrote (still running, or the turn died) reads as undefined rather than as an outcome,
 * the panel shows the fleet's live status for those instead of inventing one. An outcome outside the three we
 * know is treated the same way: an agent that improvised a fourth word has not reported anything this surface can
 * act on, and guessing which of ours it meant would be putting words in its mouth. */
export const parseResult = (text: string): RunResult | undefined => {
    try {
        const parsed: unknown = JSON.parse(text);
        if (typeof parsed !== `object` || parsed === null) {
            return undefined;
        }
        const { outcome, summary } = parsed as { outcome?: unknown; summary?: unknown };
        if (typeof outcome !== `string` || !OUTCOMES.has(outcome)) {
            return undefined;
        }
        return { outcome: outcome as ChoreOutcome, summary: typeof summary === `string` ? summary : `` };
    } catch {
        return undefined;
    }
};

/* WHAT WE ADD TO THE CHORE'S OWN PROMPT. The chore book composes the turn, what to do and how to know it is
 * done, and knows nothing about run directories; this is the only part that needs the run id, so it is appended
 * here rather than threaded into the library.
 *
 * The three outcomes are spelled out because they are the whole reason the ledger can debounce without hiding
 * anything, and `clean` is the one that matters: an agent that verified the findings and concluded they were
 * false positives has to be able to SAY so, or the next poll starts the same turn again forever. Saying it is
 * explicitly not a failure is deliberate, a model that reads "clean" as an admission of having done nothing
 * useful will avoid it and report `reported` instead, and the chore never goes quiet. */
export const reportingClause = (runId: string): string =>
    [
        `When you are finished, write your conclusion to ${resultPath(runId)} as JSON:`,
        `{"outcome": "acted" | "reported" | "clean", "summary": "<one or two sentences>"}`,
        `Use "acted" if you changed something, "reported" if you are handing back findings without changing anything, and "clean" if you ` +
            `checked and the findings did not hold up: a tool was wrong, or the situation is deliberate. "clean" is a good outcome and the ` +
            `most useful one you can give when it is true: it is what stops this chore being raised again over the same evidence.`,
        `Write that file even if you conclude there was nothing to do.`,
    ].join(`\n\n`);
