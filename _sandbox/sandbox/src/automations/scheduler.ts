import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Cron } from "croner";
import type { AgentEvent, AgentOrigin, AgentTurn, AutomationApproval, ModelPin } from "@intentic/sandbox-contract";
import { WORKSPACE_ROOT_EXCLUDE_ENV } from "@intentic/sandbox-contract/chores";
import { REFERENCE_DIR } from "@intentic/workspace-ignore";
import { TranscriptFold } from "@intentic/sandbox-contract/transcript-fold";
import { openingRows, openTurnTranscript, recordTurnTranscript } from "../sessions/turn-transcript.js";
import type { TurnInput } from "../agent/run/turn/turn-actor.js";
import type { Services } from "../composition.js";
import type { PersistedAgent } from "../agents/registry/agents-store.js";
import { sessionStart, wakeSourceOf } from "../guard/actions.js";
import { guard } from "../guard/guard.js";
import { wrapOutsideContent } from "@intentic/base/outside-text";
import { automationPending } from "../push/notifications.js";
import { threadKey } from "../sessions/thread-sessions.js";
import { pinnedRunModel } from "../agent/models/run-role-model.js";
import { type AutomationRecord, consecutiveFailures } from "./automations-store.js";

const execFileAsync = promisify(execFile);

// How long a guard command may run before it counts as failed (skipping the wake).
const GUARD_TIMEOUT_MS = 60_000;
// How much guard output survives into the run's detail.
const GUARD_DETAIL_TAIL = 500;
// How much of an event's webhook body reaches the guard's env and the wake prompt.
export const PAYLOAD_MAX = 64_000;
// The contract's cap on AgentTurn.title, a surfaced wake's title is built from a message, so it's clamped here.
export const TITLE_MAX = 80;

// Wake-the-agent shape (streamAgent's), injected by every caller rather than imported, since importing it would create
// a cycle through agent.routes and workspace-events.ts back into fireAutomation.
export type WakeFn = (services: Services, input: TurnInput, signal: AbortSignal | undefined) => AsyncGenerator<AgentEvent>;

// Live sink for a turn's assistant text; undefined means the agent sends its own reply. `failed` distinguishes no
// output from an error, carrying the raw reason for each sink to redact; always followed by `end`.
export interface TurnStream {
    readonly delta: (text: string) => void;
    readonly failed: (reason: string) => void;
    readonly end: () => void;
}

// Prepended to a streamed wake's prompt so the model doesn't also send the reply itself via a tool.
const STREAM_NOTE =
    "Your reply is delivered to the user live as you type it: just answer normally in plain text. Do NOT send it yourself with any tool (no curl/API post of your reply); use provider send tools only to act elsewhere (react, or post to a different channel).";

// Disables, not deletes, an automation after `automationFailureLimit` consecutive failures; re-enabling reuses the
// `enabled` toggle. Returns undefined when the guard is off, the streak is short, or the automation changed.
const quarantineIfSpinning = async (services: Services, id: string): Promise<string | undefined> => {
    const { automationFailureLimit } = await services.sandboxSettings.get();
    if (automationFailureLimit <= 0) {
        return undefined;
    }
    const record = await services.automations.get(id);
    if (record === undefined || !record.enabled) {
        return undefined;
    }
    const failures = consecutiveFailures(record.runs);
    if (failures < automationFailureLimit) {
        return undefined;
    }
    const { runs: _runs, ...automation } = record;
    await services.automations.upsert({ ...automation, enabled: false });
    services.logger.warn({ automation: id, failures }, "automation disabled after consecutive failures");
    return `Disabled after ${failures} consecutive failed runs (automationFailureLimit is ${automationFailureLimit}). Fix the cause and re-enable it.`;
};

// Runs the guard command in the workspace root; exit 0 wakes the agent, with the payload in AUTOMATION_PAYLOAD. On
// failure, the stderr/stdout tail becomes the run's detail.
const runGuard = async (command: string, cwd: string, payload: string | undefined): Promise<{ pass: boolean; detail?: string }> => {
    try {
        await execFileAsync("sh", ["-c", command], {
            cwd,
            timeout: GUARD_TIMEOUT_MS,
            env: {
                ...process.env,
                [WORKSPACE_ROOT_EXCLUDE_ENV]: REFERENCE_DIR,
                ...(payload !== undefined ? { AUTOMATION_PAYLOAD: payload } : {}),
            },
        });
        return { pass: true };
    } catch (error) {
        const { stdout, stderr } = error as { stdout?: string; stderr?: string };
        const detail = `${stderr ?? ""}${stdout ?? ""}`.trim().slice(-GUARD_DETAIL_TAIL);
        return { pass: false, ...(detail !== "" ? { detail } : {}) };
    }
};

// Run in progress per automation; a queued fire awaits it. Shared by the tick, dispatchers and fire route.
const inFlight = new Map<string, Promise<unknown>>();

// Branch/worktree name bounded by ConversationIdSchema, built from the automation id with prefix/suffix room.
const AUTOMATION_ID_IN_CONVERSATION = 40;
// Prefix every fire's conversation carries; the mark a schedule wake leaves, read by the sessions gate.
const AUTOMATION_CONVERSATION_PREFIX = "a-";
// Fires of one automation can't share a millisecond; this makes the id unique per process regardless of caller.
let fireSeq = 0;
export const mintConversationId = (automationId: string, now: number): string =>
    `${AUTOMATION_CONVERSATION_PREFIX}${automationId.slice(0, AUTOMATION_ID_IN_CONVERSATION)}-${now.toString(36)}${(fireSeq++).toString(36)}`;

// Whether this automation minted that conversation id; a leftover "-" after the base36 suffix means only a prefix
// match. Used to exclude a job's own wakes from its sessions gate and its own `turn.settled`.
export const firedBy = (automationId: string, conversationId: string): boolean => {
    const mine = `${AUTOMATION_CONVERSATION_PREFIX}${automationId.slice(0, AUTOMATION_ID_IN_CONVERSATION)}-`;
    return conversationId.startsWith(mine) && !conversationId.slice(mine.length).includes("-");
};

// Sessions gate for afterSessions: fires once enough new sessions ran since the last wake, read from the newest
// conversation this automation minted, not the bounded run ledger.
interface SessionsSinceWake {
    // Epoch ms of the last wake's conversation; 0 when this automation has never woken an agent.
    readonly since: number;
    // Newest first.
    readonly sessions: readonly PersistedAgent[];
}

const sessionsSinceLastWake = (services: Services, automationId: string): SessionsSinceWake => {
    const entries = services.agents.ids().flatMap((id) => {
        const entry = services.agents.entry(id);
        return entry === undefined ? [] : [entry];
    });
    const ownWakes = entries.filter((entry) => firedBy(automationId, entry.id));
    const since = Math.max(0, ...ownWakes.map((entry) => entry.createdAt));
    const sessions = entries
        .filter(
            (entry) =>
                entry.createdAt > since &&
                entry.origin === undefined &&
                !entry.id.startsWith(AUTOMATION_CONVERSATION_PREFIX) &&
                (entry.turns ?? 0) >= 1,
        )
        .sort((a, b) => b.createdAt - a.createdAt);
    return { since, sessions };
};

// How many counted sessions are listed by name; the count is the whole total, `agents ls --all` has the rest.
const SESSIONS_LISTED = 200;

// What a gated wake reads under its prompt: the count, when it was measured from, and the sessions, one per line.
// Persisted with the fire so a re-fire or replay reads the same list, not a fresh count.
const sessionsListing = ({ since, sessions }: SessionsSinceWake): string => {
    const measuredFrom =
        since === 0
            ? "and this automation has never woken an agent before"
            : `since ${new Date(since).toISOString()}, the last time this automation woke an agent`;
    const lines = sessions
        .slice(0, SESSIONS_LISTED)
        .map((session) =>
            [
                session.id,
                session.title ?? "(untitled)",
                new Date(session.createdAt).toISOString(),
                `${session.turns ?? 0} turns`,
                `${session.toolUses ?? 0} tool uses`,
                `$${session.costUsd.toFixed(2)}`,
            ].join(" · "),
        );
    const more = sessions.length > SESSIONS_LISTED ? [`… and ${sessions.length - SESSIONS_LISTED} more (agents ls --all)`] : [];
    return [`${sessions.length} sessions ${measuredFrom}. Newest first:`, ...lines, ...more].join("\n");
};

// One step of runFire: not gated or bar cleared returns the listing to carry as payload; short of the bar returns what
// the skipped run says.
const sessionsGate = (services: Services, automation: AutomationRecord): { readonly skipped: string } | { readonly listing?: string } => {
    const bar = automation.trigger.kind === "schedule" ? automation.trigger.afterSessions : undefined;
    if (bar === undefined) {
        return {};
    }
    const counted = sessionsSinceLastWake(services, automation.id);
    if (counted.sessions.length < bar) {
        return { skipped: `${counted.sessions.length} of ${bar} sessions since the last wake` };
    }
    return { listing: sessionsListing(counted).slice(0, PAYLOAD_MAX) };
};

// Everything a fire needs beyond the automation itself; an options object since dispatchers and the tick each set a
// different subset.
export interface FireOptions {
    // The trigger's payload, appended to the prompt and handed to the guard as AUTOMATION_PAYLOAD.
    readonly payload?: string;
    // Which pre-wake gate this fire already satisfies, so it is not put through again:
    // - `approval`: the owner clicked Run now, or a restart is re-firing a wake already past the gate; the guard still
    //   runs.
    // - `both`: replaying a held wake whose guard already ran and passed.
    readonly cleared?: "approval" | "both";
    // How many times a boot re-fired this wake, so one that keeps dying isn't re-fired forever. First fire is 0.
    readonly attempts?: number;
    // Set by the restart path or a dispatcher owning a thread, so repeated messages share one conversation.
    readonly conversationId?: string;
    // Provider session the conversation last ran on; meaningful only alongside conversationId.
    readonly sessionId?: string;
    // Narrows the wake's toolbox to the automation's allowlist, so a stranger's message drives a smaller turn.
    readonly allowedTools?: readonly string[];
    // When set, text deltas stream here live and the agent is told (STREAM_NOTE) not to send the reply itself.
    readonly stream?: TurnStream;
    // Set by dispatchers on an outside message; provenance only, for the board and guard layer, not where it runs.
    readonly origin?: AgentOrigin;
    // Card/tab title, since the prompt repeats across fires and can't tell two apart; derived below if absent.
    readonly title?: string;
    // What happens when this automation is already running:
    // - `drop` (default): a cron or workspace-event re-fire is not wanted twice; the next tick comes anyway.
    // - `queue`: for an inbound message with no next tick; waits for the run in progress, keeping its reply sink open.
    readonly overlap?: "drop" | "queue";
}

// What a fire leaves for a caller running another one on the same conversation: the provider session to resume, absent
// when no turn ran or none was minted.
export interface FireOutcome {
    readonly sessionId?: string;
}

// Fires one automation, one turn at a time; owns only the overlap policy (refuse or wait), with `runFire` doing the
// fire itself. Callers run it detached; tests await it directly.
export const fireAutomation = async (
    services: Services,
    automation: AutomationRecord,
    wake: WakeFn,
    options: FireOptions = {},
): Promise<FireOutcome> => {
    const running = inFlight.get(automation.id);
    if (running !== undefined && options.overlap !== "queue") {
        // Dropped as overlapping means no reply is coming; runFire's finally never runs here, so this closes the sink.
        options.stream?.failed("this automation is already running, so the message was not picked up");
        options.stream?.end();
        return {};
    }
    // The chain is the lock: each fire runs after the last; failure still lets the next start (`.then(job, job)`).
    const turn = (running ?? Promise.resolve()).then(
        () => runFire(services, automation, wake, options),
        () => runFire(services, automation, wake, options),
    );
    const settled = turn.then(
        () => undefined,
        () => undefined,
    );
    inFlight.set(automation.id, settled);
    void settled.then(() => {
        // Only the last fire in the chain clears the slot; an earlier one must not unlock a turn queued behind it.
        if (inFlight.get(automation.id) === settled) {
            inFlight.delete(automation.id);
        }
    });
    return turn;
};

// Waits for a running fire of this automation. A recorded run isn't the same as free again, since the lock releases
// only when the fire returns; firing the same automation twice in a row must await this in between.
export const automationIdle = async (id: string): Promise<void> => {
    await inFlight.get(id);
};

// Resolved model pin as turn fields (model, effort, thinking, fast, harness); an unpinned knob stays absent. Named
// return type, not Partial<AgentTurn>, so spreading it can't re-answer conversationId.
const pinFields = (
    pin: ModelPin,
): Pick<Required<AgentTurn>, "agent" | "model"> & Partial<Pick<AgentTurn, "effort" | "thinking" | "fast" | "harness">> => ({
    agent: pin.provider,
    model: pin.model,
    ...(pin.effort !== undefined ? { effort: pin.effort } : {}),
    ...(pin.thinking !== undefined ? { thinking: pin.thinking } : {}),
    ...(pin.fast !== undefined ? { fast: pin.fast } : {}),
    ...(pin.harness !== undefined ? { harness: pin.harness } : {}),
});

// Walks the automation's model ladder for the first rung this sandbox can run; undefined means no wake, already
// recorded. A fully disconnected ladder is an `error` run, counted toward the failure streak.
const wakeModel = async (services: Services, automation: AutomationRecord, stream: TurnStream | undefined): Promise<ModelPin | undefined> => {
    // A single-rung ladder fires as configured regardless: no next entry, and automations have no floor to fall to.
    const [only, ...rest] = automation.models;
    if (only !== undefined && rest.length === 0) {
        return only;
    }
    const pin = await pinnedRunModel(services, automation.models);
    if (pin !== undefined) {
        return pin;
    }
    const reason = `This automation's models are all on providers this sandbox cannot reach right now: connect one of them, or pin a model it can run.`;
    await services.automations.recordRun(automation.id, { at: Date.now(), outcome: "error", detail: reason });
    stream?.failed(reason);
    return undefined;
};

// Guard, then wake, then record the run; reached only through fireAutomation, which guarantees no two runs of one
// automation overlap here.
const runFire = async (
    services: Services,
    automation: AutomationRecord,
    wake: WakeFn,
    {
        payload,
        cleared,
        attempts = 0,
        conversationId: resumedConversationId,
        sessionId: resumedSessionId,
        allowedTools,
        stream,
        origin,
        title,
    }: FireOptions,
): Promise<FireOutcome> => {
    try {
        let capped = payload?.slice(0, PAYLOAD_MAX);
        // Admission runs on every fire, even cleared: a deny still refuses; a hold is what `cleared` already answered.
        const { admission } = await services.sandboxSettings.get();
        const verdict = guard(sessionStart, {
            source: wakeSourceOf(automation.trigger),
            admission,
            ...(automation.requireApproval !== undefined ? { requireApproval: automation.requireApproval } : {}),
            ...(automation.holdForSeconds !== undefined ? { holdForSeconds: automation.holdForSeconds } : {}),
        });
        if (verdict.effect === "deny") {
            await services.automations.recordRun(automation.id, {
                at: Date.now(),
                outcome: "skipped",
                detail: verdict.reason,
            });
            // A policy refusal is still a reply that never arrives, so it's said to the sink, not left silent.
            stream?.failed(verdict.reason);
            return {};
        }
        if (cleared !== "both") {
            // Sessions gate runs before the guard, cheaper to check; skipped on a re-fire, measuring zero since itself.
            const gate = resumedConversationId === undefined ? sessionsGate(services, automation) : {};
            if ("skipped" in gate) {
                await services.automations.recordRun(automation.id, { at: Date.now(), outcome: "skipped", detail: gate.skipped });
                stream?.failed(gate.skipped);
                return {};
            }
            // The sessions are a gated fire's payload: what woke it, read by the guard and appended under the prompt.
            capped = gate.listing ?? capped;
            if (automation.guard !== undefined) {
                const precheck = await runGuard(automation.guard, services.workspace.root, capped);
                if (!precheck.pass) {
                    await services.automations.recordRun(automation.id, {
                        at: Date.now(),
                        outcome: "skipped",
                        ...(precheck.detail !== undefined ? { detail: precheck.detail } : {}),
                    });
                    // A guard refusal is still a reply that never arrives to the sink, so it's said, not left silent.
                    stream?.failed(precheck.detail ?? "this automation's guard skipped the run");
                    return {};
                }
            }
            // Holds the wake instead of running; inFlight releases in the finally, so the lock isn't held during the
            // wait.
            if (verdict.effect === "hold" && cleared === undefined) {
                await services.heldWakes.add({
                    automationId: automation.id,
                    // Only a pure-countdown hold carries autoRunAfterS; an "ask me" hold never auto-runs.
                    ...(verdict.autoRunAfterS !== undefined ? { autoRunAt: Date.now() + verdict.autoRunAfterS * 1_000 } : {}),
                    ...(capped !== undefined ? { payload: capped } : {}),
                    // Snapshotted so the approved run opens the same conversation, keeping origin rather than turning
                    // anonymous.
                    ...(origin !== undefined ? { origin } : {}),
                    ...(title !== undefined ? { title } : {}),
                    // The thread it would have continued: without it, approve has nothing to resume and mints a fresh
                    // one.
                    ...(resumedConversationId !== undefined ? { conversationId: resumedConversationId } : {}),
                    ...(resumedSessionId !== undefined ? { sessionId: resumedSessionId } : {}),
                    createdAt: Date.now(),
                });
                void services.activity
                    .append({
                        direction: "system",
                        type: "automation.pending",
                        automationIds: [automation.id],
                        ...(automation.trigger.kind === "listener" ? { provider: automation.trigger.provider } : {}),
                    })
                    .catch((error: unknown) => services.logger.warn({ err: error }, "activity append failed"));
                // A held wake needs the owner to act; notifyIfAway pings them only if they're away.
                void services.pushSender.notifyIfAway(automationPending(automation.id, automation.prompt));
                return {};
            }
        }
        // What this wake runs on, walked before anything is spent or written down (see `wakeModel`).
        const pin = await wakeModel(services, automation, stream);
        if (pin === undefined) {
            return {};
        }
        // Journals the fire's trigger inputs, not the resolved turn, so a re-fire re-reads a prompt since fixed.
        const conversationId = resumedConversationId ?? mintConversationId(automation.id, Date.now());
        await services.turnJournal
            .recordFire({
                kind: "automation",
                automationId: automation.id,
                conversationId,
                ...(capped !== undefined ? { payload: capped } : {}),
                ...(origin !== undefined ? { origin } : {}),
                ...(title !== undefined ? { title } : {}),
                startedAt: Date.now(),
                attempts,
            })
            .catch((error: unknown) => services.logger.warn({ err: error, automation: automation.id }, "turn journal: fire not recorded"));
        // A listener payload is wrapped in the outside-content envelope here only; guard env and journal keep it raw.
        const sealed = automation.trigger.kind === "listener" ? wrapOutsideContent(capped ?? "", { source: automation.trigger.provider }) : capped;
        // Nothing hands a schedule a payload but its own sessions gate, so the heading can say what the list is.
        const heading = automation.trigger.kind === "schedule" ? "Sessions since the last wake" : "Event payload";
        const body = capped !== undefined && capped !== "" ? `${automation.prompt}\n\n--- ${heading} ---\n${sealed}` : automation.prompt;
        let failure: string | undefined;
        let runtimeSessionId: string | undefined;
        // Every fire lands in a conversation; a channel or visitor keeps one active, a schedule wake mints a fresh one.
        const turn: AgentTurn & { conversationId: string } = {
            // STREAM_NOTE is applied here, not folded into `body`, so it belongs to this fire, not the journal entry.
            prompt: stream !== undefined ? `${STREAM_NOTE}\n\n${body}` : body,
            conversationId,
            // Marks nobody is at a composer: the command gate refuses instead of prompting, plan/ask withheld.
            unattended: true,
            // Names the provider when a listener started this turn, for the guard layer; other triggers set nothing.
            ...(automation.trigger.kind === "listener" ? { outsideWake: automation.trigger.provider } : {}),
            // Resumes the provider session on a continuing thread; absent on a first turn or any one-off wake.
            ...(resumedSessionId !== undefined ? { sessionId: resumedSessionId } : {}),
            ...(allowedTools !== undefined ? { allowedTools: [...allowedTools] } : {}),
            // Every wake runs in its own worktree, unconditionally; `origin` says who spoke, not where the turn runs.
            isolated: true,
            ...(origin !== undefined
                ? {
                      origin,
                      title: (title ?? `${origin.provider}: ${automation.id}`).slice(0, TITLE_MAX),
                  }
                : {}),
            // Resolved rung spread verbatim, not through turn-resume's fill step, since this turn walked its ladder.
            ...pinFields(pin),
            // Account rides only if every rung agrees on provider, meaningless elsewhere; else best-headroom wins.
            ...(automation.account !== undefined && automation.models.every((rung) => rung.provider === pin.provider)
                ? { account: automation.account }
                : {}),
            // Absence here is deliberate: the resolver reads no pin as no account on an unattended turn, not all.
            ...(automation.actsAs !== undefined ? { actsAs: automation.actsAs } : {}),
        };
        // Transcript folds as it streams; opens stamped with when the turn began, not when appended, minutes later.
        const fold = new TranscriptFold(openingRows(turn, services.workspace.root, Date.now()));
        // Opened before the provider runs, like every other conversation turn (a fork's copy; nothing else opens).
        await openTurnTranscript(services, turn);
        try {
            for await (const event of wake(services, turn, undefined)) {
                fold.apply(event);
                if (event.kind === "session") {
                    runtimeSessionId = event.sessionId;
                }
                if (event.kind === "error") {
                    failure = event.message;
                }
                if (event.kind === "delta") {
                    stream?.delta(event.text);
                }
            }
        } catch (error) {
            failure = error instanceof Error ? error.message : "automation turn failed";
            services.logger.warn({ err: error, automation: automation.id, conversationId }, "automation turn failed");
        } finally {
            fold.finish("settled");
            await recordTurnTranscript(services, turn, fold.rows, fold.steerRows);
        }
        // Tells the sink the turn failed before the finally closes it, so a dead wake doesn't read as silence.
        if (failure !== undefined) {
            stream?.failed(failure);
        }
        // Conversation id rides on the run record so a wake that reached a turn is openable with no runtime session.
        await services.automations.recordRun(automation.id, {
            at: Date.now(),
            ...(failure === undefined ? { outcome: "completed" as const } : { outcome: "error" as const, detail: failure }),
            conversationId,
        });
        // Read after recording so this fire's own outcome is part of the streak the guard weighs.
        const quarantined = failure === undefined ? undefined : await quarantineIfSpinning(services, automation.id);
        // Runtime session is the activity feed's join key between the trigger and the outbound calls the wake produced.
        void services.activity
            .append({
                direction: "system",
                type: "automation.run",
                automationIds: [automation.id],
                ...(automation.trigger.kind === "listener" ? { provider: automation.trigger.provider } : {}),
                ...(runtimeSessionId !== undefined ? { sessionId: runtimeSessionId } : {}),
                outcome: failure === undefined ? "ok" : "error",
                // Quarantine rides this run's activity row, not a second event; the feed is where someone asks why.
                ...(failure !== undefined ? { error: quarantined === undefined ? failure : `${failure}\n\n${quarantined}` } : {}),
            })
            .catch((error: unknown) => services.logger.warn({ err: error }, "activity append failed"));
        // Handed back so a dispatcher on a continuing thread can resume this session; everyone else ignores it.
        return runtimeSessionId !== undefined ? { sessionId: runtimeSessionId } : {};
    } finally {
        // Flush the final buffered text (the deltas after the last rate-limited edit). No-op if nothing streamed.
        stream?.end();
        // Clears the journal entry regardless of outcome; only a fire with no end state leaves one, for the boot pass.
        await services.turnJournal
            .clearFire(automation.id)
            .catch((error: unknown) => services.logger.warn({ err: error, automation: automation.id }, "turn journal: fire not cleared"));
    }
};

export interface AutomationsScheduler {
    readonly start: () => void;
    readonly stop: () => void;
    // One poll pass over the manifest; `start` runs it on an interval. Exposed for tests.
    readonly tick: (now?: number) => Promise<void>;
}

// Runs a held wake with its snapshot (`cleared: "both"`, guard already ran), then settles its thread so the next
// message resumes it. Shared by both releases, the approve route and the countdown scan.
export const runHeldWake = async (services: Services, automation: AutomationRecord, held: AutomationApproval, wake: WakeFn): Promise<void> => {
    const settled = await fireAutomation(services, automation, wake, {
        cleared: "both",
        ...(held.payload !== undefined ? { payload: held.payload } : {}),
        ...(held.origin !== undefined ? { origin: held.origin } : {}),
        ...(held.title !== undefined ? { title: held.title } : {}),
        ...(held.conversationId !== undefined ? { conversationId: held.conversationId } : {}),
        ...(held.sessionId !== undefined ? { sessionId: held.sessionId } : {}),
    });
    const origin = held.origin;
    if (origin?.channelId === undefined || settled.sessionId === undefined) {
        return;
    }
    await services.threadSessions.settle(threadKey(origin.provider, origin.automationId, origin.channelId), settled.sessionId, Date.now());
};

// Polls the manifest and fires whatever came due since the last pass, with no resync bookkeeping; fires run detached,
// since a turn can outlast many polls. Event automations fire from the fire route instead.
export const createAutomationsScheduler = (services: Services, wake: WakeFn, intervalMs = 30_000): AutomationsScheduler => {
    let since = Date.now();
    let timer: NodeJS.Timeout | undefined;

    const tick = async (now = Date.now()): Promise<void> => {
        const windowStart = since;
        since = now;
        for (const automation of await services.automations.list()) {
            if (!automation.enabled || automation.trigger.kind !== "schedule") {
                continue;
            }
            // A cron hand-edited into invalidity only silences its own automation, never the tick.
            let due: Date | null;
            try {
                due = new Cron(automation.trigger.cron).nextRun(new Date(windowStart));
            } catch {
                continue;
            }
            if (due === null || due.getTime() > now) {
                continue;
            }
            void fireAutomation(services, automation, wake).catch((error: unknown) =>
                services.logger.error({ err: error, automation: automation.id }, "automation run failed"),
            );
        }
        // Releases countdown holds past deadline while no turn is live; removed before running so it can't re-fire.
        for (const held of await services.heldWakes.list()) {
            if (held.autoRunAt === undefined || held.autoRunAt > now || services.agents.liveSessionIds().length > 0) {
                continue;
            }
            const automation = await services.automations.get(held.automationId);
            await services.heldWakes.remove(held.id);
            if (automation === undefined || !automation.enabled) {
                continue;
            }
            void runHeldWake(services, automation, held, wake).catch((error: unknown) =>
                services.logger.error({ err: error, automation: automation.id }, "countdown-released automation run failed"),
            );
        }
    };

    return {
        tick,
        start: () => {
            timer = setInterval(() => void tick(), intervalMs);
        },
        stop: () => clearInterval(timer),
    };
};
