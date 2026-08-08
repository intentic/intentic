import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { HookCallbackMatcher, HookEvent } from "@anthropic-ai/claude-agent-sdk";
import type { AgentEvent, SubagentKind, SubagentSession, SubagentStatus } from "@intentic/sandbox-contract";
import { publishRuntimeChange } from "../system/runtime-watch.js";

/* THE AGENTS AN AGENT STARTS, AS THINGS THE DAEMON CAN NAME.
 *
 * A turn that delegates used to be almost invisible. The SDK reports a subagent's whole life on the stream —
 * task_started, task_progress, task_updated, task_notification — and every one of those was dropped for having
 * "no UI mapping", so the only trace of a child was the tool rows the client nested under its Agent card. That
 * is thin for a foreground child and nothing at all for a BACKGROUNDED one, which is the Agent tool's default:
 * the parent fires it and walks away, so the card sits on a spinner for minutes with no status, no spend, and no
 * way to see what it is doing. A `codex exec` the agent drove from its own Bash was worse still — a command card
 * and a tmux window, with nothing saying an agent had run at all.
 *
 * This module is the record those surfaces read, and it is deliberately the third of its kind rather than a new
 * idea: the agent's shell (terminal/terminal-session.ts) and the agent's browser (browser/browser-sessions.ts)
 * are already daemon-held registries with a /system list route, an appear-on-content rail tile, and a door from
 * the tool card that spawned them. A subagent is the same kind of fact — something a turn started that the
 * operator may want to look at — so it lists the same way, ages out the same way, and is named by the same rule.
 * Its retention window is its own, and much shorter; RETAIN_FINISHED_MS says why.
 *
 * WHAT IS DIFFERENT is what "look at it" means. A shell is one stream of bytes and a browser is a live page; a
 * subagent has neither. What it has is a TRANSCRIPT, so there is no third WebSocket here — sessions/
 * subagent-transcript.ts serves one, live from the parent turn's frame log while it runs and from the provider's
 * own store once it has finished. The one exception is a delegation, which does have a process: it runs in the
 * turn's tmux session, and `terminal` names it so the card can keep offering to watch that too.
 *
 * A RECORD IS KEYED BY THE SPAWNING TOOL CALL'S ID. That is the only key every source already carries — the
 * SDK's per-subagent meta file, its task messages, and the `parentToolUseId` the client nests inner frames
 * under — so the card that spawned a child and the child itself point at each other with an id both already
 * hold. The ids the transcripts are actually read with (the SDK's agent id, a Codex thread, an OpenCode
 * session) never reach the wire, because no surface asks a question they answer. */

/* A finished subagent stays listable this long, so its report is still readable just after the turn that ran it
 * ended — then it goes. SHORT on purpose, and shorter than the browsers' two hours: a turn spawns children at a
 * rate nothing else on the rail comes close to (a single verification pass can start a dozen), so a window sized
 * for "what did the agent open today" turns this list into a log nobody prunes. What a finished child is worth
 * looking at for is the minutes right after it reports; past that the parent's own transcript is the record. */
const RETAIN_FINISHED_MS = 5 * 60_000;

// A delegation's report is the tail of what its CLI printed. Bounded because this rides on a card and in a list
// row: the whole of a Codex run's stdout is the transcript's job, not the summary's.
const REPORT_TAIL = 500;

interface SubagentRecord {
    readonly id: string;
    readonly kind: SubagentKind;
    readonly conversationId: string;
    agentType: string | undefined;
    description: string | undefined;
    model: string | undefined;
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
    terminal: string | undefined;
    /* --- how its transcript is READ. Daemon-side only; see the header. ---
     * The TURN itself rather than a copy of what it knew when the child was born: its session id is filled from
     * the stream's first frame and the directory below from the first child's start hook, both of which can land
     * after a record is opened. A snapshot taken at `open` froze whichever of them had not arrived yet. */
    readonly turn: SubagentTurn;
    // The SDK's own id for the child — half of what getSubagentMessages reads a transcript with, and the half
    // only the child's meta file can pair to the tool call that spawned it. Cached here once resolved; see
    // subagentAgentId for when that happens and why it cannot happen sooner.
    agentId: string | undefined;
    // A delegated thread/session id, but ONLY when the command named one (`codex exec resume <id>`,
    // `opencode run --session <id>`). A fresh delegation prints its id and we do not parse stdout for it: the
    // reader resolves it from the provider's own store by cwd and start time, which no output format can break.
    thread: string | undefined;
}

const records = new Map<string, SubagentRecord>();

// Drop what has aged out. Called on every list and every write, so a quiet sandbox does not hold a finished
// turn's children forever (the browser registry's rule).
const sweep = (now: number): void => {
    for (const [id, record] of records) {
        if (record.endedAt !== undefined && now - record.endedAt > RETAIN_FINISHED_MS) {
            records.delete(id);
        }
    }
};

const LIVE: ReadonlySet<SubagentStatus> = new Set<SubagentStatus>(["pending", "running", "paused"]);
export const subagentRunning = (record: Pick<SubagentSession, "status">): boolean => LIVE.has(record.status);

/* WHICH CHILDREN THE PARENT WALKED AWAY FROM — marked by the spawning tool call, because nothing else says so.
 *
 * The SDK models it as `is_backgrounded` on a task_updated patch, and that patch does not come: a child started
 * with `run_in_background` was watched through its whole life here — born, worked, reported, finished — without
 * the field ever being set once. So the card's "background" pill, the one label that explains why a call can sit
 * unfinished while the turn moves on underneath it, could never render.
 *
 * Marked BEFORE the record exists, which is the ordering the stream actually has: the tool_use block arrives
 * ahead of the `task_started` that opens one (the client's reducer leans on the same fact). `open` consumes the
 * mark, so the flag rides the BORN frame — the only frame that carries it. */
const backgrounded = new Set<string>();

/** The tool call that spawned a child, as it streams: whether the parent walked away from this one. */
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
    ...(record.terminal !== undefined ? { terminal: record.terminal } : {}),
});

/** Every subagent this sandbox knows about — live first, then most recently active, which is the order a roster
 *  of "what is happening / what just happened" is read in (browsersQuery sorts the browsers the same way). */
export const listSubagentSessions = (): SubagentSession[] => {
    sweep(Date.now());
    return [...records.values()]
        .map(wire)
        .toSorted((left, right) => Number(subagentRunning(right)) - Number(subagentRunning(left)) || right.activityAt - left.activityAt);
};

/** How to READ one subagent's transcript — everything sessions/subagent-transcript.ts needs and nothing the
 *  wire carries. Undefined ⇒ no such record (never started, or aged out of retention). */
export const subagentSource = (
    id: string,
):
    | {
          readonly kind: SubagentKind;
          readonly conversationId: string;
          readonly cwd: string;
          readonly running: boolean;
          readonly startedAt: number;
          // What it was asked to do — the opening user bubble of a transcript rendered from frames, which have no
          // prompt of their own to start from.
          readonly description: string | undefined;
          readonly sessionId: string | undefined;
          readonly thread: string | undefined;
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
        thread: record.thread,
    };
};

/** How many of a conversation's children are live, and how many it has had — the fleet card's count chip. */
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

/* What a turn knows about itself when it spawns something — one handle, held for the turn's life and pointed at
 * by every child it opens, so a fact the turn learns late reaches the children born before it.
 *
 * Both of the mutable fields are learned late, and neither can be waited for. `sessionId` is filled from the
 * stream's first frame — the hooks are wired before the SDK has said which session this turn runs under.
 * `subagentsDir` is filled by the first child's start hook, which is the only place the SDK ever names the
 * directory it files this session's children in. */
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
        terminal: undefined,
        turn,
        agentId: undefined,
        thread: undefined,
        ...fields,
    };
    records.set(id, record);
    // A child was born. The rail's count and the Subagents area both read the roster, and neither should learn
    // about it on its own clock — this is the same roster the AgentEvent stream carries, for the surfaces that
    // are not watching a conversation.
    publishRuntimeChange("subagents");
    return record;
};

const bornFrame = (record: SubagentRecord): AgentEvent => ({
    kind: "subagent",
    id: record.id,
    subagentKind: record.kind,
    ...(record.agentType !== undefined ? { agentType: record.agentType } : {}),
    ...(record.description !== undefined ? { description: record.description } : {}),
    ...(record.model !== undefined ? { model: record.model } : {}),
    ...(record.background !== undefined ? { background: record.background } : {}),
    ...(record.terminal !== undefined ? { terminal: record.terminal } : {}),
});

// Apply a patch and report it, or report nothing when the record is gone or nothing actually moved — a frame per
// no-op progress message would be a stream of updates the client re-renders for free.
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
    if (record.endedAt === undefined && !subagentRunning(record)) {
        record.endedAt = record.activityAt;
    }
    // Every real move: a status, a token count, the tool it just used. This is the chattiest publisher in the
    // daemon by a distance, which is exactly why the bus rate-limits per domain rather than asking each caller
    // to decide what is worth a frame — a no-op patch has already returned above, so what reaches here changed.
    publishRuntimeChange("subagents");
    const update: Extract<AgentEvent, { kind: "subagent_update" }> = { kind: "subagent_update", id };
    return {
        ...update,
        ...(fields.status !== undefined ? { status: record.status } : {}),
        ...(fields.tokens !== undefined ? { tokens: record.tokens } : {}),
        ...(fields.toolUses !== undefined ? { toolUses: record.toolUses } : {}),
        ...(fields.lastTool !== undefined ? { lastTool: record.lastTool } : {}),
        ...(fields.summary !== undefined ? { summary: record.summary } : {}),
        ...(fields.error !== undefined ? { error: record.error } : {}),
    };
};

/* ---- the SDK's own subagents: the task_* stream, keyed by tool_use_id ---------------------------------------
 *
 * The four messages say different things and only one of them opens a record. `task_started` carries the
 * tool_use id, so it is the only one that can — and a task with no tool_use id is not a subagent at all (an
 * ambient/housekeeping task the SDK asks consumers to keep out of the transcript), so it is skipped rather than
 * listed as an agent nobody started. `task_updated` names only its task_id, which is why `tasks` remembers the
 * pairing that `task_started` established.
 *
 * NOT EVERY TASK IS AN AGENT, and reading the stream as though it were is what first shipped here. The SDK runs
 * one task machine for all of its background work — `shell`, `subagent`, `monitor`, `workflow` — so a Bash
 * command sent to the background arrives as a `task_started` with a tool_use id like any other, and filing it
 * listed a shell command as an agent, under its Bash description, with a transcript door that opened on nothing
 * (there is no per-child JSONL for something that was never a child). Hence IS_SUBAGENT: the two fields the SDK
 * sets only for Task-tool children, either of which is enough. */

// The narrow shape of the SDK's task messages, declared here because the daemon reads a handful of fields off a
// union of four types (agent.ts does the same for the stream events it maps).
export interface SubagentTaskMessage {
    readonly subtype: string;
    readonly task_id?: string;
    readonly tool_use_id?: string;
    readonly description?: string;
    // 'shell' | 'subagent' | 'monitor' | 'workflow' | 'local_workflow' — see IS_SUBAGENT. Left an open string
    // because the SDK documents the set as a label that "falls back to the raw discriminant for unknown types".
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

/* Is this task an AGENT, as opposed to the shell/monitor/workflow work the same stream carries? Either field
 * answers yes on its own: `subagent_type` is documented as set only for Task-tool subagents, and `task_type`
 * names the machine's own discriminant. Deliberately a whitelist — an unknown task type the SDK adds later is
 * left off this surface rather than filed as an agent, which is the failure that produced a Subagents list of
 * backgrounded shell commands.
 *
 * A real child that somehow reached us unlabelled is still not lost: the SubagentStop hook adopts it from its
 * own meta file, and that hook fires for nothing else. */
const isSubagentTask = (message: SubagentTaskMessage): boolean => message.subagent_type !== undefined || message.task_type === "subagent";

// The SDK's task status vocabulary is our own (SubagentStatusSchema), so a value it adds that we have never heard
// of leaves the status where it was rather than being coerced into a wrong one.
const STATUSES: ReadonlySet<string> = new Set<SubagentStatus>(["pending", "running", "completed", "failed", "killed", "paused"]);
const statusOf = (value: string | undefined): SubagentStatus | undefined =>
    value !== undefined && STATUSES.has(value) ? (value as SubagentStatus) : undefined;

// A task_notification's terminal status, which is NOT the task vocabulary: "stopped" is what the SDK calls a
// child the user or the parent cut short, and `killed` is that in ours.
const NOTIFIED: Record<string, SubagentStatus> = { completed: "completed", failed: "failed", stopped: "killed" };

/** One SDK task message, folded into the registry. Returns the frame it produced, if any. */
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
        return id === undefined
            ? undefined
            : patch(id, {
                  ...(message.status !== undefined && NOTIFIED[message.status] !== undefined ? { status: NOTIFIED[message.status] } : {}),
                  ...(message.summary !== undefined ? { summary: message.summary } : {}),
                  ...(message.usage?.total_tokens !== undefined ? { tokens: message.usage.total_tokens } : {}),
                  ...(message.usage?.tool_uses !== undefined ? { toolUses: message.usage.tool_uses } : {}),
              });
    }
    return undefined;
};

/* ---- the SubagentStart / SubagentStop hooks: the ids the TRANSCRIPT is read with ----------------------------
 *
 * The task stream names a subagent by the tool call that spawned it; only the hooks name it by its own agent id,
 * which is half of what getSubagentMessages needs. Neither hook carries the tool_use id, so the join runs
 * through the SDK's own per-subagent meta file — which also hands over the description, type, model and spawn
 * depth in one read, and is the authoritative pairing rather than an inference from arrival order (parallel
 * children would break that immediately).
 *
 * WHAT EACH HOOK CAN ACTUALLY DO IS DECIDED BY WHEN THE META FILE EXISTS, and it does not exist at
 * SubagentStart: that hook's return is what lets the child begin, so the file it would be read from is written
 * after it resolves. Waiting there deadlocks against the very write being waited for. So Start does the one
 * thing it uniquely can — name the DIRECTORY this session files its children in, which no other input carries
 * — and the pairing is resolved from that directory later, on demand (subagentAgentId).
 *
 * Stop is the other half and keeps its full read: it hands over the child's own transcript path, so the meta
 * sibling is exact, and by then the file is long written.
 *
 * These hooks are pure record-keeping — they emit no frame. The card already learned the child exists from
 * `task_started`, and the ids landing here are ones no surface reads. */

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
        // No meta file (an SDK that stopped writing one), or unreadable. The child stays listed off its task
        // messages; only the transcript door closes, which is better than failing the hook and the turn with it.
        return undefined;
    }
};

// A session's children live beside its transcript, in a directory named after it:
// `<projects>/<slug>/<session>.jsonl` → `<projects>/<slug>/<session>/subagents/`.
const subagentsDirOf = (sessionTranscriptPath: string): string => join(sessionTranscriptPath.replace(/\.jsonl$/u, ""), "subagents");

// What the meta file says about a child, onto the record it names. Everything but the agent id is `??=`: the
// task stream got there first with the same facts more often than not, and the one that arrived live is the one
// to keep.
const fill = (record: SubagentRecord, meta: SubagentMeta, agentId: string): void => {
    record.agentId = agentId;
    record.agentType ??= meta.agentType;
    record.description ??= meta.description;
    record.model ??= meta.model;
    record.spawnDepth ??= meta.spawnDepth;
};

// Adopt what the meta file says about a child, from the hook that found it. The record may not exist yet (a hook
// can beat its task_started), in which case the meta is enough to open one: `toolUseId` is the key, and
// everything else the card wants is right there.
const adopt = (turn: SubagentTurn, meta: SubagentMeta, agentId: string): void => {
    const id = meta.toolUseId;
    if (id === undefined) {
        return;
    }
    fill(records.get(id) ?? open(turn, id, "subagent", {}), meta, agentId);
};

/* WHICH SDK AGENT A CHILD IS — resolved from the session's own meta files, on demand.
 *
 * This is the pairing SubagentStart cannot do (see the note above it) and SubagentStop only does for a child
 * that stops while its parent's session is still alive. A BACKGROUNDED child — the Agent tool's default — often
 * does not: the parent fires it and walks away, the turn ends, closeSubagents settles it, and the stop hook
 * never comes. Those children were listed with their tokens and their tool counts and then opened on "No
 * transcript was recorded", with the JSONL sitting on disk beside the parent's, complete.
 *
 * Asked at READ time, so every meta file of that turn is long written; cached on the record, because the answer
 * cannot change. The scan is one session's children, and a meta file is a few hundred bytes. */
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

export const subagentHooks = (turn: SubagentTurn): Partial<Record<HookEvent, HookCallbackMatcher[]>> => ({
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
                    /* The child's own last words, which is the one thing about a finished subagent a person
                     * actually reads. It beats the task stream's `summary` (a progress digest) and it beats
                     * parsing the transcript, so it is written even when task_notification has already said
                     * something — a report the child wrote itself is the better answer to "what did it find?".
                     *
                     * Status is NOT set here: a stop hook fires for every way a child can end, and the task
                     * stream is what distinguishes finishing from failing from being cut short. */
                    if (meta.toolUseId !== undefined && input.last_assistant_message !== undefined) {
                        patch(meta.toolUseId, { summary: input.last_assistant_message });
                    }
                    return { continue: true };
                },
            ],
        },
    ],
});

/* ---- delegations: the CLI agents an agent drives from its own Bash ------------------------------------------
 *
 * `codex exec` and `opencode run` (see delegation.ts) are agents by every measure that matters here — they take
 * a prompt, work for minutes, and report back — so they belong in the same list as the SDK's own children rather
 * than in a separate concept the operator has to learn. What is detectable is the COMMAND: every Bash call
 * already passes through the turn's stream on its way to a card, so the spawn is caught there, with no hook and
 * no output parsing (see `thread` on the record for why the ids are resolved at read time instead).
 *
 * Deliberately matched loosely — the leading token may be an env assignment, a `cd … &&` prefix, or `nice`, and
 * the flags vary — but anchored on the two-word verb, so a command that merely MENTIONS codex (a grep, an echo)
 * is not filed as an agent. */
const DELEGATIONS: readonly { readonly kind: SubagentKind; readonly verb: RegExp; readonly resume: RegExp }[] = [
    { kind: "codex", verb: /(?:^|[\s;&|])codex\s+exec\b/u, resume: /\bresume\s+([0-9a-fA-F-]{8,})/u },
    { kind: "grok", verb: /(?:^|[\s;&|])opencode\s+run\b/u, resume: /--session[\s=]+(\S+)/u },
];

// A command's own words as the row's description: the delegated PROMPT is the interesting part, and it is the
// last quoted argument. Falls back to the command itself, trimmed of the env/prefix noise.
const promptOf = (command: string): string | undefined => {
    const quoted = [...command.matchAll(/'([^']{4,})'|"([^"]{4,})"/gu)].map((match) => match[1] ?? match[2]).filter((text) => text !== undefined);
    const text = quoted.at(-1) ?? command;
    const line = text.replaceAll(/\s+/gu, " ").trim();
    return line === "" ? undefined : line.slice(0, 200);
};

/** A Bash command the turn is about to run: opens a delegation record when it starts one. `terminal` is the tmux
 *  session the command runs in — a delegation's live view, which an SDK subagent has no equivalent of.
 *  `background` is the call's own `run_in_background`, and it decides what may settle this record — see
 *  settleDelegation. */
export const noteDelegation = (
    turn: SubagentTurn,
    call: { readonly id: string; readonly command: string; readonly terminal?: string; readonly background: boolean },
): AgentEvent | undefined => {
    const match = DELEGATIONS.find((entry) => entry.verb.test(call.command));
    if (match === undefined || records.has(call.id)) {
        return undefined;
    }
    const resumed = match.resume.exec(call.command)?.[1];
    return bornFrame(
        open(turn, call.id, match.kind, {
            agentType: match.kind === "codex" ? "Codex" : "Grok",
            ...(promptOf(call.command) !== undefined ? { description: promptOf(call.command) } : {}),
            ...(resumed !== undefined ? { thread: resumed } : {}),
            ...(call.terminal !== undefined ? { terminal: call.terminal } : {}),
            ...(call.background ? { background: true } : {}),
        }),
    );
};

/** That command's result: the delegate stopped, and what it last said is its report.
 *
 * NOT FOR A BACKGROUNDED ONE, whose result says only that the command started. Taking that as the ending is a
 * measured lie: a `codex exec` sent to the background was marked `completed` 0.2 seconds in and the roster went
 * on saying "done" for the 103 seconds the delegate actually worked. What ends it instead is the background
 * task's own notification, which lands when the command exits and carries its report (noteSubagentTask) — and
 * until it does, the delegate counts as one of the children the session is still waiting on. */
export const settleDelegation = (id: string, outcome: { readonly failed: boolean; readonly output: string }): AgentEvent | undefined => {
    const record = records.get(id);
    if (record === undefined || record.background === true) {
        return undefined;
    }
    const tail = outcome.output.trim().slice(-REPORT_TAIL).trim();
    return patch(id, {
        status: outcome.failed ? "failed" : "completed",
        ...(tail !== "" ? { summary: tail } : {}),
        ...(outcome.failed && tail !== "" ? { error: tail } : {}),
    });
};

/** Every child of this turn that is still marked live, settled as the turn ends. A subagent the SDK never
 *  reported a terminal status for (the turn was stopped, the CLI died under it) would otherwise sit "running"
 *  in the list forever — and a permanently-running child is exactly the lie this registry exists to remove. */
export const closeSubagents = (conversationId: string): AgentEvent[] => {
    const frames: AgentEvent[] = [];
    for (const record of records.values()) {
        if (record.conversationId === conversationId && subagentRunning(record)) {
            const frame = patch(record.id, { status: "killed" });
            if (frame !== undefined) {
                frames.push(frame);
            }
        }
    }
    return frames;
};

// Tests drive the registry through its real entry points, so they need a way back to empty between cases.
export const resetSubagents = (): void => {
    records.clear();
    tasks.clear();
    backgrounded.clear();
};
