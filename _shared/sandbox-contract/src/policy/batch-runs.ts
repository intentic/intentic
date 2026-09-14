import { STATE_DIR } from "@intentic/constants";
import type { ModelRole } from "../models/model-roles.js";

// One batch run engine for every surface that fans an isolated agent turn out over items and reads results off disk.
// Backed by files, not a pack's own store, with derived conversation ids that join the fleet via a GET /agents filter,
// under .intentic. Manifest and result shapes stay with the packs; this owns only what all three need alike.

// Where one kind of run keeps its directories: the tail, not composed from a pack id, since the existing on-disk
// layouts (acceptance vs maintenance) are not uniform and rewriting them would orphan runs.
export interface BatchRunKind {
    /* The directory holding this kind's run directories, workspace-relative, under the state dir. */
    readonly runsDir: string;
    // The conversation-id prefix (2-3 chars); every conversation this kind starts carries it as the join key.
    readonly prefix: string;
    // How many runs deep a results reader goes; one shared number so a badge and a list never disagree on "recent".
    readonly scanRuns: number;
}

// Hard ceiling from the conversation id's own regex (it lands in branch names and paths), not a style choice.
const CONVERSATION_ID_MAX = 64;

// `r` + a zero-padded base-36 millisecond + a per-process counter: padding keeps it sortable across a digit boundary,
// and the counter is needed since a single-item-per-run surface can mint several within one millisecond.
const TIME_DIGITS = 8;
let sequence = 0;
export const batchRunIdAt = (epochMs: number): string => `r${epochMs.toString(36).padStart(TIME_DIGITS, `0`)}${(sequence++).toString(36)}`;

// The fleet conversation id for one item of a run (or a single-item run, omitting item). The run id survives
// truncation, since that's what attributes a card back to its run; a trailing separator left by the cut is trimmed.
export const batchConversationId = (kind: BatchRunKind, runId: string, item?: string): string =>
    `${kind.prefix}-${runId}${item === undefined ? `` : `-${item}`}`.slice(0, CONVERSATION_ID_MAX).replace(/[-_]+$/u, ``);

// Every conversation one kind starts, for the prefix filter over GET /agents that joins a run to the fleet.
export const batchRunPrefix = (kind: BatchRunKind): string => `${kind.prefix}-`;

// The directory holding one kind's run directories, workspace-relative. What a listing is asked for.
export const batchRunsDir = (kind: BatchRunKind): string => `${STATE_DIR}/${kind.runsDir}`;
export const batchRunDir = (kind: BatchRunKind, runId: string): string => `${batchRunsDir(kind)}/${runId}`;
export const batchRunManifestPath = (kind: BatchRunKind, runId: string): string => `${batchRunDir(kind, runId)}/run.json`;

// Where one item of a run leaves its files; an item-less run (item omitted) writes straight into the run directory,
// keeping result.json beside run.json rather than one level down.
export const batchItemDir = (kind: BatchRunKind, runId: string, item?: string): string =>
    item === undefined ? batchRunDir(kind, runId) : `${batchRunDir(kind, runId)}/${item}`;
export const batchResultPath = (kind: BatchRunKind, runId: string, item?: string): string => `${batchItemDir(kind, runId, item)}/result.json`;

// A half-written file, or one from before the shape changed, is skipped rather than thrown on: reading a run mid-write
// is ordinary here. The caller supplies the shape check; this owns only invalid or non-object JSON.
export const parseBatchFile = <T>(text: string, shape: (value: Record<string, unknown>) => T | undefined): T | undefined => {
    try {
        const parsed: unknown = JSON.parse(text);
        return typeof parsed !== `object` || parsed === null ? undefined : shape(parsed as Record<string, unknown>);
    } catch {
        return undefined;
    }
};

/* WHAT THE AGENT IS TOLD ABOUT WHERE TO LEAVE ITS ANSWER, appended to whatever prompt the pack composed. */
export const batchReportingClause = (params: { readonly path: string; readonly fields: string; readonly outcomes?: string | undefined }): string =>
    [
        `When you are finished, write your conclusion to ${params.path} as JSON:`,
        params.fields,
        ...(params.outcomes === undefined ? [] : [params.outcomes]),
        `Write that file even if you conclude there was nothing to do.`,
    ].join(`\n\n`);

/* The batch request fixes the isolation and run flags for one item. */
/* WHAT THE CARET ON THE RUN BUTTON CHOSE, in the shell's own vocabulary (`provider`; the turn calls it `agent`). */
export interface BatchTurnPick {
    readonly provider: string;
    readonly model?: string | undefined;
    readonly account?: string | undefined;
    readonly harness?: string | undefined;
    readonly effort?: string | undefined;
    readonly thinking?: boolean | undefined;
    readonly fast?: boolean | undefined;
}

// The same fields under the names a turn uses. Its own function so the body builder below stays one readable
// object literal rather than seven nested conditionals.
const runPickFields = (pick: BatchTurnPick): Record<string, unknown> => ({
    agent: pick.provider,
    ...(pick.model === undefined ? {} : { model: pick.model }),
    ...(pick.account === undefined ? {} : { account: pick.account }),
    ...(pick.harness === undefined ? {} : { harness: pick.harness }),
    ...(pick.effort === undefined ? {} : { effort: pick.effort }),
    ...(pick.thinking === undefined ? {} : { thinking: pick.thinking }),
    ...(pick.fast === undefined ? {} : { fast: pick.fast }),
});

export const batchTurnBody = (params: {
    readonly prompt: string;
    readonly title: string;
    readonly conversationId: string;
    // Which job this is, and so which model list pays; required, so a pack can't silently inherit another's budget.
    readonly role: ModelRole;
    readonly pick?: BatchTurnPick | undefined;
    readonly extra?: Readonly<Record<string, unknown>> | undefined;
}): Record<string, unknown> => ({
    prompt: params.prompt,
    title: params.title.slice(0, 80),
    conversationId: params.conversationId,
    isolated: true,
    unattended: true,
    runRole: params.role,
    ...(params.pick === undefined ? {} : runPickFields(params.pick)),
    ...params.extra,
});
