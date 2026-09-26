import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { HookCallbackMatcher, HookEvent } from "@anthropic-ai/claude-agent-sdk";
import type {
    AgentEvent,
    AgentHarness,
    AgentProvider,
    SubagentKind,
    SubagentSession,
    SubagentStatus,
    SubagentVerification,
} from "@intentic/sandbox-contract";
import type { ConversationActors } from "../../conversations/actor/conversation-actors.js";
import type { Holding } from "../../conversations/actor/conversation-holdings.js";
import { publishRuntimeChange } from "../../seams/runtime-feed.js";
import { childVerification, childVerificationNote, forgetChild, resetChildVerification } from "./child-verification.js";
import { ROSTER } from "./subagent-roster.js";
import { turnRunOf } from "../../conversations/actor/conversation-holdings.js";

// The registry of subagents the daemon can name, read by the Subagents area and the rail; the third registry of its
// kind after terminal and browser sessions, with its own short retention window. An SDK child is keyed by the spawning
// tool call's id, a spawned one by its own conversation id; each record is held by its conversation's actor (ROSTER).

// Short on purpose: a turn can spawn a dozen children at once, far faster than browsers age (two hours).
const RETAIN_FINISHED_MS = 5 * 60_000;

// Report text kept in the summary and list row; the rest is the transcript's job.
const REPORT_TAIL = 500;

export interface SubagentRecord {
    readonly id: string;
    readonly kind: SubagentKind;
    readonly conversationId: string;
    agentType: string | undefined;
    description: string | undefined;
    model: string | undefined;
    // A spawned child's provider, paired with harness below; together with id, its transcript lookup key.
    provider: AgentProvider | undefined;
    harness: AgentHarness | undefined;
    spawnDepth: number | undefined;
    background: boolean | undefined;
    status: SubagentStatus;
    readonly startedAt: number;
    endedAt: number | undefined;
    activityAt: number;
    tokens: number | undefined;
    toolUses: number | undefined;
    lastTool: string | undefined;
    summary: string | undefined;
    error: string | undefined;
    // Stamped once, when the child ends; a mid-run read would call unfinished work unproven.
    verification: SubagentVerification | undefined;
    // Live reference, not a snapshot: sessionId and subagentsDir fill in after the record opens.
    readonly turn: SubagentTurn;
    // The SDK's own agent id, resolved via subagentAgentId and cached here once known.
    agentId: string | undefined;
    // Where the current summary came from, so a weaker source can't overwrite a stronger one (see `ending`).
    summarySource: SummarySource | undefined;
    // The status a wait last handed back; a wait on "any" does not report the same move twice.
    reported: SubagentStatus | undefined;
}

// Where the roster and everything kept beside it is held: each conversation's actor.
type Actors = Pick<ConversationActors, "holdings">;

// Drop records aged past RETAIN_FINISHED_MS; called on every list and every write.
const sweep = (actors: Actors, now: number): void => {
    const roster = actors.holdings(ROSTER);
    for (const [id, record] of roster.entries()) {
        if (record.endedAt !== undefined && now - record.endedAt > RETAIN_FINISHED_MS) {
            roster.drop(id);
            // The verification ledger's life matches the record's; its verdict was already copied onto the record.
            forgetChild(actors, id);
        }
    }
};

const LIVE: ReadonlySet<SubagentStatus> = new Set<SubagentStatus>(["pending", "running", "blocked", "paused"]);
export const subagentRunning = (record: Pick<SubagentSession, "status">): boolean => LIVE.has(record.status);

// Notified synchronously on every open() and patch(), which makes waitForSubagent race-free: a listener added before
// the read cannot miss a transition. Not the runtime-watch bus, which rate-limits per domain. Held by the conversation
// waited on, under an id of the wait's own.
const WAITERS: Holding<() => void> = { name: "subagent waits" };
const notifyChanged = (actors: Actors): void => {
    for (const [, listener] of actors.holdings(WAITERS).entries()) {
        listener();
    }
};

// is_backgrounded never arrives as a task_updated patch, so it is read off the spawning tool call instead.
// No task message carries a model, so the spawning call is also the only pre-meta-file source for one.
interface SubagentSpawn {
    readonly background?: true;
    readonly model?: string;
}
// Keyed by the spawning call's id and held by no conversation, since the stream notes it naming none; taken at birth.
const SPAWNS: Holding<SubagentSpawn> = { name: "subagent spawn notes" };

// `inherit` and `default` are directives, not models; filing them would print them as one.
const NAMES_NO_MODEL: ReadonlySet<string> = new Set(["", "inherit", "default"]);
const namedModel = (model: string | undefined): string | undefined =>
    model === undefined || NAMES_NO_MODEL.has(model.trim().toLowerCase()) ? undefined : model;

/** Marks a spawning call's background/model ahead of task_started; a call with neither stays unmarked. */
export const noteSubagentSpawn = (actors: Actors, id: string, spawn: { readonly background?: boolean; readonly model?: string } = {}): void => {
    const model = namedModel(spawn.model);
    if (spawn.background !== true && model === undefined) {
        return;
    }
    actors
        .holdings(SPAWNS)
        .hold(undefined, id, { ...(spawn.background === true ? { background: true } : {}), ...(model !== undefined ? { model } : {}) });
};

const wire = (record: SubagentRecord): SubagentSession => ({
    id: record.id,
    kind: record.kind,
    conversationId: record.conversationId,
    ...(record.agentType !== undefined ? { agentType: record.agentType } : {}),
    ...(record.description !== undefined ? { description: record.description } : {}),
    ...(record.model !== undefined ? { model: record.model } : {}),
    ...(record.provider !== undefined ? { provider: record.provider } : {}),
    ...(record.spawnDepth !== undefined ? { spawnDepth: record.spawnDepth } : {}),
    ...(record.background !== undefined ? { background: record.background } : {}),
    status: record.status,
    startedAt: record.startedAt,
    ...(record.endedAt !== undefined ? { endedAt: record.endedAt } : {}),
    activityAt: record.activityAt,
    ...(record.tokens !== undefined ? { tokens: record.tokens } : {}),
    ...(record.toolUses !== undefined ? { toolUses: record.toolUses } : {}),
    ...(record.lastTool !== undefined ? { lastTool: record.lastTool } : {}),
    ...(record.summary !== undefined ? { summary: record.summary } : {}),
    ...(record.error !== undefined ? { error: record.error } : {}),
    ...(record.verification !== undefined ? { verification: record.verification } : {}),
});

/** Every known subagent, live first then most recently active, the same order browsersQuery uses for browsers. */
export const listSubagentSessions = (actors: Actors): SubagentSession[] => {
    sweep(actors, Date.now());
    return actors
        .holdings(ROSTER)
        .entries()
        .map(([, record]) => wire(record))
        .toSorted((left, right) => Number(subagentRunning(right)) - Number(subagentRunning(left)) || right.activityAt - left.activityAt);
};

/** Everything subagent-transcript.ts needs to read one child's transcript, nothing the wire carries. */
export const subagentSource = (
    actors: Actors,
    id: string,
):
    | {
          readonly kind: SubagentKind;
          readonly conversationId: string;
          readonly cwd: string;
          readonly running: boolean;
          readonly startedAt: number;
          // Shown as the opening user bubble; frames carry no prompt of their own.
          readonly description: string | undefined;
          readonly sessionId: string | undefined;
          // A spawned child's transcript key, alongside its conversation id; undefined for every other kind.
          readonly provider: AgentProvider | undefined;
          readonly harness: AgentHarness | undefined;
      }
    | undefined => {
    const record = actors.holdings(ROSTER).get(id);
    if (record === undefined) {
        return undefined;
    }
    return {
        kind: record.kind,
        conversationId: record.conversationId,
        cwd: record.turn.cwd,
        running: subagentRunning(record),
        startedAt: record.startedAt,
        description: record.description,
        sessionId: record.turn.sessionId,
        provider: record.provider,
        harness: record.harness,
    };
};

/** Whether a live child is working in the parent's own checkout, the rebase gate's question: an SDK subagent edits it directly. */
export const subagentInParentTree = (actors: Actors, conversationId: string): boolean =>
    actors
        .holdings(ROSTER)
        .of(conversationId)
        .some((record) => record.kind !== "spawned" && subagentRunning(record));

/** Live and total child counts for a conversation, the fleet card's count chip, read off the actors the card is. */
export const subagentCountsOf = (actors: Actors, conversationId: string): { readonly running: number; readonly total: number } => {
    const own = actors.holdings(ROSTER).of(conversationId);
    return { running: own.filter(subagentRunning).length, total: own.length };
};

// One handle per turn, held for its life and shared by every child it opens, so a late-learned fact reaches children
// born earlier. `sessionId` fills from the stream's first frame; `subagentsDir` from the first child's start hook.
export interface SubagentTurn {
    readonly conversationId: string;
    // The actors its conversation lives in, which hold every child this turn opens.
    readonly conversations: Actors;
    readonly cwd: string;
    sessionId: string | undefined;
    subagentsDir: string | undefined;
}

const open = (turn: SubagentTurn, id: string, kind: SubagentKind, fields: Partial<SubagentRecord>): SubagentRecord => {
    const now = Date.now();
    const actors = turn.conversations;
    sweep(actors, now);
    // model and background are set only here, at birth; nothing updates them on the record later.
    const spawns = actors.holdings(SPAWNS);
    const spawn = spawns.get(id);
    spawns.drop(id);
    const record: SubagentRecord = {
        id,
        kind,
        conversationId: turn.conversationId,
        agentType: undefined,
        description: undefined,
        model: spawn?.model,
        provider: undefined,
        harness: undefined,
        spawnDepth: undefined,
        background: spawn?.background,
        status: "running",
        startedAt: now,
        endedAt: undefined,
        activityAt: now,
        tokens: undefined,
        toolUses: undefined,
        lastTool: undefined,
        summary: undefined,
        error: undefined,
        verification: undefined,
        turn,
        agentId: undefined,
        summarySource: undefined,
        reported: undefined,
        ...fields,
    };
    // A spawned child's record is about the child as well, whose own dispose takes it from its parent's roster.
    actors.holdings(ROSTER).hold(turn.conversationId, id, record, kind === "spawned" ? id : undefined);
    // Tells surfaces not watching this conversation, the rail, the Subagents area, that a child was born.
    publishRuntimeChange("subagents");
    notifyChanged(actors);
    return record;
};

const bornFrame = (record: SubagentRecord): AgentEvent => ({
    kind: "subagent",
    id: record.id,
    subagentKind: record.kind,
    ...(record.agentType !== undefined ? { agentType: record.agentType } : {}),
    ...(record.description !== undefined ? { description: record.description } : {}),
    ...(record.model !== undefined ? { model: record.model } : {}),
    ...(record.provider !== undefined ? { provider: record.provider } : {}),
    ...(record.background !== undefined ? { background: record.background } : {}),
});

// Applies a patch and reports it; reports nothing if the record is gone or nothing actually changed, so a repeated
// no-op update produces no frame.
const patch = (actors: Actors, id: string, fields: Partial<SubagentRecord>): AgentEvent | undefined => {
    const record = actors.holdings(ROSTER).get(id);
    if (record === undefined) {
        return undefined;
    }
    const changed = (Object.entries(fields) as [keyof SubagentRecord, unknown][]).filter(
        ([key, value]) => value !== undefined && record[key] !== value,
    );
    if (changed.length === 0) {
        return undefined;
    }
    Object.assign(record, Object.fromEntries(changed));
    record.activityAt = Date.now();
    // The one place a child's end is recorded, whichever arrival got here first; read once, never re-stamped.
    if (record.endedAt === undefined && !subagentRunning(record)) {
        record.endedAt = record.activityAt;
        record.verification = childVerification(actors, record.id);
    }
    // Fires only on real change; a no-op patch already returned above.
    publishRuntimeChange("subagents");
    notifyChanged(actors);
    const update: Extract<AgentEvent, { kind: "subagent_update" }> = { kind: "subagent_update", id };
    return {
        ...update,
        ...(fields.status !== undefined ? { status: record.status } : {}),
        ...(fields.tokens !== undefined ? { tokens: record.tokens } : {}),
        ...(fields.toolUses !== undefined ? { toolUses: record.toolUses } : {}),
        ...(fields.lastTool !== undefined ? { lastTool: record.lastTool } : {}),
        ...(fields.summary !== undefined ? { summary: record.summary } : {}),
        ...(fields.error !== undefined ? { error: record.error } : {}),
        // Read off the record, not `fields`: verification is stamped by the ending logic above, not passed in.
        ...(record.verification !== undefined ? { verification: record.verification } : {}),
    };
};

// Whichever of three racing sources arrives first ends the child; a later one may only turn a finished child into
// failed. Summary is kept by source, not arrival order; each caller cuts its own text where it makes sense.

type SummarySource = "notification" | "report";
const SUMMARY_RANK: Record<SummarySource, number> = { notification: 1, report: 2 };

const ending = (
    record: SubagentRecord,
    end: { readonly status?: SubagentStatus; readonly summary?: string; readonly error?: string; readonly source: SummarySource },
): Partial<SubagentRecord> => {
    const keepsSummary =
        end.summary !== undefined && end.summary !== "" && SUMMARY_RANK[end.source] >= SUMMARY_RANK[record.summarySource ?? "notification"];
    const endsIt = end.status !== undefined && (subagentRunning(record) || (end.status === "failed" && record.status !== "failed"));
    return {
        ...(endsIt ? { status: end.status } : {}),
        ...(keepsSummary ? { summary: end.summary, summarySource: end.source } : {}),
        ...(end.error !== undefined && end.error !== "" ? { error: end.error } : {}),
    };
};

// task_started is the only message with a tool_use id, so only it opens a record; task_updated pairs back via TASKS.
// Not every task is an agent: the stream also carries shell/monitor/workflow work, filtered by `isSubagentTask`.

// The fields the daemon reads off the SDK's four task_* message shapes.
export interface SubagentTaskMessage {
    readonly subtype: string;
    readonly task_id?: string;
    readonly tool_use_id?: string;
    readonly description?: string;
    // The CLI's raw discriminant; an open string since the SDK adds values to it without notice.
    readonly task_type?: string;
    readonly subagent_type?: string;
    readonly prompt?: string;
    readonly skip_transcript?: boolean;
    readonly status?: string;
    readonly summary?: string;
    readonly last_tool_name?: string;
    readonly usage?: { readonly total_tokens?: number; readonly tool_uses?: number; readonly duration_ms?: number };
    readonly patch?: { readonly status?: string; readonly end_time?: number; readonly error?: string; readonly is_backgrounded?: boolean };
}

// A task id to the record it opened, held by the turn's conversation; only task_started carries both.
const TASKS: Holding<string> = { name: "subagent tasks" };

// True only when `subagent_type` is set or `task_type` is `local_agent`, deliberately a whitelist so an unknown future
// type is left off. Adopted later anyway via SubagentStop's meta file if unlabelled.
const isSubagentTask = (message: SubagentTaskMessage): boolean => message.subagent_type !== undefined || message.task_type === "local_agent";

// SubagentStatusSchema's own vocabulary; an SDK status we don't recognize leaves the record's status unchanged.
const STATUSES: ReadonlySet<string> = new Set<SubagentStatus>(["pending", "running", "completed", "failed", "killed", "paused"]);
const statusOf = (value: string | undefined): SubagentStatus | undefined =>
    value !== undefined && STATUSES.has(value) ? (value as SubagentStatus) : undefined;

// Maps task_notification's own status words, not the task vocabulary, to ours; 'stopped' becomes `killed`.
const NOTIFIED: Record<string, SubagentStatus> = { completed: "completed", failed: "failed", stopped: "killed" };

/** Folds one SDK task message into the registry; returns the frame it produced, if any. */
export const noteSubagentTask = (turn: SubagentTurn, message: SubagentTaskMessage): AgentEvent | undefined => {
    const actors = turn.conversations;
    const records = actors.holdings(ROSTER);
    const tasks = actors.holdings(TASKS);
    if (message.subtype === "task_started") {
        const id = message.tool_use_id;
        if (id === undefined || message.skip_transcript === true || !isSubagentTask(message) || records.has(id)) {
            return undefined;
        }
        if (message.task_id !== undefined) {
            tasks.hold(turn.conversationId, message.task_id, id);
        }
        return bornFrame(
            open(turn, id, "subagent", {
                ...(message.subagent_type !== undefined ? { agentType: message.subagent_type } : {}),
                ...(message.description !== undefined ? { description: message.description } : {}),
            }),
        );
    }
    if (message.subtype === "task_progress") {
        const id = message.tool_use_id ?? (message.task_id !== undefined ? tasks.get(message.task_id) : undefined);
        return id === undefined
            ? undefined
            : patch(actors, id, {
                  ...(message.usage?.total_tokens !== undefined ? { tokens: message.usage.total_tokens } : {}),
                  ...(message.usage?.tool_uses !== undefined ? { toolUses: message.usage.tool_uses } : {}),
                  ...(message.last_tool_name !== undefined ? { lastTool: message.last_tool_name } : {}),
                  ...(message.summary !== undefined ? { summary: message.summary } : {}),
              });
    }
    if (message.subtype === "task_updated") {
        const id = message.task_id !== undefined ? tasks.get(message.task_id) : undefined;
        const status = statusOf(message.patch?.status);
        return id === undefined
            ? undefined
            : patch(actors, id, {
                  ...(status !== undefined ? { status } : {}),
                  ...(message.patch?.error !== undefined ? { error: message.patch.error } : {}),
                  ...(message.patch?.is_backgrounded !== undefined ? { background: message.patch.is_backgrounded } : {}),
              });
    }
    if (message.subtype === "task_notification") {
        const id = message.tool_use_id ?? (message.task_id !== undefined ? tasks.get(message.task_id) : undefined);
        const record = id !== undefined ? records.get(id) : undefined;
        // Weakest of the three endings; routed through `ending` so a report already delivered wins over it.
        return record === undefined
            ? undefined
            : patch(actors, record.id, {
                  ...ending(record, {
                      source: "notification",
                      ...(message.status !== undefined && NOTIFIED[message.status] !== undefined ? { status: NOTIFIED[message.status] } : {}),
                      ...(message.summary !== undefined ? { summary: message.summary } : {}),
                  }),
                  ...(message.usage?.total_tokens !== undefined ? { tokens: message.usage.total_tokens } : {}),
                  ...(message.usage?.tool_uses !== undefined ? { toolUses: message.usage.tool_uses } : {}),
              });
    }
    return undefined;
};

// SubagentStart cannot read a child's meta file yet (written only once it resolves), so it just records the session's
// child directory; SubagentStop can, and does the full read. Neither hook emits a frame.

interface SubagentMeta {
    readonly agentType?: string;
    readonly description?: string;
    readonly toolUseId?: string;
    readonly spawnDepth?: number;
    readonly model?: string;
}

const readMeta = async (metaPath: string): Promise<SubagentMeta | undefined> => {
    try {
        return JSON.parse(await readFile(metaPath, "utf8")) as SubagentMeta;
    } catch {
        // Missing or unreadable meta: the child stays listed from its task messages, only the transcript door closes.
        return undefined;
    }
};

// A session's children live in `<session-dir-without-.jsonl>/subagents/`, beside its transcript.
const subagentsDirOf = (sessionTranscriptPath: string): string => join(sessionTranscriptPath.replace(/\.jsonl$/u, ""), "subagents");

// `??=` throughout: an earlier spawn-call or task-stream value is never overwritten by the meta file.
const fill = (record: SubagentRecord, meta: SubagentMeta, agentId: string): void => {
    record.agentId = agentId;
    record.agentType ??= meta.agentType;
    record.description ??= meta.description;
    record.model ??= namedModel(meta.model);
    record.spawnDepth ??= meta.spawnDepth;
};

// Adopts a child from its meta file; if no record exists yet (a hook beating task_started), opens one keyed by
// `toolUseId`.
const adopt = (turn: SubagentTurn, meta: SubagentMeta, agentId: string): void => {
    const id = meta.toolUseId;
    if (id === undefined) {
        return;
    }
    fill(turn.conversations.holdings(ROSTER).get(id) ?? open(turn, id, "subagent", {}), meta, agentId);
};

// A backgrounded child often outlives SubagentStop, so that hook alone cannot pair every child. By directory, held by
// the conversation whose records point at it.
const META_FILES: Holding<Map<string, SubagentMeta>> = { name: "subagent meta files" };
// One pass per directory at a time, so readers arriving together share the one read.
const PASSES: Holding<Promise<void>> = { name: "subagent meta passes" };

// A meta file is written once at child start and never touched again, so it is read at most once.
const metaOf = async (actors: Actors, dir: string, holder: string): Promise<Map<string, SubagentMeta>> => {
    const cache = actors.holdings(META_FILES);
    const seen = cache.get(dir) ?? new Map<string, SubagentMeta>();
    cache.hold(holder, dir, seen);
    for (const entry of await readdir(dir).catch(() => [])) {
        const agentId = /^agent-(.+)\.meta\.json$/u.exec(entry)?.[1];
        if (agentId === undefined || seen.has(agentId)) {
            continue;
        }
        const meta = await readMeta(join(dir, entry));
        if (meta !== undefined) {
            seen.set(agentId, meta);
        }
    }
    return seen;
};

// Fills existing records only; opening one here could resurrect a child already aged out of the roster.
const scan = async (actors: Actors, dir: string, holder: string): Promise<void> => {
    let changed = false;
    for (const [agentId, meta] of await metaOf(actors, dir, holder)) {
        const record = meta.toolUseId === undefined ? undefined : actors.holdings(ROSTER).get(meta.toolUseId);
        if (record !== undefined && record.agentId === undefined) {
            fill(record, meta, agentId);
            changed = true;
        }
    }
    // Publishes but emits no frame: no update frame has a slot for fields the born frame already carried.
    if (changed) {
        publishRuntimeChange("subagents");
        notifyChanged(actors);
    }
};

const pair = async (actors: Actors, dir: string, holder: string): Promise<void> => {
    const passes = actors.holdings(PASSES);
    const running = passes.get(dir) ?? scan(actors, dir, holder).finally(() => passes.drop(dir));
    passes.hold(holder, dir, running);
    await running;
};

// Cached on the record once resolved: the SDK agent id a child was assigned never changes.
export const subagentAgentId = async (actors: Actors, id: string): Promise<string | undefined> => {
    const record = actors.holdings(ROSTER).get(id);
    if (record === undefined || record.agentId !== undefined) {
        return record?.agentId;
    }
    if (record.turn.subagentsDir === undefined) {
        return undefined;
    }
    await pair(actors, record.turn.subagentsDir, record.conversationId);
    return record.agentId;
};

/** Pairs only children still running; costs one directory read per session with an unpaired child. */
export const pairLiveSubagents = async (actors: Actors): Promise<void> => {
    const known = new Set<string>();
    // Each directory still to read, with the conversation whose records point at it.
    const unpaired = new Map<string, string>();
    for (const [, record] of actors.holdings(ROSTER).entries()) {
        const dir = record.turn.subagentsDir;
        if (dir !== undefined) {
            known.add(dir);
            if (record.agentId === undefined && subagentRunning(record)) {
                unpaired.set(dir, record.conversationId);
            }
        }
    }
    // A directory's cache is dropped once no record in the roster points at it anymore.
    const cache = actors.holdings(META_FILES);
    for (const [dir] of cache.entries()) {
        if (!known.has(dir)) {
            cache.drop(dir);
        }
    }
    await Promise.all([...unpaired].map(([dir, holder]) => pair(actors, dir, holder)));
};

/** Whether anything checked a child's work: the stamped verdict once it has ended. */
export const subagentVerification = (actors: Actors, id: string): SubagentVerification | undefined =>
    actors.holdings(ROSTER).get(id)?.verification ?? childVerification(actors, id);

export const subagentHooks = (turn: SubagentTurn): Partial<Record<HookEvent, HookCallbackMatcher[]>> => ({
    // Appends the verification verdict to the Task tool's result as the parent reads it, via `additionalContext` rather
    // than rewriting the report itself. Nothing is appended when there is nothing to warn about.
    PostToolUse: [
        {
            matcher: "Task",
            hooks: [
                async (input): Promise<{ continue: true; hookSpecificOutput?: { hookEventName: "PostToolUse"; additionalContext: string } }> => {
                    if (input.hook_event_name !== "PostToolUse") {
                        return { continue: true };
                    }
                    const verification = subagentVerification(turn.conversations, input.tool_use_id);
                    const note = verification === undefined ? undefined : childVerificationNote(verification);
                    return note === undefined
                        ? { continue: true }
                        : { continue: true, hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: note } };
                },
            ],
        },
    ],
    SubagentStart: [
        {
            hooks: [
                async (input): Promise<{ continue: true }> => {
                    if (input.hook_event_name === "SubagentStart") {
                        turn.subagentsDir = subagentsDirOf(input.transcript_path);
                    }
                    return { continue: true };
                },
            ],
        },
    ],
    SubagentStop: [
        {
            hooks: [
                async (input): Promise<{ continue: true }> => {
                    if (input.hook_event_name !== "SubagentStop") {
                        return { continue: true };
                    }
                    const transcriptPath = input.agent_transcript_path;
                    const meta = await readMeta(join(dirname(transcriptPath), `${basename(transcriptPath, ".jsonl")}.meta.json`));
                    if (meta === undefined) {
                        return { continue: true };
                    }
                    adopt(turn, meta, input.agent_id);
                    // Child's own last words go in as `report`, the strongest source; status is not set here since only
                    // the task stream distinguishes finishing, failing, or being cut short.
                    const child = meta.toolUseId !== undefined ? turn.conversations.holdings(ROSTER).get(meta.toolUseId) : undefined;
                    if (child !== undefined && input.last_assistant_message !== undefined) {
                        patch(turn.conversations, child.id, ending(child, { summary: input.last_assistant_message, source: "report" }));
                    }
                    return { continue: true };
                },
            ],
        },
    ],
});

// The daemon runs these children directly and reports each move by call, not by sniffing a stream. The record's id is
// the child's own conversation id, so spawn, wait, and the roster all name it the same way.

// Feeds the parent's live frame log; a service call has no stream of its own to draw from.
const pushToParentRun = (actors: Actors, conversationId: string, frame: AgentEvent | undefined): void => {
    if (frame === undefined) {
        return;
    }
    turnRunOf(actors, conversationId)?.push(frame);
};

export interface SpawnedChildBirth {
    // The child's conversation id; also the record's id.
    readonly id: string;
    readonly description?: string;
    // Provider display label ("Cursor", "Codex"); the first half of the row's `Cursor · Port the parser`.
    readonly agentType?: string;
    readonly model?: string;
    readonly provider?: AgentProvider;
    readonly harness?: AgentHarness;
    readonly spawnDepth?: number;
}

/**
 * Opens a roster record for a child the service just started, and announces it into the parent's live stream. A settled
 * record under the same id is replaced whole, a follow-up `send`; a live one is left alone unless `replacing`, a start
 * the owner just allowed taking over the row that waited for them.
 */
export const openSpawnedChild = (turn: SubagentTurn, birth: SpawnedChildBirth, replacing = false): void => {
    const roster = turn.conversations.holdings(ROSTER);
    const existing = roster.get(birth.id);
    if (existing !== undefined && subagentRunning(existing) && !replacing) {
        return;
    }
    roster.drop(birth.id);
    const record = open(turn, birth.id, "spawned", {
        background: true,
        ...(birth.description !== undefined ? { description: birth.description } : {}),
        ...(birth.agentType !== undefined ? { agentType: birth.agentType } : {}),
        ...(birth.model !== undefined ? { model: birth.model } : {}),
        ...(birth.provider !== undefined ? { provider: birth.provider } : {}),
        ...(birth.harness !== undefined ? { harness: birth.harness } : {}),
        ...(birth.spawnDepth !== undefined ? { spawnDepth: birth.spawnDepth } : {}),
    });
    pushToParentRun(turn.conversations, turn.conversationId, bornFrame(record));
};

/**
 * A live move in the child's own turn: working, blocked with a reason, or running totals; dropped once the record is
 * settled.
 */
export const noteSpawnedChild = (
    actors: Actors,
    id: string,
    move: {
        // `pending` is a child queued for memory before its turn starts.
        readonly status?: "pending" | "running" | "blocked";
        // On `blocked` or `pending`, what it waits on; unset source so the real report replaces it once unblocked.
        readonly summary?: string;
        readonly lastTool?: string;
        readonly toolUses?: number;
        readonly tokens?: number;
    },
): void => {
    const record = actors.holdings(ROSTER).get(id);
    if (record === undefined || !subagentRunning(record)) {
        return;
    }
    pushToParentRun(actors, record.conversationId, patch(actors, id, move));
};

/**
 * The child's turn ended; its closing text becomes the report, cut at the head where the answer is. `killed` is a runtime
 * that died under it, whose session a follow-up can still continue.
 */
export const settleSpawnedChild = (
    actors: Actors,
    id: string,
    outcome: { readonly status: "completed" | "failed" | "killed"; readonly report: string; readonly error?: string },
): void => {
    const record = actors.holdings(ROSTER).get(id);
    if (record === undefined) {
        return;
    }
    const summary = outcome.report.trim().slice(0, REPORT_TAIL).trim();
    pushToParentRun(
        actors,
        record.conversationId,
        patch(
            actors,
            id,
            ending(record, {
                status: outcome.status,
                source: "report",
                ...(summary !== "" ? { summary } : {}),
                ...(outcome.error !== undefined && outcome.error !== "" ? { error: outcome.error } : {}),
            }),
        ),
    );
};

// Race-free wait primitive behind the wait tool (subagent-wait.ts): the listener is added before the first evaluation,
// and notifyChanged runs synchronously inside every patch, so a flickering state still gets evaluated while it holds.

export type SubagentWaitUntil = "blocked" | "finished";

export interface SubagentWaitOptions {
    // The child's id; absent means any child of the conversation.
    readonly target?: string;
    readonly until: readonly SubagentWaitUntil[];
    readonly timeoutMs: number;
    readonly signal?: AbortSignal;
}

export interface SubagentWaitOutcome {
    readonly outcome: SubagentWaitUntil | "timeout" | "aborted" | "unknown-target";
    // The child that satisfied the wait, or the target's current snapshot on a timeout.
    readonly matched?: SubagentSession;
}

const waitMatch = (record: SubagentRecord, until: readonly SubagentWaitUntil[], any: boolean): SubagentWaitUntil | undefined => {
    // A named child answers with its state however often it is asked.
    if (any && record.reported === record.status) {
        return undefined;
    }
    if (until.includes("blocked") && record.status === "blocked") {
        return "blocked";
    }
    if (until.includes("finished") && !subagentRunning(record)) {
        return "finished";
    }
    return undefined;
};

export const waitForSubagent = (actors: Actors, conversationId: string, options: SubagentWaitOptions): Promise<SubagentWaitOutcome> =>
    new Promise((resolve) => {
        const records = actors.holdings(ROSTER);
        const waiters = actors.holdings(WAITERS);
        const waiter = randomUUID();
        const candidates = (): SubagentRecord[] =>
            records.of(conversationId).filter((record) => options.target === undefined || record.id === options.target);
        // oxlint-disable-next-line prefer-const -- A later branch assigns and clears this binding.
        let timer: ReturnType<typeof setTimeout> | undefined;
        const settle = (result: SubagentWaitOutcome): void => {
            waiters.drop(waiter);
            options.signal?.removeEventListener("abort", onAbort);
            if (timer !== undefined) {
                clearTimeout(timer);
            }
            resolve(result);
        };
        const onAbort = (): void => settle({ outcome: "aborted" });
        const evaluate = (): void => {
            const found = candidates();
            for (const record of found) {
                const matched = waitMatch(record, options.until, options.target === undefined);
                if (matched !== undefined) {
                    // Marked in the step that settles, before anything else can ask.
                    record.reported = record.status;
                    settle({ outcome: matched, matched: wire(record) });
                    return;
                }
            }
            // No live candidate remains and none can appear mid-wait; answer unknown-target now, not after a timeout.
            if (!found.some(subagentRunning)) {
                settle({ outcome: "unknown-target", ...(found.length === 1 ? { matched: wire(found[0]!) } : {}) });
            }
        };
        if (options.signal?.aborted === true) {
            resolve({ outcome: "aborted" });
            return;
        }
        options.signal?.addEventListener("abort", onAbort, { once: true });
        timer = setTimeout(() => {
            const snapshot = options.target !== undefined ? records.get(options.target) : undefined;
            settle({ outcome: "timeout", ...(snapshot !== undefined ? { matched: wire(snapshot) } : {}) });
        }, options.timeoutMs);
        timer.unref();
        // Listener added before the first look, the ordering that makes this race-free.
        waiters.hold(conversationId, waiter, evaluate);
        evaluate();
    });

/** Whether a wait already handed this child's ending to its parent. */
export const subagentEndingReported = (actors: Actors, id: string): boolean => {
    const reported = actors.holdings(ROSTER).get(id)?.reported;
    return reported !== undefined && !LIVE.has(reported);
};

/**
 * Files a settled child's ending as handed over by the other door, a report said into the parent's turn, so a later
 * `wait` on "any" does not hand the same ending over a second time. A live record has no ending to file.
 */
export const markSubagentEndingReported = (actors: Actors, id: string): void => {
    const record = actors.holdings(ROSTER).get(id);
    if (record !== undefined && !subagentRunning(record)) {
        record.reported = record.status;
    }
};

/**
 * Settles every still-live child of this turn as it ends, so one the SDK never reported a terminal status for does not
 * sit 'running' forever.
 */
export const closeSubagents = (actors: Actors, conversationId: string): AgentEvent[] => {
    const frames: AgentEvent[] = [];
    for (const record of actors.holdings(ROSTER).of(conversationId)) {
        // Not spawned children: their turn outlives the parent's, and the service settles them from their own ending.
        if (record.kind !== "spawned" && subagentRunning(record)) {
            const frame = patch(actors, record.id, { status: "killed" });
            if (frame !== undefined) {
                frames.push(frame);
            }
        }
    }
    return frames;
};

// Empties the roster and everything kept beside it; tests drive the registry through its real entry points and need to
// start empty.
export const resetSubagents = (actors: Actors): void => {
    actors.holdings(ROSTER).clear();
    actors.holdings(TASKS).clear();
    actors.holdings(SPAWNS).clear();
    actors.holdings(META_FILES).clear();
    actors.holdings(PASSES).clear();
    actors.holdings(WAITERS).clear();
    resetChildVerification(actors);
};
