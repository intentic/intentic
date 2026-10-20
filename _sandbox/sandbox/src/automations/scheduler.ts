import { Cron } from "croner";
import type { AgentEvent } from "@intentic/sandbox-contract/events/agent-events";
import type { AgentOrigin, AgentTurn, ModelPin } from "@intentic/sandbox-contract/schemas/agent";
import type { Automation, AutomationApproval, Trigger } from "@intentic/sandbox-contract/schemas/automations";
import type { ListenerPlanItem, ListenerStep, ListenerTurnOpened } from "@intentic/sandbox-contract/protocol/doors/listener-protocol";
import type { Zone } from "@intentic/sandbox-contract/time/zone";
import { capabilitiesOf } from "@intentic/sandbox-contract/models/agent-catalog";
import { cronOptions, wallClockIn } from "@intentic/sandbox-contract/time/zone";
import { TranscriptFold } from "@intentic/sandbox-contract/transcript-fold";
import { openingRows, openTurnTranscript, recordTurnTranscript } from "../sessions/turn-transcript.js";
import type { Services } from "../composition.js";
import { reposOf } from "../conversations/registry/agents-store.js";
import { sessionStart, wakeSourceOf } from "../guard/actions.js";
import { guard } from "../guard/guard.js";
import { wrapOutsideContent } from "@intentic/base/outside-text";
import { automationPending, turnFinished } from "../push/notifications.js";
import { pinnedRunModel } from "../agent/models/run-role-model.js";
import { sessionFor } from "../conversations/registry/routing.js";
import type { OutboxSink } from "../webchat/webchat-outbox.js";
import { type AutomationRecord, consecutiveFailures } from "./automations-store.js";
import type { ScheduleMark } from "./schedule-coverage.js";
import { nextDueAfter, nextRunOf, sandboxZone, zoneOf } from "./schedule-zone.js";
import { type DueAt, nudgedPass } from "../workload/nudged-pass.js";
import type { SenderLane } from "./senders.js";
import type { JournalledFire } from "../store/journals/turn-journal.js";
import { opt } from "../opt.js";
import { TITLE_MAX } from "../seams/conversation-title.js";
import { continueConversation, endedInstead, expireAutomation, notifyOwner, outsideWakeOf, type TargetOutcome } from "./watch/fire-targets.js";
import { conditionOutside } from "./watch/watch-condition.js";
import { perDaemon } from "./durable/daemon-memory.js";
import { admitFire, admitThenLetGo, checkFireCondition, clearJournalled, forgetHeldWake, journalledFire, queuedFire } from "./durable/fire-admission.js";
import { withdrawApprovalPush } from "./held-wake-answers.js";
import { channelAnswerSink } from "../extensions/listener/listener-deliver.js";
import type { ReleasedWake } from "./held-wakes-store.js";
import { type TurnProgressReader, turnProgressReader } from "../extensions/listener/listener-progress.js";
import { conversationLink } from "../system/boot/open-in-app.js";
import type { TurnInput } from "../seams/turn-starter.js";
import { refusalOf, type WakeRefusal, wakeEnding, wakePostures } from "./wake/wake-fallback.js";
import { mintConversationId, sessionsGate } from "./fire/fire-sessions.js";

// How much of an event's webhook body reaches the guard's env and the wake prompt.
export const PAYLOAD_MAX = 64_000;

// Live sink for a turn's assistant text; undefined means the agent sends its own reply. `failed` distinguishes no
// output from an error, carrying the raw reason for each sink to redact; always followed by `end`. The rest is what a
// channel can show while it waits, each optional, so a sink that only takes the reply's text (the Visitor chat) still
// fits: the turn it opened, each step of its work and its checklist (extensions/listener/listener-progress.ts), and why it has not started.
export interface TurnStream {
    readonly delta: (text: string) => void;
    readonly failed: (reason: string) => void;
    readonly end: () => void;
    readonly opened?: (turn: ListenerTurnOpened) => void;
    readonly step?: (step: ListenerStep) => void;
    readonly plan?: (items: readonly ListenerPlanItem[]) => void;
    readonly held?: (reason: string) => void;
    readonly queued?: (reason: string) => void;
    // The message went into a turn already running in its thread; that turn's own sink carries the answer.
    readonly steered?: () => void;
}

// What the channel hears while its wake waits for a person, and while it waits behind another turn of its automation.
export const HELD_NOTICE = "This needs the owner's approval before I start on it; the answer comes here once they approve it.";
export const QUEUED_NOTICE = "Another task of mine is still running; I start on this one as soon as it finishes.";

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

// How the fires of one automation take turns, shared by the tick, the dispatchers, the doors and the fire route.
// - A fire no provider thread owns (a schedule, a webhook, a workspace event, a channel-level message, a Visitor chat, a
//   pressed Run now) runs ALONE, as every fire did before threads shared: it waits for every fire of its automation
//   already admitted, and every fire admitted after it waits for it. Such an automation still never overlaps itself.
// - A fire on a provider's own thread (the Discord or Slack thread a team-chat mention is answered in) SHARES its
//   automation with the fires on its other threads: it waits only for a fire running alone that was admitted before it,
//   for the last fire on its own conversation, and for one of `automationThreadsAtOnce` slots. Two people mentioning
//   the bot in two threads are answered side by side; one more than the setting allows is told it is queued.
// So two fires of one automation overlap only on two conversations, which is what lets the turn journal file a fire
// in flight under its conversation (store/journals/turn-journal.ts).
interface FireLanes {
    // Settles once every fire admitted so far has: what a fire running alone waits for, and what automationIdle reads.
    all: Promise<void>;
    // Settles once the last fire admitted to run alone has: what a thread's fire admitted after it waits behind.
    alone: Promise<void>;
    // The last fire admitted on each shared conversation, settling with it: what the next one there waits behind.
    readonly conversations: Map<string, Promise<void>>;
    // Fires admitted and not yet settled, all of them and those running alone; the lanes go when nothing is admitted.
    admitted: number;
    admittedAlone: number;
    // Thread fires working now, how many may (the setting as last read), and those waiting for a slot, oldest first.
    working: number;
    cap: number;
    readonly waiting: (() => void)[];
}

// Each daemon's lanes, by automation (durable/daemon-memory.ts).
const fireLanesOf = perDaemon(() => new Map<string, FireLanes>());

const openLanes = (): FireLanes => ({
    all: Promise.resolve(),
    alone: Promise.resolve(),
    conversations: new Map(),
    admitted: 0,
    admittedAlone: 0,
    working: 0,
    cap: 1,
    waiting: [],
});

// The conversation a fire shares its automation on, or undefined for one that runs alone. A fire shares when it
// belongs to a thread (its thread key and conversation) that is a provider's own thread, which only its origin says: a
// channel-level message's origin names no thread. All three ride a held wake's snapshot and the turn journal, so an
// approved hold and a restart's re-fire take turns exactly as the fire they replay did.
const sharedConversationOf = ({ thread, conversationId, origin }: FireOptions): string | undefined =>
    thread !== undefined && origin?.threadId !== undefined ? conversationId : undefined;

// Hands free slots to the thread fires waiting longest, as many as the setting allows.
const fillSlots = (lanes: FireLanes): void => {
    while (lanes.working < lanes.cap && lanes.waiting.length > 0) {
        lanes.working += 1;
        lanes.waiting.shift()?.();
    }
};

// How many threads of one automation may be worked on at once, read per fire so a change holds from the next thread
// on. A read that fails works one thread at a time, as every automation did before the setting existed.
const threadsAtOnce = async (services: Pick<Services, "sandboxSettings" | "logger">): Promise<number> => {
    try {
        return (await services.sandboxSettings.get()).automationThreadsAtOnce;
    } catch (error) {
        services.logger.warn({ err: error }, "settings unreadable: threads of an automation are worked on one at a time");
        return 1;
    }
};

// One of the slots a thread's turn runs in, waited for in line once they are all working.
const takeSlot = async (services: Services, lanes: FireLanes, onWait: () => void): Promise<void> => {
    lanes.cap = await threadsAtOnce(services);
    // A raised setting lets in those already waiting first; only then is a slot left over for this fire.
    fillSlots(lanes);
    if (lanes.working < lanes.cap) {
        lanes.working += 1;
        return;
    }
    onWait();
    // Counted by fillSlots as it hands the slot over, so no fire arriving in between can take it.
    await new Promise<void>((resolve) => lanes.waiting.push(resolve));
};

const giveSlot = (lanes: FireLanes): void => {
    lanes.working -= 1;
    fillSlots(lanes);
};

// Everything a fire needs beyond the automation itself; an options object since dispatchers and the tick each set a
// different subset.
export interface FireOptions {
    readonly inboxIds?: readonly string[];
    readonly admission?: JournalledFire;
    // Inbox-to-journal handoff; acknowledged only after the admission is durable.
    readonly accepted?: () => Promise<void>;
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
    // Replaces the automation's own `allowedTools` for this one fire. Every fire already carries the automation's list
    // (runFire reads it off the record), whichever door it came through, so this is only for a caller that must differ.
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
    // What happens when this fire meets one it has to wait for (FireLanes): any fire of its automation, for a fire that
    // runs alone; a fire running alone or one on its own conversation, for a thread's. Every thread slot being taken is
    // not an overlap, and always queues.
    // - `drop` (default): a cron or workspace-event re-fire is not wanted twice; the next tick comes anyway.
    // - `queue`: for an inbound message with no next tick; waits for the run in progress, keeping its reply sink open.
    readonly overlap?: "drop" | "queue";
}

// What a fire leaves for a caller running another one on the same conversation: the provider session to resume, absent
// when no turn ran or none was minted.
export interface FireOutcome {
    readonly sessionId?: string;
}

// Fires one automation, taking its turn among the automation's other fires (FireLanes); owns only that and the overlap
// policy (refuse or wait), with `runFire` doing the fire itself. Callers run it detached; tests await it directly.
export const fireAutomation = async (services: Services, automation: AutomationRecord, options: FireOptions = {}): Promise<FireOutcome> => {
    const fireLanes = fireLanesOf.of(services);
    const lanes = fireLanes.get(automation.id) ?? openLanes();
    const shared = sharedConversationOf(options);
    // Whether this fire has to wait for one already admitted, decided now, before anything after it is admitted.
    const blocked = shared === undefined ? lanes.admitted > 0 : lanes.admittedAlone > 0 || lanes.conversations.has(shared);
    if (blocked && options.overlap !== "queue") {
        // Dropped as overlapping means no reply is coming; runFire's finally never runs here, so this closes the sink.
        options.stream?.failed("this automation is already running, so the message was not picked up");
        options.stream?.end();
        return {};
    }
    // Waiting is said where the message came from, once, so a quiet thread reads as queued rather than dead.
    let toldQueued = false;
    const tellQueued = (): void => {
        if (!toldQueued) {
            toldQueued = true;
            options.stream?.queued?.(QUEUED_NOTICE);
        }
    };
    if (blocked) {
        tellQueued();
    }
    const entry = options.admission ?? queuedFire(automation.id, mintConversationId(automation.id, Date.now()), options);
    // Durable before it waits, and only then is its source let go (durable/fire-admission.ts).
    const admitted = admitThenLetGo(services, automation.id, entry, options.accepted);
    const run = async (): Promise<FireOutcome> => {
        if (!(await admitted)) {
            options.stream?.failed("this message could not be taken in; it will be picked up again");
            options.stream?.end();
            return {};
        }
        return runFire(services, automation, { ...options, admission: entry });
    };
    // The lanes are the lock: what a fire waits for never rejects, so a failed fire still lets the next one start.
    const turn =
        shared === undefined
            ? lanes.all.then(run)
            : Promise.all([lanes.alone, lanes.conversations.get(shared)]).then(async () => {
                  await takeSlot(services, lanes, tellQueued);
                  try {
                      return await run();
                  } finally {
                      giveSlot(lanes);
                  }
              });
    const settled = turn.then(
        () => undefined,
        () => undefined,
    );
    lanes.admitted += 1;
    lanes.all = Promise.all([lanes.all, settled]).then(() => undefined);
    if (shared === undefined) {
        lanes.admittedAlone += 1;
        lanes.alone = settled;
    } else {
        lanes.conversations.set(shared, settled);
    }
    fireLanes.set(automation.id, lanes);
    void settled.then(() => {
        lanes.admitted -= 1;
        if (shared === undefined) {
            lanes.admittedAlone -= 1;
        } else if (lanes.conversations.get(shared) === settled) {
            // Only the last fire on a conversation clears it; an earlier one must not unlock a fire queued behind it.
            lanes.conversations.delete(shared);
        }
        if (lanes.admitted === 0 && fireLanes.get(automation.id) === lanes) {
            fireLanes.delete(automation.id);
        }
    });
    return turn;
};

// Waits until nothing of this automation is running or waiting, every thread's fire included. A recorded run isn't the
// same as free again, since a fire lets the next one go only when it returns; firing the same automation twice in a
// row must await this in between. A fire admitted while this waits is waited for too, until one wait finds nothing new.
// `daemon` narrows it to one daemon's fires (durable/daemon-memory.ts), for a test that runs a second beside a dead first.
export const automationIdle = async (id: string, daemon?: Pick<Services, "automations">): Promise<void> => {
    for (const fireLanes of daemon === undefined ? fireLanesOf.all() : [fireLanesOf.of(daemon)]) {
        let awaited: Promise<void> | undefined;
        for (let lanes = fireLanes.get(id); lanes !== undefined && lanes.all !== awaited; lanes = fireLanes.get(id)) {
            awaited = lanes.all;
            await awaited;
        }
    }
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

// Whether a rung's runtime keeps a turn to its tool list (AgentCapabilities.toolAllowlist); a rung naming no loop runs on
// its provider's own.
const keepsToolList = (rung: ModelPin): boolean => capabilitiesOf(rung.provider, rung.harness ?? "native").toolAllowlist;


// Walks the automation's model ladder for the first rung this sandbox can run; undefined means no wake, already
// recorded. A fully disconnected ladder is an `error` run, counted toward the failure streak.
const wakeModel = async (
    services: Services,
    automation: AutomationRecord,
    stream: TurnStream | undefined,
    allowedTools: readonly string[] | undefined,
): Promise<ModelPin | undefined> => {
    const configured = automation.models ?? [];
    // A fire held to a tool list runs only on a rung whose runtime checks every call against it; any other rung would
    // run with its whole toolbox, so it is passed over here rather than refused at the door after a model was spent on
    // choosing it.
    const ladder = allowedTools === undefined ? configured : configured.filter(keepsToolList);
    if (allowedTools !== undefined && configured.length > 0 && ladder.length === 0) {
        const reason =
            "This automation may use only the tools on its list, and none of its models runs on a loop that can hold a turn to one: pin a model that runs on the Claude Code loop, or take the tool list off.";
        await services.automations.recordRun(automation.id, { at: Date.now(), outcome: "error", detail: reason });
        stream?.failed(reason);
        return undefined;
    }
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

// Whoever wrote is told the wake waits for a person, rather than left reading silence as a dead bot.
const announceHeld = (stream: TurnStream | undefined): void => {
    stream?.held?.(HELD_NOTICE);
};

// The channel learns which conversation answers it, and where a person opens that, before any of the work.
const announceOpened = (services: Pick<Services, "config">, stream: TurnStream | undefined, conversationId: string): void => {
    stream?.opened?.({ conversationId, ...opt("link", conversationLink(services.config, conversationId)) });
};

// What a live sink hears of one of the turn's frames: the turn's own words (a subagent's narration stays in the
// conversation, not in the reply), and the steps and checklist a channel shows while it waits.
const tellStream = (stream: TurnStream | undefined, progress: TurnProgressReader, event: AgentEvent): void => {
    if (stream === undefined) {
        return;
    }
    if (event.kind === "delta" && event.parentToolUseId === undefined) {
        stream.delta(event.text);
        return;
    }
    const update = progress.read(event);
    if (update === undefined) {
        return;
    }
    if ("step" in update) {
        stream.step?.(update.step);
    } else {
        stream.plan?.(update.plan);
    }
};

// Guard, then wake, then record the run; reached only through fireAutomation, which guarantees no two runs on one
// conversation overlap here, and none at all of an automation whose fire runs alone (FireLanes).
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
        allowedTools: narrowedTools,
        stream,
        origin,
        title,
        late,
        observed: replayedObservation,
        held,
        admission: admissionEntry,
    }: FireOptions,
): Promise<FireOutcome> => {
    // This fire's own name, for a delivery that must not be mistaken for another fire's.
    const fireKey = held === undefined ? `at-${Date.now()}` : `held-${held}`;
    // The conversation this fire's journal entry is filed under, cleared however the fire ends. A re-fire's is known
    // from the start, since the boot pass spent its entry before firing it: one that ends before journalling anew
    // (skipped, refused, expired) still takes that entry off, rather than leaving it to read as interrupted next boot.
    let journalled = admissionEntry?.id ?? resumedConversationId;
    try {
        // Past its end date it does nothing but end: switched off, and whoever it was for told. A held wake already
        // released by a person is theirs to have, so a replay goes ahead.
        if (await endedInstead(services, automation, cleared, stream)) {
            return {};
        }
        let capped = payload?.slice(0, PAYLOAD_MAX);
        // What the check saw, worded for the wake, and where its words came from when that was outside the sandbox. A
        // replay carries the check that ran when it was held; it does not run again.
        let observed = replayedObservation;
        let observedOutside = replayedObservation === undefined ? undefined : conditionOutside(automation);
        let observedValue: string | undefined = admissionEntry?.observedValue;
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
            const gate = resumedConversationId === undefined ? sessionsGate(services, automation, PAYLOAD_MAX) : {};
            if ("skipped" in gate) {
                await services.automations.recordRun(automation.id, { at: Date.now(), outcome: "skipped", detail: gate.skipped });
                stream?.failed(gate.skipped);
                return {};
            }
            // The sessions are a gated fire's payload: what woke it, read by the guard and appended under the prompt.
            capped = gate.listing ?? capped;
            // The check: a guard command or a ready-made source, deciding without a model whether anything happened.
            const condition = await checkFireCondition(services, automation, capped, admissionEntry);
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
                    admissionEntry?.id,
                );
                void services.activity
                    .append({
                        direction: "system",
                        type: "automation.pending",
                        automationIds: [automation.id],
                        ...(automation.trigger.kind === "listener" ? { provider: automation.trigger.provider } : {}),
                    })
                    .catch((error: unknown) => services.logger.warn({ err: error }, "activity append failed"));
                announceHeld(stream);
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
        // The automation's own allowlist is the boundary for every door, read off the record as it is now rather than as
        // it was when a queued or held fire was set up, so narrowing it takes effect on the very next turn. A caller's
        // own list replaces it only where it was given.
        const allowedTools = narrowedTools ?? (await currentAllowedTools(services, automation));
        const pin = await wakeModel(services, automation, stream, allowedTools);
        if (pin === undefined) {
            return {};
        }
        // Journals the fire's trigger inputs, not the resolved turn, so a re-fire re-reads a prompt since fixed. The
        // sender's lane, thread and session ride along: without them a stranger a sender rule put on a narrow persona
        // would come back after a restart wearing the automation's own, on a conversation its thread no longer knows.
        const conversationId = resumedConversationId ?? admissionEntry?.conversationId ?? mintConversationId(automation.id, Date.now());
        journalled = admissionEntry?.id ?? conversationId;
        await services.turnJournal
            .recordFire({
                ...admissionEntry,
                ...journalledFire(automation.id, conversationId, attempts, { payload: capped, origin, title, lane, thread, sessionId: resumedSessionId }),
                state: "running", checked: true, ...opt("observed", observed), ...opt("observedValue", observedValue),
            });
        const body = wakeBody(automation, capped, late, observed);
        let failure: string | undefined;
        let refusal: WakeRefusal | undefined;
        let runtimeSessionId: string | undefined;
        // Account rides only if every rung agrees on provider, meaningless elsewhere; else best-headroom wins.
        const account =
            automation.account !== undefined && (automation.models ?? []).every((rung) => rung.provider === pin.provider) ? automation.account : undefined;
        // A thread's session resumes only on the runtime and account that minted it, judged on the rung this fire resolved to
        // (routing.ts): an automation whose ladder moved to another provider since the last message opens a fresh session
        // seeded from the record, rather than naming one the provider will not hold. A fire whose thread named no session
        // opens a fresh one, as it always did.
        const sessionId =
            resumedSessionId === undefined ? undefined : sessionFor(services, { conversationId, agent: pin.provider, harness: pin.harness, account, sessionId: resumedSessionId });
        // Every fire lands in a conversation; a channel or visitor keeps one active, a schedule wake mints a fresh one.
        const turn: TurnInput & { conversationId: string } = {
            // STREAM_NOTE is applied here, not folded into `body`, so it belongs to this fire, not the journal entry.
            prompt: stream !== undefined ? `${STREAM_NOTE}\n\n${body}` : body,
            conversationId,
            // Marks nobody is at a composer: the command gate refuses instead of prompting, plan/ask withheld.
            unattended: true,
            // Names the provider when a listener started this turn, for the guard layer; a check that read the outside
            // world names that instead, since its words are in the prompt; other triggers set nothing.
            ...opt("outsideWake", outsideWakeOf(automation, observedOutside, observed)),
            // Resumes the provider session on a continuing thread; absent on a first turn or any one-off wake.
            ...opt("sessionId", sessionId),
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
            ...opt("account", account),
            // Absence here is deliberate: the resolver reads no pin as no account on an unattended turn, not all.
            ...(actsAs !== undefined ? { actsAs } : {}),
            // Nobody presses Send again on a wake: it answers a spent allowance or a stop itself (wake-fallback.ts).
            postures: wakePostures((await services.sandboxSettings.get()).limitPolicy),
        };
        // Transcript folds as it streams; opens stamped with when the turn began, not when appended, minutes later.
        const fold = new TranscriptFold(openingRows(turn, services.workspace.root, Date.now()), Date.now);
        // Opened before the provider runs, like every other conversation turn (a fork's copy; nothing else opens).
        await openTurnTranscript(services, turn);
        announceOpened(services, stream, conversationId);
        const progress = turnProgressReader();
        try {
            for await (const event of services.turns.stream(turn, undefined)) {
                fold.apply(event);
                if (event.kind === "session") {
                    runtimeSessionId = event.sessionId;
                }
                if (event.kind === "error") {
                    failure = event.message;
                    refusal = refusalOf(event);
                }
                tellStream(stream, progress, event);
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
        // A spent allowance its ladder answers moves on now; one a near reset answers goes again then (its postures).
        const ending = await wakeEnding(services, { conversationId, ladder: automation.models, ran: pin }, failure, refusal);
        // Conversation id rides on the run record so a wake that reached a turn is openable with no runtime session.
        await services.automations.recordRun(automation.id, { at: Date.now(), ...ending.run, conversationId });
        // Read after recording so this fire's own outcome is part of the streak the guard weighs. A wake the sandbox
        // carries on by itself has not failed yet, so it never disables its automation.
        const quarantined = ending.failed ? await quarantineIfSpinning(services, automation.id) : undefined;
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
        await clearJournalled(services, automation.id, journalled);
    }
};

export interface AutomationsScheduler {
    readonly start: () => void;
    readonly stop: () => void;
    // One poll pass over the manifest; `start` runs it on an interval. A call while a pass still runs joins that pass.
    // Exposed for tests.
    readonly tick: (now?: number) => Promise<void>;
    // A pass soon, or once more after the one running: what a turn settling or an automation saved asks for, since
    // either may have made something due now (a countdown hold waiting for quiet, a schedule saved inside this window).
    readonly nudge: () => void;
}

// Where a fire's conversation comes from when it may belong to a thread (sessions/thread-sessions.ts), the key of which
// also keys the lane (seams/thread-key.ts):
// - an opening: a message arriving now. It continues the thread's live conversation and provider session, or past the
//   TTL starts one named by `mint`; each door names its own (a listener per fire, a public door per caller).
// - a seat: one already opened and snapshotted, by a held wake or the turn journal, continued exactly as it was. A seat
//   with no key is a fire no thread owns, a schedule's or a webhook's.
export type ThreadPlace =
    | { readonly key: string; readonly ttlMs: number; readonly mint: () => string }
    | { readonly key: string | undefined; readonly conversationId: string | undefined; readonly sessionId: string | undefined };

// Fire options a thread decides for itself, so a caller cannot hand one that disagrees with the thread.
export type ThreadFireOptions = Omit<FireOptions, "conversationId" | "sessionId" | "thread">;

// Open the thread, fire on it, settle it: the one road every threaded fire takes (listeners, the public doors, a held
// wake's release, a restart's re-fire), so the thread learns the provider session the turn ran on and the next message
// resumes it instead of restating everything. `onOpened` hears the conversation before the turn starts.
export const fireOnThread = async (
    services: Services,
    automation: AutomationRecord,
    place: ThreadPlace,
    options: ThreadFireOptions,
    onOpened?: (conversationId: string) => Promise<void>,
): Promise<FireOutcome> => {
    const seat =
        "ttlMs" in place ? { key: place.key, ...(await services.threadSessions.open(place.key, place.mint, place.ttlMs, Date.now())) } : place;
    if (seat.conversationId !== undefined) {
        await onOpened?.(seat.conversationId);
    }
    const settled = await fireAutomation(services, automation, {
        ...options,
        ...(seat.conversationId !== undefined ? { conversationId: seat.conversationId } : {}),
        ...(seat.sessionId !== undefined ? { sessionId: seat.sessionId } : {}),
        // Snapshotted with a hold and journalled with the fire, so a later release or re-fire settles this same thread.
        ...(seat.key !== undefined ? { thread: seat.key } : {}),
    });
    if (seat.key !== undefined) {
        await services.threadSessions.settle(seat.key, settled.sessionId, Date.now());
    }
    return settled;
};

// The automation's allowlist as it stands now, falling back to the record the fire was handed when it is gone.
const currentAllowedTools = async (services: Services, automation: AutomationRecord): Promise<readonly string[] | undefined> =>
    (await services.automations.get(automation.id))?.allowedTools ?? automation.allowedTools;

// The snapshot as fire options: each field absent rather than undefined, so replaying a hold cannot set one the
// original fire did not carry.
// The persona rides back as a lane so the approved run wears what was decided when it was held, not what the
// automation says now; the hold itself was answered, so the lane asks for none.
const heldWakeOptions = (held: AutomationApproval, sink: OutboxSink | undefined): ThreadFireOptions => ({
    overlap: "queue",
    cleared: "both",
    held: held.id,
    lane: { actsAs: held.actsAs, requireApproval: false },
    ...(held.payload !== undefined ? { payload: held.payload } : {}),
    ...(held.observed !== undefined ? { observed: held.observed } : {}),
    ...(held.origin !== undefined ? { origin: held.origin } : {}),
    ...(held.title !== undefined ? { title: held.title } : {}),
    ...(sink !== undefined ? { stream: sink.stream } : {}),
});

// Runs a held wake with its snapshot (`cleared: "both"`, guard already ran), then settles its thread so the next
// message resumes it. Shared by both releases, the approve route and the countdown scan; it takes only a hold one of them
// let out of the queue after checking its proof (held-wakes-store.ts, ReleasedWake).
export const runHeldWake = async (services: Services, automation: AutomationRecord, held: ReleasedWake): Promise<void> => {
    // The requester's own stream closed when the wake was held, so the answer has nowhere live to go: a Visitor chat's is
    // queued where their next page load collects it, a gateway channel's is posted into its thread once the turn ends.
    const sink = services.outboxStreamFor(held.origin) ?? channelAnswerSink(services, held.origin);
    // The snapshot carries the thread's own key: an origin cannot name it, since a thread is keyed by lane too.
    await fireOnThread(services, automation, { key: held.thread, conversationId: held.conversationId, sessionId: held.sessionId }, heldWakeOptions(held, sink));
    // Before the release is over: the approve route answers its caller here, and the visitor polling a moment later
    // must find the answer rather than an empty thread.
    await sink?.settled();
};

// The release store awaits this before deleting the hold or spending the owner's yes.
export const recordHeldWake = async (services: Services, held: ReleasedWake): Promise<void> => {
    await admitFire(services, queuedFire(held.automationId, mintConversationId(held.automationId, Date.now()), {
        ...heldWakeOptions(held, undefined), ...opt("conversationId", held.conversationId),
        ...opt("sessionId", held.sessionId), ...opt("thread", held.thread),
    }));
};

// The soonest one-time wake, 0 when none is armed: one of the promised wakes every sleep keeps
// (bootstrap/promised-wakes.ts). Held apart from `nextCronWakeAt` because it reads the instant off the trigger.
export const nextOneTimeWakeAt = async (services: Services): Promise<number> => {
    // Reads the moment off the trigger rather than through `nextRunOf`: a one-time wake IS an instant, so it needs no
    // zone, and routing it through the cron path would make this depend on a setting it has no business reading.
    const due = (await services.automations.list()).flatMap((automation) =>
        automation.enabled && automation.trigger.kind === "once" ? [automation.trigger.at] : [],
    );
    return due.length === 0 ? 0 : Math.min(...due);
};

// The soonest moment a cron fires, for the sleep alarm and anyone restarting through it (bootstrap/promised-wakes.ts);
// 0 when none is armed. One-time wakes carry their instant directly; a cron needs its next run on the sandbox's clock.
export const nextCronWakeAt = async (services: Services): Promise<number> => {
    const zone = await sandboxZone(services);
    const due = (await services.automations.list()).flatMap((automation) =>
        automation.trigger.kind === "schedule" ? [nextRunOf(automation, zone) ?? 0].filter((at) => at > 0) : [],
    );
    return due.length === 0 ? 0 : Math.min(...due);
};

// The soonest a held wake's countdown ends, for whoever must not sleep through it (bootstrap/promised-wakes.ts); 0 when none
// counts down. The sandbox told its owner a `holdForSeconds` hold would go ahead by itself, and only its own clock lets it:
// a hold that waits on a person (`requireApproval`) has no moment and is not counted.
export const nextCountdownWakeAt = async (services: Services): Promise<number> => {
    const due = (await services.heldWakes.list()).flatMap((held) => (held.autoRunAt === undefined ? [] : [held.autoRunAt]));
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
    // The sandbox's zone, never a per-automation override: a one-time wake stores an instant and has no zone of its
    // own, and the clock the owner will recognise is the sandbox's.
    const late = now - at >= LATE_WAKE_MS ? { payload: lateWakeNote(at, now, sandbox) } : {};
    // Switched off once the fire is journalled, so a crash in between replays that fire rather than losing the wake.
    const retire = async (): Promise<void> => {
        await services.automations.setEnabled(automation.id, false);
    };
    void fireAutomation(services, automation, { ...late, accepted: retire }).catch((error: unknown) =>
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
// A countdown still running reports its end to `due`, so the pass is woken on it rather than up to a poll late; one past
// it that waits for quiet is woken by the turn settling or the land that brings it (createAutomationsScheduler.nudge).
const releaseCountdownHolds = async (services: Services, now: number, due: DueAt): Promise<void> => {
    // `list` shows a countdown only on a hold the daemon minted, and the release checks it again as it takes the hold out.
    for (const held of await services.heldWakes.list()) {
        if (held.autoRunAt === undefined) {
            continue;
        }
        if (held.autoRunAt > now) {
            due(held.autoRunAt);
            continue;
        }
        const automation = await services.automations.get(held.automationId);
        if (!heldWakeQuiet(automation?.trigger.kind, now, fleetFor(services, automation?.trigger.kind, held.autoRunAt))) {
            continue;
        }
        // Only the release that takes the entry runs it: an approval racing this pass has already fired it.
        const released = await services.heldWakes.releaseCountdown(held.id, now, (wake) => recordHeldWake(services, wake));
        if (released === undefined) {
            continue;
        }
        if (automation === undefined || !resumable(automation)) {
            await forgetHeldWake(services, released.id);
            continue;
        }
        void withdrawApprovalPush(services, held.automationId);
        void runHeldWake(services, automation, released).catch(loggedAs(services, "countdown-released automation run failed", automation.id));
    }
};

// Polls the manifest and fires whatever came due since the last pass; fires run detached, since a turn can outlast many
// polls. Event automations fire from the fire route instead.
// Every pass of a started scheduler also sets one timer for the soonest moment due within a poll (schedule-zone.ts) or
// countdown ending, so a schedule fires on its minute rather than up to a poll late. A turn settling, a land and an
// automation saved nudge a pass at once (boot-schedulers.ts, 2026-10-20): a held wake waiting for no live turn went on
// the next thirty-second pass after the last turn ended, and a schedule saved due inside the current window was armed
// only at the next pass. The interval stays as the backstop for anything those miss.
// What happened while nothing was running is the start's to settle (`catchUp`): a host or platform outage can miss even
// a promised alarm. Each schedule that missed a moment fires ONCE, however many it missed, late and saying so, through
// the same gates as any fire: the sessions bar, the guard, an approval hold. A
// schedule asks for its work to be done regularly, not for a backlog to be replayed.
export const createAutomationsScheduler = (services: Services, intervalMs = 30_000): AutomationsScheduler => {
    // Where the first poll's window opens, and so where the catch-up's ends: a moment is one pass's or the other's.
    let since = Date.now();
    let started = false;
    // One pass at a time (nudgedPass): an interval, a timer or a nudge that comes round while the last pass still runs
    // joins it. A second pass would read the manifest before the first had switched a fired one-time wake off, and fire
    // it again; joining loses nothing, since the next pass's window opens where the last one's closed.
    const pass = async (now: number, due: DueAt): Promise<void> => {
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
        await releaseCountdownHolds(services, now, due);
        const next = nextDueAfter(automations, now, sandbox);
        if (next !== undefined) {
            due(next);
        }
    };
    const passes = nudgedPass(pass, { backstopMs: intervalMs, failed: loggedAs(services, "automations pass failed") });

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
        tick: passes.run,
        nudge: passes.nudge,
        start: () => {
            // A second start would settle the same catch-up twice.
            if (started) {
                return;
            }
            started = true;
            void catchUp().catch(loggedAs(services, "automations catch-up failed"));
            passes.start();
        },
        stop: () => {
            started = false;
            passes.stop();
        },
    };
};
