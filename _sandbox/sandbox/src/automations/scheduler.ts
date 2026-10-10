import { Cron } from "croner";
import type { AgentOrigin, AgentTurn, Automation, AutomationApproval, ModelPin, Trigger, Zone } from "@intentic/sandbox-contract";
import { cronOptions, wallClockIn } from "@intentic/sandbox-contract";
import { TranscriptFold } from "@intentic/sandbox-contract/transcript-fold";
import { openingRows, openTurnTranscript, recordTurnTranscript } from "../sessions/turn-transcript.js";
import type { Services } from "../composition.js";
import { type PersistedAgent, reposOf } from "../conversations/registry/agents-store.js";
import { sessionStart, wakeSourceOf } from "../guard/actions.js";
import { guard } from "../guard/guard.js";
import { SingleFlight } from "@intentic/base/async";
import { wrapOutsideContent } from "@intentic/base/outside-text";
import { automationPending, turnFinished } from "../push/notifications.js";
import { pinnedRunModel } from "../agent/models/run-role-model.js";
import type { OutboxSink } from "../webchat/webchat-outbox.js";
import { type AutomationRecord, consecutiveFailures } from "./automations-store.js";
import type { ScheduleMark } from "./schedule-coverage.js";
import { sandboxZone, zoneOf } from "./schedule-zone.js";
import type { SenderLane } from "./senders.js";
import { TITLE_MAX } from "../seams/conversation-title.js";
import { continueConversation, expireAutomation, notifyOwner, type TargetOutcome } from "./watch/fire-targets.js";
import { checkCondition, conditionOutside } from "./watch/watch-condition.js";

// How much of an event's webhook body reaches the guard's env and the wake prompt.
export const PAYLOAD_MAX = 64_000;

// Live sink for a turn's assistant text; undefined means the agent sends its own reply. `failed` distinguishes no
// output from an error, carrying the raw reason for each sink to redact; always followed by `end`.
export interface TurnStream {
    readonly delta: (text: string) => void;
    readonly failed: (reason: string) => void;
    readonly end: () => void;
}

// What the block under the prompt IS, per trigger, since a schedule's payload is its own sessions listing rather than
// anything a sender wrote. A record, not a ternary, so a new trigger has to say what it hands the turn.
const PAYLOAD_HEADING: Record<Trigger["kind"], string> = {
    schedule: "Sessions since the last wake",
    // Carried only by a wake that came due while nothing was running; on time, there is no payload at all.
    once: "About this wake",
    event: "Event payload",
    listener: "Event payload",
    workspace: "Event payload",
};

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
                entry.identity.origin === undefined &&
                !entry.id.startsWith(AUTOMATION_CONVERSATION_PREFIX) &&
                entry.totals.turns >= 1,
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
                session.social.title?.text ?? "(untitled)",
                new Date(session.createdAt).toISOString(),
                `${session.totals.turns} turns`,
                `${session.totals.toolUses} tool uses`,
                `$${session.totals.costUsd.toFixed(2)}`,
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
    // The thread-sessions key this fire belongs to, snapshotted on a hold so the approved run settles the same thread.
    readonly thread?: string;
    // What the sender's rule decided (senders.ts): present, its persona replaces the automation's and its hold adds to
    // it. Absent for a fire nobody sent, a schedule or a webhook, which wears the automation's own.
    readonly lane?: SenderLane;
    // Narrows the wake's toolbox to the automation's allowlist, so a stranger's message drives a smaller turn.
    readonly allowedTools?: readonly string[];
    // When set, text deltas stream here live and the agent is told (STREAM_NOTE) not to send the reply itself.
    readonly stream?: TurnStream;
    // Set by dispatchers on an outside message; provenance only, for the board and guard layer, not where it runs.
    readonly origin?: AgentOrigin;
    // Card/tab title, since the prompt repeats across fires and can't tell two apart; derived below if absent.
    readonly title?: string;
    // Said under the prompt when this fire is a schedule's moment the sandbox slept through (the catch-up at start), so
    // a nightly chore run at noon knows it is late. Its own section rather than the payload: a gated schedule's payload
    // is its sessions listing, which a guard reads, and this note is for the agent only.
    readonly late?: string;
    // What the automation's check saw, already worded for the wake: carried by a held wake's replay, whose check ran
    // when it was held and must not run again (it would compare against the value it just recorded).
    readonly observed?: string;
    // The held wake this fire replays, by id: what a delivery into a conversation is keyed on, so two holds approved
    // together are two deliveries rather than one answered twice.
    readonly held?: string;
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
export const fireAutomation = async (services: Services, automation: AutomationRecord, options: FireOptions = {}): Promise<FireOutcome> => {
    const running = inFlight.get(automation.id);
    if (running !== undefined && options.overlap !== "queue") {
        // Dropped as overlapping means no reply is coming; runFire's finally never runs here, so this closes the sink.
        options.stream?.failed("this automation is already running, so the message was not picked up");
        options.stream?.end();
        return {};
    }
    // The chain is the lock: each fire runs after the last; failure still lets the next start (`.then(job, job)`).
    const turn = (running ?? Promise.resolve()).then(
        () => runFire(services, automation, options),
        () => runFire(services, automation, options),
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
    const ladder = automation.models ?? [];
    // Upsert refuses a new-agent automation naming no model; one hand-edited into that state says so rather than guessing.
    if (ladder.length === 0) {
        const reason =
            "This automation starts a new agent but names no model to run it on: pick one, or point it at a conversation or a notification.";
        await services.automations.recordRun(automation.id, { at: Date.now(), outcome: "error", detail: reason });
        stream?.failed(reason);
        return undefined;
    }
    // A single-rung ladder fires as configured regardless: no next entry, and automations have no floor to fall to.
    const [only, ...rest] = ladder;
    if (only !== undefined && rest.length === 0) {
        return only;
    }
    const pin = await pinnedRunModel(services, ladder);
    if (pin !== undefined) {
        return pin;
    }
    const reason = `This automation's models are all on providers this sandbox cannot reach right now: connect one of them, or pin a model it can run.`;
    await services.automations.recordRun(automation.id, { at: Date.now(), outcome: "error", detail: reason });
    stream?.failed(reason);
    return undefined;
};

// Whether this automation is a watch: something a person asked to hear about when it happens, rather than a chore run on
// a clock. A ready-made source, a change-only check, or a wait for one thing are each that.
const isWatch = (automation: Pick<AutomationRecord, "source" | "fireOn" | "until">): boolean =>
    automation.source !== undefined || automation.fireOn === "change" || automation.until === "first-fire";

// Tells the owner a one-time wake or a watch is done, the two whose whole purpose is to reach a person. Every other kind
// is already answering somebody listening (a visitor, a channel, a webhook's caller) or is a chore nobody asked to hear
// each run of, and a push per fire would make a five-minute poll unbearable. A watch fires only when something
// happened, so it never is one. `notifyIfAway` still holds it if they're here to see the card themselves.
const notifyWakeSettled = (services: Services, automation: AutomationRecord, conversationId: string, failure: string | undefined): void => {
    if (automation.trigger.kind !== "once" && !isWatch(automation)) {
        return;
    }
    const outcome = failure === undefined ? { ok: true } : { ok: false, error: failure };
    void services.pushSender.notifyIfAway(turnFinished(conversationId, automation.note ?? automation.prompt, outcome));
};

// What a held wake keeps of the fire that was stopped, so an approved run replays it: the payload and origin, the
// conversation and thread to continue, the persona it resolved to. Every field absent rather than undefined, so the
// snapshot only carries what the fire itself did.
const heldWakeSnapshot = (
    automationId: string,
    // Only a pure-countdown hold carries autoRunAfterS; an "ask me" hold never auto-runs.
    autoRunAfterS: number | undefined,
    fire: Pick<AutomationApproval, "payload" | "observed" | "origin" | "title" | "conversationId" | "sessionId" | "thread" | "actsAs">,
): Omit<AutomationApproval, "id"> => ({
    automationId,
    ...(autoRunAfterS !== undefined ? { autoRunAt: Date.now() + autoRunAfterS * 1_000 } : {}),
    ...(fire.payload !== undefined ? { payload: fire.payload } : {}),
    ...(fire.observed !== undefined ? { observed: fire.observed } : {}),
    ...(fire.origin !== undefined ? { origin: fire.origin } : {}),
    ...(fire.title !== undefined ? { title: fire.title } : {}),
    ...(fire.conversationId !== undefined ? { conversationId: fire.conversationId } : {}),
    ...(fire.sessionId !== undefined ? { sessionId: fire.sessionId } : {}),
    ...(fire.thread !== undefined ? { thread: fire.thread } : {}),
    ...(fire.actsAs !== undefined ? { actsAs: fire.actsAs } : {}),
    createdAt: Date.now(),
});

// The heading what the automation's check saw goes under in the woken prompt.
const OBSERVED_HEADING = "What the check saw";

// The prompt as the woken turn reads it: the trigger's payload under its heading, what the check saw under its own, then
// a late fire's note. A listener payload is wrapped in the outside-content envelope here only; guard env and journal keep
// it raw. What the check saw arrives already wrapped where it came from outside (watch/watch-condition.ts).
const wakeBody = (automation: AutomationRecord, payload: string | undefined, late: string | undefined, observed?: string): string => {
    const sealed = automation.trigger.kind === "listener" ? wrapOutsideContent(payload ?? "", { source: automation.trigger.provider }) : payload;
    const told =
        payload !== undefined && payload !== ""
            ? `${automation.prompt}\n\n--- ${PAYLOAD_HEADING[automation.trigger.kind]} ---\n${sealed}`
            : automation.prompt;
    const seen = observed === undefined || observed === "" ? told : `${told}\n\n--- ${OBSERVED_HEADING} ---\n${observed}`;
    return late === undefined ? seen : `${seen}\n\n--- ${PAYLOAD_HEADING.once} ---\n${late}`;
};

// Records a fire that went somewhere other than a new agent, as the run history and the activity feed read every fire.
const recordTargetRun = async (services: Services, automation: AutomationRecord, outcome: TargetOutcome): Promise<void> => {
    await services.automations.recordRun(automation.id, {
        at: Date.now(),
        ...(outcome.ok
            ? { outcome: "completed" as const, ...(outcome.detail === undefined ? {} : { detail: outcome.detail }) }
            : { outcome: "error" as const, detail: outcome.error }),
        ...(outcome.ok && outcome.conversationId !== undefined ? { conversationId: outcome.conversationId } : {}),
    });
    void services.activity
        .append({
            direction: "system",
            type: "automation.run",
            automationIds: [automation.id],
            outcome: outcome.ok ? "ok" : "error",
            ...(outcome.ok ? {} : { error: outcome.error }),
        })
        .catch((error: unknown) => services.logger.warn({ err: error }, "activity append failed"));
};

// Guard, then wake, then record the run; reached only through fireAutomation, which guarantees no two runs of one
// automation overlap here.
const runFire = async (
    services: Services,
    automation: AutomationRecord,
    {
        payload,
        cleared,
        attempts = 0,
        conversationId: resumedConversationId,
        sessionId: resumedSessionId,
        thread,
        lane,
        allowedTools,
        stream,
        origin,
        title,
        late,
        observed: replayedObservation,
        held,
    }: FireOptions,
): Promise<FireOutcome> => {
    // This fire's own name, for a delivery that must not be mistaken for another fire's.
    const fireKey = held === undefined ? `at-${Date.now()}` : `held-${held}`;
    try {
        // Past its end date it does nothing but end: switched off, and whoever it was for told. A held wake already
        // released by a person is theirs to have, so a replay goes ahead.
        if (automation.expiresAt !== undefined && automation.expiresAt <= Date.now() && cleared !== "both") {
            // Ended before (a press of "Run now" on it): nobody is told again, but the press is answered in its history.
            if (!(await expireAutomation(services, automation)) && cleared === "approval") {
                await services.automations.recordRun(automation.id, {
                    at: Date.now(),
                    outcome: "skipped",
                    detail: `It reached its end date (${new Date(automation.expiresAt).toISOString()}): move the end date to run it again.`,
                });
            }
            stream?.failed("this automation reached its end date");
            return {};
        }
        let capped = payload?.slice(0, PAYLOAD_MAX);
        // What the check saw, worded for the wake, and where its words came from when that was outside the sandbox. A
        // replay carries the check that ran when it was held; it does not run again.
        let observed = replayedObservation;
        let observedOutside = replayedObservation === undefined ? undefined : conditionOutside(automation);
        let observedValue: string | undefined;
        // The persona this fire wears: the sender's lane when someone sent it, else the automation's own. Resolved once
        // here so the hold snapshot and the turn cannot disagree.
        const actsAs = lane !== undefined ? lane.actsAs : automation.actsAs;
        // Admission runs on every fire, even cleared: a deny still refuses; a hold is what `cleared` already answered.
        // A lane's hold only ever adds to the automation's, most-restrictive-wins like the floor.
        const { admission } = await services.sandboxSettings.get();
        const requireApproval = automation.requireApproval === true || lane?.requireApproval === true;
        const verdict = guard(sessionStart, {
            source: wakeSourceOf(automation.trigger),
            admission,
            ...(requireApproval ? { requireApproval } : {}),
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
            // The check: a guard command or a ready-made source, deciding without a model whether anything happened.
            const condition = await checkCondition(services, automation, capped);
            if (condition.kind !== "go") {
                // A quiet check (nothing moved) stays out of the history, which a frequent watch would fill with it; one
                // pressed by hand says it anyway, since "nothing changed" is the answer the button asked for.
                if (condition.kind === "skip" || cleared === "approval") {
                    await services.automations.recordRun(automation.id, {
                        at: Date.now(),
                        outcome: "skipped",
                        ...(condition.detail !== "" ? { detail: condition.detail } : {}),
                    });
                }
                // A guard refusal is still a reply that never arrives to the sink, so it's said, not left silent.
                stream?.failed(condition.detail || "this automation's guard skipped the run");
                return {};
            }
            observed = condition.observed;
            observedOutside = condition.outside;
            observedValue = condition.value;
            // Waiting for one thing: it has come, so the automation retires before anything runs, as a one-time wake
            // does, and a daemon that dies mid-fire cannot fire it again. A held fire is the one it was waiting for.
            if (automation.until === "first-fire") {
                await services.automations.setEnabled(automation.id, false);
            }
            // Holds the wake instead of running; inFlight releases in the finally, so the lock isn't held during the
            // wait.
            if (verdict.effect === "hold" && cleared === undefined) {
                await services.heldWakes.add(
                    heldWakeSnapshot(automation.id, verdict.autoRunAfterS, {
                        payload: capped,
                        observed,
                        origin,
                        title,
                        conversationId: resumedConversationId,
                        sessionId: resumedSessionId,
                        thread,
                        actsAs,
                    }),
                );
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
        // Somewhere other than a new agent: the owner's phone with no model, or a conversation that already exists.
        const target = automation.target ?? { kind: "agent" as const };
        if (target.kind === "notify") {
            await recordTargetRun(services, automation, await notifyOwner(services, automation, observedValue ?? observed));
            return {};
        }
        if (target.kind === "conversation") {
            const continued = await continueConversation(
                services,
                automation,
                target.conversationId,
                "met",
                {
                    ...(observed === undefined ? {} : { text: observed }),
                    ...(observedOutside === undefined ? {} : { outside: observedOutside }),
                },
                fireKey,
            );
            await recordTargetRun(services, automation, continued);
            return {};
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
        const body = wakeBody(automation, capped, late, observed);
        let failure: string | undefined;
        let runtimeSessionId: string | undefined;
        // Every fire lands in a conversation; a channel or visitor keeps one active, a schedule wake mints a fresh one.
        const turn: AgentTurn & { conversationId: string } = {
            // STREAM_NOTE is applied here, not folded into `body`, so it belongs to this fire, not the journal entry.
            prompt: stream !== undefined ? `${STREAM_NOTE}\n\n${body}` : body,
            conversationId,
            // Marks nobody is at a composer: the command gate refuses instead of prompting, plan/ask withheld.
            unattended: true,
            // Names the provider when a listener started this turn, for the guard layer; a check that read the outside
            // world names that instead, since its words are in the prompt; other triggers set nothing.
            ...(automation.trigger.kind === "listener"
                ? { outsideWake: automation.trigger.provider }
                : observedOutside !== undefined && observed !== undefined
                  ? { outsideWake: observedOutside }
                  : {}),
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
            ...(automation.account !== undefined && (automation.models ?? []).every((rung) => rung.provider === pin.provider)
                ? { account: automation.account }
                : {}),
            // Absence here is deliberate: the resolver reads no pin as no account on an unattended turn, not all.
            ...(actsAs !== undefined ? { actsAs } : {}),
        };
        // Transcript folds as it streams; opens stamped with when the turn began, not when appended, minutes later.
        const fold = new TranscriptFold(openingRows(turn, services.workspace.root, Date.now()));
        // Opened before the provider runs, like every other conversation turn (a fork's copy; nothing else opens).
        await openTurnTranscript(services, turn);
        try {
            for await (const event of services.turns.stream(turn, undefined)) {
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
        notifyWakeSettled(services, automation, conversationId, failure);
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
    // One poll pass over the manifest; `start` runs it on an interval. A call while a pass still runs joins that pass.
    // Exposed for tests.
    readonly tick: (now?: number) => Promise<void>;
}

// The snapshot as fire options: each field absent rather than undefined, so replaying a hold cannot set one the
// original fire did not carry.
// The persona rides back as a lane so the approved run wears what was decided when it was held, not what the
// automation says now; the hold itself was answered, so the lane asks for none.
const heldWakeOptions = (held: AutomationApproval, sink: OutboxSink | undefined): FireOptions => ({
    cleared: "both",
    held: held.id,
    lane: { actsAs: held.actsAs, requireApproval: false },
    ...(held.payload !== undefined ? { payload: held.payload } : {}),
    ...(held.observed !== undefined ? { observed: held.observed } : {}),
    ...(held.origin !== undefined ? { origin: held.origin } : {}),
    ...(held.title !== undefined ? { title: held.title } : {}),
    ...(held.conversationId !== undefined ? { conversationId: held.conversationId } : {}),
    ...(held.sessionId !== undefined ? { sessionId: held.sessionId } : {}),
    ...(held.thread !== undefined ? { thread: held.thread } : {}),
    ...(sink !== undefined ? { stream: sink.stream } : {}),
});

// Runs a held wake with its snapshot (`cleared: "both"`, guard already ran), then settles its thread so the next
// message resumes it. Shared by both releases, the approve route and the countdown scan.
export const runHeldWake = async (services: Services, automation: AutomationRecord, held: AutomationApproval): Promise<void> => {
    // The visitor's own stream closed when the wake was held, so a Visitor chat answer has nowhere live to go; queue it
    // where their next page load will collect it. Undefined for every other origin, which answers through its gateway.
    const sink = services.outboxStreamFor(held.origin);
    const settled = await fireAutomation(services, automation, heldWakeOptions(held, sink));
    // Before the release is over: the approve route answers its caller here, and the visitor polling a moment later
    // must find the answer rather than an empty thread.
    await sink?.settled();
    // The snapshot carries the thread's own key: an origin cannot name it, since a thread is keyed by lane too.
    if (held.thread === undefined || settled.sessionId === undefined) {
        return;
    }
    await services.threadSessions.settle(held.thread, settled.sessionId, Date.now());
};

// When this automation is next due, or undefined for one no clock drives (a webhook, a listener, a workspace event)
// and one switched off. An invalid cron can only come from a hand-edited manifest — upsert rejects it — and reads as
// no next run rather than failing whatever asked.
// A one-time wake answers its own moment even once that moment is past: the tick fires an overdue one rather than
// dropping it, so "due" stays the truth right up until it fires.
// `sandbox` is the zone of record the automation's own `tz` overrides; it is a parameter rather than a read, so this
// stays pure and every caller has to have decided which clock it means.
export const nextRunOf = (automation: AutomationRecord, sandbox: Zone): number | undefined => {
    if (!automation.enabled) {
        return undefined;
    }
    if (automation.trigger.kind === "once") {
        return automation.trigger.at;
    }
    if (automation.trigger.kind !== "schedule") {
        return undefined;
    }
    try {
        return new Cron(automation.trigger.cron, cronOptions(zoneOf(automation.trigger, sandbox))).nextRun()?.getTime();
    } catch {
        // allow(silent-catch): a cron that doesn't parse has no next run.
        return undefined;
    }
};

// The soonest one-time wake, for the idle-stop watchdog; 0 when none is armed. Stopped, this daemon is the only thing
// that could fire one and only a visit brings it back, so the watchdog holds the machine up rather than sleeping
// through a moment somebody was promised (system/idle-stop.ts).
// Only `once` counts, deliberately. A cron whose moment passes while the machine sleeps fires once, late, the next time
// the daemon starts (`catchUp`), and a hosted machine held awake all month so a nightly chore is punctual costs more
// than the chore; a one-time wake is a moment somebody was promised, and holds the machine for at most one window,
// since it retires as it fires.
export const nextOneTimeWakeAt = async (services: Services): Promise<number> => {
    // Reads the moment off the trigger rather than through `nextRunOf`: a one-time wake IS an instant, so it needs no
    // zone, and routing it through the cron path would make this depend on a setting it has no business reading.
    const due = (await services.automations.list()).flatMap((automation) =>
        automation.enabled && automation.trigger.kind === "once" ? [automation.trigger.at] : [],
    );
    return due.length === 0 ? 0 : Math.min(...due);
};

// Past this, a one-time wake did not merely wait out a poll: nothing was running when its moment came, and the woken
// turn is told so, because "your 3pm reminder" delivered at 9pm has to say which of the two times it means.
const LATE_WAKE_MS = 2 * 60_000;

// The instant in ISO because that is what a model reads without ambiguity, AND the same instant on the owner's own
// clock, because that is the one they will recognise. A note carrying only "18:43Z" makes the agent do the conversion
// itself to say anything useful, and it has no reliable way to know which zone to convert into.
const lateWakeNote = (at: number, now: number, zone: Zone): string =>
    [
        `This wake was due at ${new Date(at).toISOString()} (${wallClockIn(at, zone)}), and is running`,
        `${Math.round((now - at) / 60_000)} minutes late: the sandbox was not running when its moment came, and fired it`,
        `at the first opportunity after.`,
        `If you pass this on to somebody, say when it was meant to arrive rather than implying it is on time,`,
        `and say it on the ${zone} clock rather than in UTC.`,
    ].join(" ");

// Whether an interrupted fire of this automation may be re-fired at boot (turn-resume.ts). A retired `once` was
// switched off BY its own fire rather than by the owner, so one the daemon died under still resumes; every other
// trigger reads `enabled` as the owner's own answer, and a switched-off automation stays off.
// A watch waiting for one thing (`until: first-fire`) retires the same way, by its own fire.
export const resumable = (automation: Pick<Automation, "enabled" | "trigger" | "until">): boolean =>
    automation.enabled || automation.trigger.kind === "once" || automation.until === "first-fire";

// Fires a one-time wake whose moment has arrived, switching it off FIRST: `at` stays in the past forever, so every
// later poll would match it again and the switch is the only thing standing between one reminder and one every 30
// seconds. Retired before the fire rather than after, so a daemon that dies mid-wake still cannot repeat it — the
// interrupted fire comes back through the turn journal instead (see `resumable`).
// Deliberately not gated on the poll window the cron path uses: a moment that passed while the sandbox was down still
// fires, late and saying so. A cron's missed moments are the boot's catch-up instead (`catchUp`), since a cron has
// many and is owed only one of them.
const fireOnceWake = async (services: Services, automation: AutomationRecord, at: number, now: number, sandbox: Zone): Promise<void> => {
    if (at > now) {
        return;
    }
    await services.automations.setEnabled(automation.id, false);
    // The sandbox's zone, never a per-automation override: a one-time wake stores an instant and has no zone of its
    // own, and the clock the owner will recognise is the sandbox's.
    const late = now - at >= LATE_WAKE_MS ? { payload: lateWakeNote(at, now, sandbox) } : {};
    void fireAutomation(services, automation, late).catch((error: unknown) =>
        services.logger.error({ err: error, automation: automation.id }, "one-time automation run failed"),
    );
};

// One enabled automation's clock, per poll: a one-time wake fires the moment it is due or already overdue, a cron
// fires when its next run measured from the last poll falls inside this one. Every other trigger has its own
// dispatcher and nothing to do here. Answers the moment a cron fired for, which is how far its clock is now covered.
const fireIfDue = async (services: Services, automation: AutomationRecord, windowStart: number, now: number, sandbox: Zone): Promise<number | undefined> => {
    if (automation.trigger.kind === "once") {
        await fireOnceWake(services, automation, automation.trigger.at, now, sandbox);
        return undefined;
    }
    if (automation.trigger.kind !== "schedule") {
        return undefined;
    }
    // A cron hand-edited into invalidity only silences its own automation, never the tick.
    let due: Date | null;
    try {
        due = new Cron(automation.trigger.cron, cronOptions(zoneOf(automation.trigger, sandbox))).nextRun(new Date(windowStart));
    } catch {
        // allow(silent-catch): an invalid cron silences only its own automation, never the tick.
        return undefined;
    }
    if (due === null || due.getTime() > now) {
        return undefined;
    }
    void fireAutomation(services, automation).catch((error: unknown) =>
        services.logger.error({ err: error, automation: automation.id }, "automation run failed"),
    );
    return due.getTime();
};

// A detached fire's failure, logged rather than lost: nothing awaits it.
const loggedAs =
    (services: Pick<Services, "logger">, message: string, automation?: string) =>
    (error: unknown): void =>
        services.logger.error({ err: error, automation }, message);

// What a pass changes about the schedules' coverage marks (schedule-coverage.ts); undefined drops a mark.
type MarkChanges = Record<string, ScheduleMark | undefined>;

// The marks that follow from the manifest alone, as of `at`: a schedule seen on with no live mark is armed from then (a
// new one, or one switched back on, owes nothing from before); one seen off is marked off; a mark whose automation is
// gone or no longer a schedule is dropped. Empty when nothing moved, which is every ordinary poll.
export const armingMarks = (automations: readonly AutomationRecord[], marks: Readonly<Record<string, ScheduleMark>>, at: number) => {
    const changes: MarkChanges = {};
    const schedules = new Set<string>();
    for (const automation of automations) {
        if (automation.trigger.kind !== "schedule") {
            continue;
        }
        schedules.add(automation.id);
        const mark = marks[automation.id];
        if (automation.enabled && (mark === undefined || mark.off === true)) {
            changes[automation.id] = { coveredUntil: at };
        }
        if (!automation.enabled && mark?.off !== true) {
            changes[automation.id] = { coveredUntil: at, off: true };
        }
    }
    for (const id of Object.keys(marks)) {
        if (!schedules.has(id)) {
            changes[id] = undefined;
        }
    }
    return changes;
};

// The latest moment of an enabled schedule that passed after its clock was last accounted for and by `horizon`, or
// undefined when none is owed. Accounted for is the later of its coverage mark and its newest run; with neither (an
// automation this build has never seen armed and that never ran) nothing is owed, so nothing fires unasked. One seen
// switched off owes nothing either: switching it back on is not asking for what it skipped.
export const missedMoment = (automation: AutomationRecord, mark: ScheduleMark | undefined, horizon: number, sandbox: Zone): number | undefined => {
    if (automation.trigger.kind !== "schedule" || mark?.off === true) {
        return undefined;
    }
    const accounted = [mark?.coveredUntil, automation.runs[0]?.at].filter((at): at is number => at !== undefined);
    if (accounted.length === 0) {
        return undefined;
    }
    try {
        const cron = new Cron(automation.trigger.cron, cronOptions(zoneOf(automation.trigger, sandbox)));
        const first = cron.nextRun(new Date(Math.max(...accounted)))?.getTime();
        if (first === undefined || first > horizon) {
            return undefined;
        }
        // Strictly before its reference, so one past the horizon finds a moment AT the horizon too.
        return Math.max(first, cron.previousRuns(1, new Date(horizon + 1))[0]?.getTime() ?? first);
    } catch {
        // allow(silent-catch): an invalid cron owes nothing, as it never fires on a poll either.
        return undefined;
    }
};

// A repair of the main tree waits for lands to stop moving it, and no longer than this once its countdown is over.
export const LAND_QUIET_MS = 5 * 60_000;
export const LAND_QUIET_CAP_MS = 60 * 60_000;

// The newest land any conversation made, epoch ms; 0 when none has.
const lastLandAt = (services: Services): number =>
    Math.max(
        0,
        ...services.agents.list().flatMap((summary) => {
            const entry = services.agents.entry(summary.id);
            return (entry === undefined ? [] : reposOf(entry)).map((repo) => repo.landedAt ?? 0);
        }),
    );

// Whether a held wake past its countdown may start: one woken by the workspace repairs the main tree, which only lands
// move, so it waits out lands; any other waits out every live turn, since it would start work under someone.
export const heldWakeQuiet = (
    trigger: Trigger["kind"] | undefined,
    now: number,
    fleet: { readonly lastLand: number; readonly liveTurns: number; readonly autoRunAt: number },
): boolean => (trigger === "workspace" ? now - fleet.lastLand >= LAND_QUIET_MS || now - fleet.autoRunAt >= LAND_QUIET_CAP_MS : fleet.liveTurns === 0);

// What heldWakeQuiet reads, asking only what the trigger's rule needs: land times for a repair, live turns otherwise.
const fleetFor = (services: Services, trigger: Trigger["kind"] | undefined, autoRunAt: number) =>
    trigger === "workspace"
        ? { lastLand: lastLandAt(services), liveTurns: 0, autoRunAt }
        : { lastLand: 0, liveTurns: services.conversations.liveSessionIds().length, autoRunAt };

// Releases countdown holds past deadline once quiet (heldWakeQuiet); removed before running so it can't re-fire. A
// retired one-time wake still releases: it was switched off by the very fire now waiting in the queue.
const releaseCountdownHolds = async (services: Services, now: number): Promise<void> => {
    for (const held of await services.heldWakes.list()) {
        if (held.autoRunAt === undefined || held.autoRunAt > now) {
            continue;
        }
        const automation = await services.automations.get(held.automationId);
        if (!heldWakeQuiet(automation?.trigger.kind, now, fleetFor(services, automation?.trigger.kind, held.autoRunAt))) {
            continue;
        }
        // Only the release whose remove took the entry runs it: an approval racing this pass has already fired it.
        if (!(await services.heldWakes.remove(held.id)) || automation === undefined || !resumable(automation)) {
            continue;
        }
        void runHeldWake(services, automation, held).catch(loggedAs(services, "countdown-released automation run failed", automation.id));
    }
};

// Polls the manifest and fires whatever came due since the last pass; fires run detached, since a turn can outlast many
// polls. Event automations fire from the fire route instead.
// What happened while nothing was running is the start's to settle (`catchUp`): a hosted sandbox stops itself when
// nobody is connected (system/idle-stop.ts) and is not woken for a cron, so a machine asleep at the same hour every day
// would otherwise never run its nightly chore at all. Each schedule that missed a moment fires ONCE, however many it
// missed, late and saying so, through the same gates as any fire: the sessions bar, the guard, an approval hold. A
// schedule asks for its work to be done regularly, not for a backlog to be replayed.
export const createAutomationsScheduler = (services: Services, intervalMs = 30_000): AutomationsScheduler => {
    // Where the first poll's window opens, and so where the catch-up's ends: a moment is one pass's or the other's.
    let since = Date.now();
    let timer: NodeJS.Timeout | undefined;
    // One pass at a time: an interval that comes round while the last pass still runs joins it. A second pass would
    // read the manifest before the first had switched a fired one-time wake off, and fire it again; skipping loses
    // nothing, since the next pass's window opens where the last one's closed.
    const passes = new SingleFlight<"pass", void>();

    const pass = async (now: number): Promise<void> => {
        const windowStart = since;
        since = now;
        // Read once per poll, not per automation: the owner's zone cannot change between two rows of the same pass,
        // and a settings read per automation would make a manifest of fifty chores fifty file reads a tick.
        const sandbox = await sandboxZone(services);
        const automations = await services.automations.list();
        const changes = armingMarks(automations, await services.scheduleCoverage.read(), windowStart);
        for (const automation of automations.filter((candidate) => candidate.enabled)) {
            // Per automation: this window is already spent, so one that throws must not cost every later one its moment.
            try {
                // An end date is kept by the tick, not only by a fire, so a webhook or a listener that never comes still
                // ends when it said it would, and says so.
                if (automation.expiresAt !== undefined && automation.expiresAt <= now) {
                    await expireAutomation(services, automation);
                    continue;
                }
                const fired = await fireIfDue(services, automation, windowStart, now, sandbox);
                if (fired !== undefined) {
                    changes[automation.id] = { coveredUntil: fired };
                }
            } catch (error) {
                loggedAs(services, "automation could not be checked for a due run", automation.id)(error);
            }
        }
        await services.scheduleCoverage.mark(changes);
        await releaseCountdownHolds(services, now);
    };
    const tick = (now = Date.now()): Promise<void> => passes.run("pass", () => pass(now));

    const catchUp = async (): Promise<void> => {
        const horizon = since;
        const sandbox = await sandboxZone(services);
        const automations = await services.automations.list();
        const marks = await services.scheduleCoverage.read();
        const changes = armingMarks(automations, marks, horizon);
        const owed = automations.flatMap((automation) => {
            const missed = automation.enabled ? missedMoment(automation, marks[automation.id], horizon, sandbox) : undefined;
            return missed === undefined ? [] : [{ automation, missed }];
        });
        for (const { automation } of owed) {
            changes[automation.id] = { coveredUntil: horizon };
        }
        // Covered before fired, as a one-time wake retires before it fires: a daemon that dies under the catch-up
        // resumes that fire from the turn journal, and must not owe the same moment again on top of it.
        await services.scheduleCoverage.mark(changes);
        for (const { automation, missed } of owed) {
            void fireAutomation(services, automation, { late: lateWakeNote(missed, Date.now(), sandbox) }).catch(
                loggedAs(services, "missed scheduled run failed", automation.id),
            );
        }
    };

    return {
        tick,
        start: () => {
            void catchUp().catch(loggedAs(services, "automations catch-up failed"));
            timer = setInterval(() => void tick(), intervalMs);
        },
        stop: () => clearInterval(timer),
    };
};
