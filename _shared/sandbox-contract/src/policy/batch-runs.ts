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

/* WHAT THE AGENT IS TOLD ABOUT WHERE TO LEAVE ITS ANSWER, appended to whatever prompt the pack composed.
 *
 * WHY THE AGENT WRITES A FILE AND NOT A ROUTE. A ledger is a daemon route, and reaching it from a turn would
 * mean handing the agent a token and a client it needs for nothing else. Writing one small JSON file is
 * something every agent can already do, and the surface promotes finished runs when it next sees them. The
 * promotion is idempotent and re-runs on every poll, so nothing is lost by not being watched.
 *
 * `outcomes` is the pack's vocabulary and is spelled out in full, because a closed set is what lets a surface
 * debounce without hiding anything: an agent that verified some findings and concluded they were false
 * positives has to be able to SAY so, or the next poll starts the same turn again forever. Pass the
 * explanations with the words — a model that reads an outcome as an admission of having done nothing useful
 * will avoid it and report something else, and the surface never goes quiet.
 *
 * The closing line is not decoration. A turn that concludes there was nothing to do and writes no file is
 * indistinguishable from a turn that died, and the surface has to show the second as an unknown. */
export const batchReportingClause = (params: { readonly path: string; readonly fields: string; readonly outcomes?: string | undefined }): string =>
    [
        `When you are finished, write your conclusion to ${params.path} as JSON:`,
        params.fields,
        ...(params.outcomes === undefined ? [] : [params.outcomes]),
        `Write that file even if you conclude there was nothing to do.`,
    ].join(`\n\n`);

/* THE BODY OF THE `POST /agent` THAT STARTS ONE ITEM, so the flag combination that makes a run a run is decided
 * once. `isolated: true` with a conversationId is the shape (and the only shape) that registers a fleet entry,
 * which is why none of these packs owns session machinery; `unattended: true` is what the turn IS — started by
 * a row rather than by a person at a composer — and `runRole` is which of those rows, so the daemon answers
 * with the owner's list FOR THAT JOB (model-roles.ts) unless the caller pinned a model on the row's caret, in
 * which case the pick rides along and the daemon's fill step leaves it alone.
 *
 * PERMISSIONS AND ISOLATION ARE THE CALLER'S, deliberately. They are the two decisions that differ by kind and
 * both are about safety rather than plumbing: an acceptance test that parks on a permission card is a test that
 * never finishes, so that surface trades the prompt away; a maintenance chore is different in kind — nobody is
 * waiting on it, it may take until tomorrow, and a sweep that can answer its own permission prompts is exactly
 * the thing an owner would want to have been asked about. A default here would decide that for both. */
/* WHAT THE CARET ON THE RUN BUTTON CHOSE, in the shell's own vocabulary (`provider`; the turn calls it `agent`).
 * Every field but the provider is optional and absent means absent: the turn goes out without it and the model's
 * own default answers. All of them travel, because all of them are things the picker can now set and each is a
 * different price — a run re-pointed at a frontier model but not at the tier, the loop or the account it was
 * pinned under is not the run the reader configured. */
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
