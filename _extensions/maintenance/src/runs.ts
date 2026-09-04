import type { ChoreOutcome } from "@intentic/sandbox-contract";
import {
    type BatchRunKind,
    batchConversationId,
    batchReportingClause,
    batchResultPath,
    batchRunIdAt,
    batchRunManifestPath,
    batchRunPrefix,
    batchRunsDir,
    parseBatchFile,
} from "@intentic/sandbox-contract/batch-runs";

/* A CHORE RUN is one chore, in one repository, started at one moment. The machinery under it — where the
 * directories go, how the run id and its derived conversation id are made, how a half-written file is survived,
 * and the shape of the sentence that tells the agent where to leave its answer — is the core's batch-run
 * substrate, shared with acceptance and documentation (sandbox-contract/batch-runs.ts). What stays here is what
 * is actually about chores: the manifest's fields, the three outcomes, and why `clean` is one of them.
 *
 * The run is backed by FILES rather than by any store this extension owns, and its conversation id is DERIVED,
 * so joining a run to the fleet is a filter over `GET /agents`. Both of those are the substrate's doing and its
 * header argues them; the consequence here is that this extension owns no session machinery at all. */

const KIND: BatchRunKind = {
    runsDir: `records/chores/runs`,
    prefix: `mt`,
    /* How many runs deep anything that reads RESULTS goes. Deeper than acceptance's, because a chore run is one
     * chore and a sweep across a handful of repositories spends several run directories on a single night's
     * work, where an acceptance run spends one on a whole selection. */
    scanRuns: 30,
};

export const RUNS_DIR = batchRunsDir(KIND);
export const SCAN_RUNS = KIND.scanRuns;
export const ANY_RUN_PREFIX = batchRunPrefix(KIND);

export const runIdAt = (epochMs: number): string => batchRunIdAt(epochMs);
export const conversationIdOf = (runId: string): string => batchConversationId(KIND, runId);
export const runManifestPath = (runId: string): string => batchRunManifestPath(KIND, runId);
export const resultPath = (runId: string): string => batchResultPath(KIND, runId);

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

// What the agent writes when it is done. Deliberately two fields: anything longer is a report, and the report
// is the transcript, which is one click away from the run row and does not need copying into a JSON file.
export interface RunResult {
    readonly outcome: ChoreOutcome;
    readonly summary: string;
}

const OUTCOMES = new Set<string>([`acted`, `reported`, `clean`]);

// A manifest written by a build whose shape has since changed is skipped rather than thrown on; the substrate
// owns the truncated-file and not-an-object cases, this owns what a chore manifest has to carry to be one.
export const parseManifest = (text: string): RunManifest | undefined =>
    parseBatchFile(text, (value) => {
        const manifest = value as Partial<RunManifest>;
        const { runId, repo, chore } = manifest;
        if (typeof runId !== `string` || typeof repo !== `string` || typeof chore !== `string`) {
            return undefined;
        }
        return { createdAt: 0, digest: ``, headline: ``, conversationId: conversationIdOf(runId), ...manifest, runId, repo, chore };
    });

/* A result the agent never wrote (still running, or the turn died) reads as undefined rather than as an outcome:
 * the panel shows the fleet's live status for those instead of inventing one. An outcome outside the three we
 * know is treated the same way — an agent that improvised a fourth word has not reported anything this surface
 * can act on, and guessing which of ours it meant would be putting words in its mouth. */
export const parseResult = (text: string): RunResult | undefined =>
    parseBatchFile(text, ({ outcome, summary }) =>
        typeof outcome !== `string` || !OUTCOMES.has(outcome)
            ? undefined
            : { outcome: outcome as ChoreOutcome, summary: typeof summary === `string` ? summary : `` },
    );

/* WHAT WE ADD TO THE CHORE'S OWN PROMPT. The chore book composes the turn — what to do and how to know it is
 * done — and knows nothing about run directories; this is the only part that needs the run id.
 *
 * The three outcomes are spelled out because they are the whole reason the ledger can debounce without hiding
 * anything, and `clean` is the one that matters: an agent that verified the findings and concluded they were
 * false positives has to be able to SAY so, or the next poll starts the same turn again forever. Saying it is
 * explicitly not a failure is deliberate — a model that reads "clean" as an admission of having done nothing
 * useful will avoid it and report `reported` instead, and the chore never goes quiet. */
export const reportingClause = (runId: string): string =>
    batchReportingClause({
        path: resultPath(runId),
        fields: `{"outcome": "acted" | "reported" | "clean", "summary": "<one or two sentences>"}`,
        outcomes:
            `Use "acted" if you changed something, "reported" if you are handing back findings without changing anything, and "clean" if you ` +
            `checked and the findings did not hold up: a tool was wrong, or the situation is deliberate. "clean" is a good outcome and the ` +
            `most useful one you can give when it is true: it is what stops this chore being raised again over the same evidence.`,
    });
