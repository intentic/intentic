import { STATE_DIR } from "@intentic/constants";

/* ONE BATCH RUN ENGINE, for every surface that fans an ISOLATED AGENT TURN out over a set of items and reads
 * the answers back off disk.
 *
 * Three packs had written this separately — acceptance (a run per story), maintenance (a run per chore, per
 * repository) and documentation (a run per package) — and the three copies agreed on every decision that
 * matters and drifted on every detail that does not: `SCAN_RUNS` was 10 in one and 30 in another, one minted
 * run ids with a per-process counter and one without (the one without could collide, and did, the moment a
 * surface started several runs inside a millisecond), and each spelled the reporting clause its own way, so an
 * agent's instructions for where to leave its answer depended on which screen started it.
 *
 * WHY THE CORE OWNS IT rather than one of them exporting it. A substrate is what other packs fire into, and a
 * pack can be switched off: a run engine that stops existing because somebody hid a screen is not an engine.
 * The reverse — a substrate living in one pack — is what produced the three copies, because reaching into
 * `acceptance` for a run id is a dependency no other pack wants and reinventing it is one afternoon.
 * `_extensions/README.md` states the rule; this is the second of the four substrates named there.
 *
 * WHAT A RUN IS, and the part that is load-bearing rather than incidental:
 *
 *  • IT IS BACKED BY FILES, never by a store a pack owns. `run.json` is written before the first turn starts
 *    and each agent writes its own result beside it. So a run survives archiving the fleet agents, discarding
 *    them, closing the browser and rebuilding the image, and a browser that was shut when a turn finished picks
 *    the answer up the next time it opens.
 *  • ITS CONVERSATION IDS ARE DERIVED, so joining a run to the fleet is a filter over `GET /agents` rather than
 *    bookkeeping that can drift. This is why none of these surfaces owns session machinery: the worktree, the
 *    live status, the cost, the transcript and the `/agents/<id>` page all already exist.
 *  • IT LIVES UNDER `.intentic`, which is outside every repo (the root repo excludes it) and is bound back in
 *    SHARED for isolated turns, so an agent writing its result from inside its own worktree writes into the
 *    same tree the browser reads: nothing to land, no git noise.
 *
 * The manifest and result SHAPES stay with the packs. A chore's outcome vocabulary and a story's criteria have
 * nothing to say to each other, and a substrate that tried to own both would be a union that grows a field per
 * screen. What is here is what all three do identically: where the files go, how the ids are made, how a
 * half-written file is survived, and what the agent is told about where to leave its answer. */

/* WHERE ONE KIND OF RUN KEEPS ITS DIRECTORIES. Taken as the tail rather than composed from a pack id, because
 * the three existing layouts are not uniform and rewriting them would orphan every run already on disk:
 * acceptance keeps runs under `records/artifacts/acceptance`, maintenance under `records/chores/runs`. A path
 * is a fact about a tree that exists, not a naming opportunity. */
export interface BatchRunKind {
    /* The directory holding this kind's run directories, workspace-relative, under the state dir. */
    readonly runsDir: string;
    /* The conversation-id prefix, two or three characters. Every conversation this kind starts carries it, so a
     * prefix filter over `GET /agents` is the join key and not merely a naming convention. */
    readonly prefix: string;
    /* How many runs deep anything that READS RESULTS goes. A bound on the walk, not on what can be run: only
     * recent runs carry news, and a workspace with hundreds of run directories must not spend a request per
     * item to render a list or light a badge. One number per kind, shared by every reader of that kind, so a
     * badge's idea of "recent" and a list's can never disagree. */
    readonly scanRuns: number;
}

/* The conversation id's own regex is `^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$` — it lands in branch names and in
 * paths — so this is a hard ceiling rather than a style choice. */
const CONVERSATION_ID_MAX = 64;

/* `r` + a base-36 millisecond, zero-padded, + a per-process counter: sortable, ~10 characters, and readable
 * enough to match a directory to a moment. The clock is taken from the caller so this stays pure and testable.
 *
 * THE PADDING IS WHAT MAKES "SORTABLE" TRUE. Both copies this replaces claimed it and neither had it: a base-36
 * number is shorter when it is smaller, so a plain `toString(36)` sorts `r1a` after `rzz` the moment two ids
 * straddle a digit boundary. Today's milliseconds are all eight digits so nothing has gone wrong yet, and
 * nothing will until 2059 — which is exactly the kind of latent boundary that is cheap to remove now and
 * expensive to find later. Padded to the same width, the ids on disk are the length they already were.
 *
 * THE COUNTER IS NOT OPTIONAL, the other drift worth naming. A surface that fans out over items can get away
 * without one, because its ids differ by item; a surface where one run IS one item cannot, and "run this chore
 * in every repository" starts several inside the same millisecond. Both kinds share this function, so the
 * safe answer is the only answer, and it costs the id one character. */
const TIME_DIGITS = 8;
let sequence = 0;
export const batchRunIdAt = (epochMs: number): string => `r${epochMs.toString(36).padStart(TIME_DIGITS, `0`)}${(sequence++).toString(36)}`;

/* The fleet conversation id for one item of one run, or for a run that is a single item (omit `item`).
 *
 * THE RUN ID SURVIVES TRUNCATION and the item is what gets cut, because the run id is how a card is attributed
 * back to its run: lose that and a finished turn belongs to nothing. Callers that fan out must already have
 * made their item slugs unique by suffixing, and the suffix sits at the end — exactly where the cut lands — so
 * uniqueness holds only while the cut leaves it. In practice nothing is close: slugs are capped at 40 and run
 * ids are ~10, well inside 64. A trailing separator left by the cut is trimmed, because `xt-r5k2-` is a
 * conversation id the regex above would refuse. */
export const batchConversationId = (kind: BatchRunKind, runId: string, item?: string): string =>
    `${kind.prefix}-${runId}${item === undefined ? `` : `-${item}`}`.slice(0, CONVERSATION_ID_MAX).replace(/[-_]+$/u, ``);

// Every conversation one kind starts, for the prefix filter over `GET /agents` that joins a run to the fleet.
export const batchRunPrefix = (kind: BatchRunKind): string => `${kind.prefix}-`;

// The directory holding one kind's run directories, workspace-relative. What a listing is asked for.
export const batchRunsDir = (kind: BatchRunKind): string => `${STATE_DIR}/${kind.runsDir}`;
export const batchRunDir = (kind: BatchRunKind, runId: string): string => `${batchRunsDir(kind)}/${runId}`;
export const batchRunManifestPath = (kind: BatchRunKind, runId: string): string => `${batchRunDir(kind, runId)}/run.json`;

/* Where one item of a run leaves its files. A run whose items are the run itself (`item` omitted) writes
 * straight into the run directory, which is what maintenance already does and what keeps its `result.json`
 * beside its `run.json` rather than one pointless level down. */
export const batchItemDir = (kind: BatchRunKind, runId: string, item?: string): string =>
    item === undefined ? batchRunDir(kind, runId) : `${batchRunDir(kind, runId)}/${item}`;
export const batchResultPath = (kind: BatchRunKind, runId: string, item?: string): string => `${batchItemDir(kind, runId, item)}/result.json`;

/* A FILE THAT IS HALF-WRITTEN, or written by a build whose shape has since changed, IS SKIPPED rather than
 * thrown on. One bad directory must not blank a whole history, and a run directory is written by an agent
 * mid-turn, so reading one that is not finished being written is ordinary rather than exceptional.
 *
 * The caller supplies the shape check, because the shape is the pack's. This owns only the two failure modes
 * every reader shares: text that is not JSON, and JSON that is not an object. */
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
export const batchReportingClause = (params: {
    readonly path: string;
    readonly fields: string;
    readonly outcomes?: string | undefined;
}): string =>
    [
        `When you are finished, write your conclusion to ${params.path} as JSON:`,
        params.fields,
        ...(params.outcomes === undefined ? [] : [params.outcomes]),
        `Write that file even if you conclude there was nothing to do.`,
    ].join(`\n\n`);

/* THE BODY OF THE `POST /agent` THAT STARTS ONE ITEM, so the flag combination that makes a run a run is decided
 * once. `isolated: true` with a conversationId is the shape (and the only shape) that registers a fleet entry,
 * which is why none of these packs owns session machinery; `unattended: true` is what the turn IS — started by
 * a row rather than by a person at a composer — and it is what makes the daemon answer with the owner's
 * `agentRunModels` unless the caller pinned a model on the row's caret, in which case the pick rides along and
 * the daemon's fill step leaves it alone.
 *
 * PERMISSIONS AND ISOLATION ARE THE CALLER'S, deliberately. They are the two decisions that differ by kind and
 * both are about safety rather than plumbing: an acceptance test that parks on a permission card is a test that
 * never finishes, so that surface trades the prompt away; a maintenance chore is different in kind — nobody is
 * waiting on it, it may take until tomorrow, and a sweep that can answer its own permission prompts is exactly
 * the thing an owner would want to have been asked about. A default here would decide that for both. */
export interface BatchTurnPick {
    readonly provider: string;
    readonly model?: string | undefined;
    readonly effort?: string | undefined;
}

export const batchTurnBody = (params: {
    readonly prompt: string;
    readonly title: string;
    readonly conversationId: string;
    readonly pick?: BatchTurnPick | undefined;
    readonly extra?: Readonly<Record<string, unknown>> | undefined;
}): Record<string, unknown> => ({
    prompt: params.prompt,
    title: params.title.slice(0, 80),
    conversationId: params.conversationId,
    isolated: true,
    unattended: true,
    ...(params.pick === undefined
        ? {}
        : {
              agent: params.pick.provider,
              ...(params.pick.model === undefined ? {} : { model: params.pick.model }),
              ...(params.pick.effort === undefined ? {} : { effort: params.pick.effort }),
          }),
    ...params.extra,
});
