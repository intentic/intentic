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
import { publishRuntimeChange } from "../../system/runtime-watch.js";
import { childVerification, childVerificationNote, forgetChild, resetChildVerification } from "./child-verification.js";
import { turnRunOf } from "../run/turn/turn-runs.js";

// The registry of subagents the daemon can name, read by the Subagents area and the rail; the third registry of its
// kind after terminal and browser sessions, with its own short retention window. An SDK child is keyed by the spawning
// tool call's id, a spawned one by its own conversation id.

// Short on purpose: a turn can spawn a dozen children at once, far faster than browsers age (two hours).
const RETAIN_FINISHED_MS = 5 * 60_000;

// Report text kept in the summary and list row; the rest is the transcript's job.
const REPORT_TAIL = 500;

interface SubagentRecord {
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
}

const records = new Map<string, SubagentRecord>();

// Drop records aged past RETAIN_FINISHED_MS; called on every list and every write.
const sweep = (now: number): void => {
    for (const [id, record] of records) {
        if (record.endedAt !== undefined && now - record.endedAt > RETAIN_FINISHED_MS) {
            records.delete(id);
            // The verification ledger's life matches the record's; its verdict was already copied onto the record.
            forgetChild(id);
        }
    }
};

const LIVE: ReadonlySet<SubagentStatus> = new Set<SubagentStatus>(["pending", "running", "blocked", "paused"]);
export const subagentRunning = (record: Pick<SubagentSession, "status">): boolean => LIVE.has(record.status);

// Notified synchronously on every open() and patch(), which makes waitForSubagent race-free: a listener added before
// the read cannot miss a transition. Not the runtime-watch bus, which rate-limits per domain.
const waiters = new Set<() => void>();
const notifyChanged = (): void => {
    for (const listener of waiters) {
        listener();
    }
};

// Which children the parent walked away from, marked by the spawning tool call since the SDK's own `is_backgrounded`
// patch never arrives for one. Marked before the record exists; `open` consumes the mark onto the born frame.
const backgrounded = new Set<string>();

/** Marks a spawning tool call id as backgrounded, ahead of the task_started that will read it. */
export const noteSubagentSpawn = (id: string): void => {
    backgrounded.add(id);
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
export const listSubagentSessions = (): SubagentSession[] => {
    sweep(Date.now());
    return [...records.values()]
        .map(wire)
        .toSorted((left, right) => Number(subagentRunning(right)) - Number(subagentRunning(left)) || right.activityAt - left.activityAt);
};

/**
 * Everything subagent-transcript.ts needs to read one child's transcript, nothing the wire carries. Undefined: no such
 * record (never started, or aged out).
 */
export const subagentSource = (
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
    const record = records.get(id);
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

/**
 * Whether a live child is working in the parent's own checkout, the rebase gate's question: an SDK subagent edits it
 * directly, a spawned child has its own worktree.
 */
export const subagentInParentTree = (conversationId: string): boolean =>
    [...records.values()].some((record) => record.conversationId === conversationId && record.kind !== "spawned" && subagentRunning(record));

/** Live and total child counts for a conversation, the fleet card's count chip. */
export const subagentCountsOf = (conversationId: string): { readonly running: number; readonly total: number } => {
    let running = 0;
    let total = 0;
    for (const record of records.values()) {
        if (record.conversationId !== conversationId) {
            continue;
        }
        total += 1;
        if (subagentRunning(record)) {
            running += 1;
        }
    }
    return { running, total };
};

// One handle per turn, held for its life and shared by every child it opens, so a late-learned fact reaches children
// born earlier. `sessionId` fills from the stream's first frame; `subagentsDir` from the first child's start hook.
export interface SubagentTurn {
    readonly conversationId: string;
    readonly cwd: string;
    sessionId: string | undefined;
    subagentsDir: string | undefined;
}

const open = (turn: SubagentTurn, id: string, kind: SubagentKind, fields: Partial<SubagentRecord>): SubagentRecord => {
    const now = Date.now();
    sweep(now);
    const record: SubagentRecord = {
        id,
        kind,
        conversationId: turn.conversationId,
        agentType: undefined,
        description: undefined,
        model: undefined,
        provider: undefined,
        harness: undefined,
        spawnDepth: undefined,
        background: backgrounded.delete(id) ? true : undefined,
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
        ...fields,
    };
    records.set(id, record);
    // Tells surfaces not watching this conversation, the rail, the Subagents area, that a child was born.
    publishRuntimeChange("subagents");
    notifyChanged();
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
const patch = (id: string, fields: Partial<SubagentRecord>): AgentEvent | undefined => {
    const record = records.get(id);
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
        record.verification = childVerification(record.id);
    }
    // Fires only on real change; a no-op patch already returned above.
    publishRuntimeChange("subagents");
    notifyChanged();
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

// task_started is the only message with a tool_use id, so only it opens a record; task_updated pairs back via `tasks`.
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

const tasks = new Map<string, string>();

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
    if (message.subtype === "task_started") {
        const id = message.tool_use_id;
        if (id === undefined || message.skip_transcript === true || !isSubagentTask(message) || records.has(id)) {
            return undefined;
        }
        if (message.task_id !== undefined) {
            tasks.set(message.task_id, id);
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
            : patch(id, {
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
            : patch(id, {
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
            : patch(record.id, {
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

// Copies the meta file's facts onto the record; all but agentId use `??=` since the task stream usually got there
// first.
const fill = (record: SubagentRecord, meta: SubagentMeta, agentId: string): void => {
    record.agentId = agentId;
    record.agentType ??= meta.agentType;
    record.description ??= meta.description;
    record.model ??= meta.model;
    record.spawnDepth ??= meta.spawnDepth;
};

// Adopts a child from its meta file; if no record exists yet (a hook beating task_started), opens one keyed by
// `toolUseId`.
const adopt = (turn: SubagentTurn, meta: SubagentMeta, agentId: string): void => {
    const id = meta.toolUseId;
    if (id === undefined) {
        return;
    }
    fill(records.get(id) ?? open(turn, id, "subagent", {}), meta, agentId);
};

// Which SDK agent a child is, resolved from the session's meta files at read time (a backgrounded child often outlives
// SubagentStop, so that hook cannot always do the pairing). Cached once resolved.
export const subagentAgentId = async (id: string): Promise<string | undefined> => {
    const record = records.get(id);
    if (record === undefined || record.agentId !== undefined) {
        return record?.agentId;
    }
    const dir = record.turn.subagentsDir;
    if (dir === undefined) {
        return undefined;
    }
    for (const entry of await readdir(dir).catch(() => [])) {
        const agentId = /^agent-(.+)\.meta\.json$/u.exec(entry)?.[1];
        if (agentId === undefined) {
            continue;
        }
        const meta = await readMeta(join(dir, entry));
        if (meta?.toolUseId === id) {
            fill(record, meta, agentId);
            return agentId;
        }
    }
    return undefined;
};

/**
 * Whether anything checked a child's work: the stamped verdict once it has ended, else the live standing (a foreground
 * child's result can reach its parent before the task stream marks it over).
 */
export const subagentVerification = (id: string): SubagentVerification | undefined => records.get(id)?.verification ?? childVerification(id);

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
                    const verification = subagentVerification(input.tool_use_id);
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
                    const child = meta.toolUseId !== undefined ? records.get(meta.toolUseId) : undefined;
                    if (child !== undefined && input.last_assistant_message !== undefined) {
                        patch(child.id, ending(child, { summary: input.last_assistant_message, source: "report" }));
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
const pushToParentRun = (conversationId: string, frame: AgentEvent | undefined): void => {
    if (frame === undefined) {
        return;
    }
    turnRunOf(conversationId)?.push(frame);
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
 * record under the same id is replaced whole, a follow-up `send`; a live one is left alone.
 */
export const openSpawnedChild = (turn: SubagentTurn, birth: SpawnedChildBirth): void => {
    const existing = records.get(birth.id);
    if (existing !== undefined && subagentRunning(existing)) {
        return;
    }
    records.delete(birth.id);
    const record = open(turn, birth.id, "spawned", {
        background: true,
        ...(birth.description !== undefined ? { description: birth.description } : {}),
        ...(birth.agentType !== undefined ? { agentType: birth.agentType } : {}),
        ...(birth.model !== undefined ? { model: birth.model } : {}),
        ...(birth.provider !== undefined ? { provider: birth.provider } : {}),
        ...(birth.harness !== undefined ? { harness: birth.harness } : {}),
        ...(birth.spawnDepth !== undefined ? { spawnDepth: birth.spawnDepth } : {}),
    });
    pushToParentRun(turn.conversationId, bornFrame(record));
};

/**
 * A live move in the child's own turn: working, blocked with a reason, or running totals; dropped once the record is
 * settled.
 */
export const noteSpawnedChild = (
    id: string,
    move: {
        readonly status?: "running" | "blocked";
        // On `blocked`, what it waits on; unset source so the real report replaces it once unblocked.
        readonly summary?: string;
        readonly lastTool?: string;
        readonly toolUses?: number;
        readonly tokens?: number;
    },
): void => {
    const record = records.get(id);
    if (record === undefined || !subagentRunning(record)) {
        return;
    }
    pushToParentRun(record.conversationId, patch(id, move));
};

/** The child's turn ended; its closing text becomes the report, cut at the head where the answer is. */
export const settleSpawnedChild = (id: string, outcome: { readonly failed: boolean; readonly report: string; readonly error?: string }): void => {
    const record = records.get(id);
    if (record === undefined) {
        return;
    }
    const summary = outcome.report.trim().slice(0, REPORT_TAIL).trim();
    pushToParentRun(
        record.conversationId,
        patch(
            id,
            ending(record, {
                status: outcome.failed ? "failed" : "completed",
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

const waitMatch = (record: SubagentRecord, until: readonly SubagentWaitUntil[]): SubagentWaitUntil | undefined => {
    if (until.includes("blocked") && record.status === "blocked") {
        return "blocked";
    }
    if (until.includes("finished") && !subagentRunning(record)) {
        return "finished";
    }
    return undefined;
};

export const waitForSubagent = (conversationId: string, options: SubagentWaitOptions): Promise<SubagentWaitOutcome> =>
    new Promise((resolve) => {
        const candidates = (): SubagentRecord[] =>
            [...records.values()].filter(
                (record) => record.conversationId === conversationId && (options.target === undefined || record.id === options.target),
            );
        // oxlint-disable-next-line prefer-const -- assigned in a later branch and cleared in another; the declaration cannot be merged with either.
        let timer: ReturnType<typeof setTimeout> | undefined;
        const settle = (result: SubagentWaitOutcome): void => {
            waiters.delete(evaluate);
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
                const matched = waitMatch(record, options.until);
                if (matched !== undefined) {
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
        waiters.add(evaluate);
        evaluate();
    });

/**
 * Settles every still-live child of this turn as it ends, so one the SDK never reported a terminal status for does not
 * sit 'running' forever.
 */
export const closeSubagents = (conversationId: string): AgentEvent[] => {
    const frames: AgentEvent[] = [];
    for (const record of records.values()) {
        // Not spawned children: their turn outlives the parent's, and the service settles them from their own ending.
        if (record.conversationId === conversationId && record.kind !== "spawned" && subagentRunning(record)) {
            const frame = patch(record.id, { status: "killed" });
            if (frame !== undefined) {
                frames.push(frame);
            }
        }
    }
    return frames;
};

// Resets all module state; tests drive the registry through its real entry points and need to start empty.
export const resetSubagents = (): void => {
    records.clear();
    tasks.clear();
    backgrounded.clear();
    waiters.clear();
    resetChildVerification();
};
