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

// A chore run: one chore, one repository, one moment. Directory layout, run/conversation ids and file-survival
// machinery live in the shared batch-run substrate (sandbox-contract/batch-runs.ts); this owns only the manifest's
// fields and the three outcomes.

const KIND: BatchRunKind = {
    runsDir: `records/chores/runs`,
    prefix: `mt`,
    // Deeper than acceptance's: a sweep across repositories spends several run directories in one night.
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
    // Evidence the run started against, copied in at launch so the ledger can answer 'ran against THIS?' later.
    readonly digest: string;
    readonly conversationId: string;
    // What the row said when the turn started, readable months later without reconstructing evidence.
    readonly headline: string;
}

// What the agent writes when done. Just two fields; anything longer belongs in the transcript, one click from the row.
export interface RunResult {
    readonly outcome: ChoreOutcome;
    readonly summary: string;
}

const OUTCOMES = new Set<string>([`acted`, `reported`, `clean`]);

// Skips a manifest whose shape has changed, rather than throwing. The substrate handles truncated files; this checks
// what a chore manifest must carry.
export const parseManifest = (text: string): RunManifest | undefined =>
    parseBatchFile(text, (value) => {
        const manifest = value as Partial<RunManifest>;
        const { runId, repo, chore } = manifest;
        if (typeof runId !== `string` || typeof repo !== `string` || typeof chore !== `string`) {
            return undefined;
        }
        return { createdAt: 0, digest: ``, headline: ``, conversationId: conversationIdOf(runId), ...manifest, runId, repo, chore };
    });

// No result (still running, or the turn died) and an unrecognised outcome both read as undefined; the panel falls back
// to the fleet's live status rather than guessing.
export const parseResult = (text: string): RunResult | undefined =>
    parseBatchFile(text, ({ outcome, summary }) =>
        typeof outcome !== `string` || !OUTCOMES.has(outcome)
            ? undefined
            : { outcome: outcome as ChoreOutcome, summary: typeof summary === `string` ? summary : `` },
    );

// Splits backticked literals from prose so the row can render them as code. An unbalanced backtick count means it isn't
// markup at all; returned as one plain span.
export const summarySpans = (summary: string): { text: string; code: boolean }[] => {
    const pieces = summary.split("`");
    return pieces.length % 2 === 0 ? [{ text: summary, code: false }] : pieces.map((text, index) => ({ text, code: index % 2 === 1 }));
};

// Only part of the chore's turn that needs the run id. The three outcomes are spelled out because `clean` must read as
// good, not a failure, or a model avoids it and the chore never goes quiet.
export const reportingClause = (runId: string): string =>
    batchReportingClause({
        path: resultPath(runId),
        fields: `{"outcome": "acted" | "reported" | "clean", "summary": "<one or two sentences>"}`,
        outcomes:
            `Use "acted" if you changed something, "reported" if you are handing back findings without changing anything, and "clean" if you ` +
            `checked and the findings did not hold up: a tool was wrong, or the situation is deliberate. "clean" is a good outcome and the ` +
            `most useful one you can give when it is true: it is what stops this chore being raised again over the same evidence.`,
    });
