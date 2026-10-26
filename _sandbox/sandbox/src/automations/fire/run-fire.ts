import { type ServiceStanding, serviceStanding } from "../../access/service-standing.js";
import type { AgentEvent } from "@intentic/sandbox-contract/events/agent-events";
import type { AgentTurn, ModelPin } from "@intentic/sandbox-contract/schemas/agent";
import type { AutomationApproval, Trigger } from "@intentic/sandbox-contract/schemas/automations";
import { capabilitiesOf } from "@intentic/sandbox-contract/models/agent-catalog";
import type { Services } from "../../composition.js";
import { sessionStart, wakeSourceOf } from "../../guard/actions.js";
import { guard } from "../../guard/guard.js";
import { wrapOutsideContent } from "@intentic/base/outside-text";
import { automationPending, turnFinished } from "../../push/notifications.js";
import { pinnedRunModel } from "../../agent/models/run-role-model.js";
import { sessionFor } from "../../conversations/registry/routing.js";
import { type AutomationRecord, consecutiveFailures } from "../automations-store.js";
import { opt } from "../../opt.js";
import { TITLE_MAX } from "../../seams/conversation-title.js";
import { continueConversation, endedInstead, notifyOwner, outsideWakeOf, type TargetOutcome } from "../watch/fire-targets.js";
import { conditionOutside } from "../watch/watch-condition.js";
import { checkFireCondition, clearJournalled, journalledFire } from "../durable/fire-admission.js";
import { type TurnProgressReader, turnProgressReader } from "../../extensions/listener/listener-progress.js";
import { conversationLink } from "../../system/boot/open-in-app.js";
import type { TurnInput } from "../../seams/turn-starter.js";
import { refusalOf, type WakeRefusal, wakeEnding, wakePostures } from "../wake/wake-fallback.js";
import { mintConversationId, ownOrigin, sessionsGate } from "./fire-sessions.js";
import type { TurnStream, FireOptions, FireOutcome } from "./fire-options.js";

// The automation's allowlist as it stands now, falling back to the record the fire was handed when it is gone.
const currentAllowedTools = async (services: Pick<Services, "automations">, automation: AutomationRecord): Promise<readonly string[] | undefined> =>
    (await services.automations.get(automation.id))?.allowedTools ?? automation.allowedTools;

// How much of an event's webhook body reaches the guard's env and the wake prompt.
export const PAYLOAD_MAX = 64_000;

// What the channel hears while its wake waits for a person, and while it waits behind another turn of its automation.
export const HELD_NOTICE = "This needs the owner's approval before I start on it; the answer comes here once they approve it.";

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
    fire: Pick<AutomationApproval, "payload" | "observed" | "origin" | "title" | "conversationId" | "sessionId" | "thread" | "actsAs" | "runAs">,
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
    ...opt("runAs", fire.runAs),
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

// The service a fire acts as, standing; or `skipped`, recorded with why, when it can no longer act (its steward left, it
// or its profile is gone), before any check, hold or model is spent on a run that would reach nothing
// (docs/architecture/access.md). Undefined for a fire that acts for the owner, as one naming no service does.
const standingOrSkip = async (
    services: Services,
    automationId: string,
    runAs: string | undefined,
    stream: TurnStream | undefined,
): Promise<Extract<ServiceStanding, { ok: true }> | "skipped" | undefined> => {
    if (runAs === undefined) {
        return undefined;
    }
    const standing = await serviceStanding(services, runAs);
    if (standing.ok) {
        return standing;
    }
    await services.automations.recordRun(automationId, { at: Date.now(), outcome: "skipped", detail: standing.reason });
    stream?.failed(standing.reason);
    return "skipped";
};

// Guard, then wake, then record the run; reached only through fireAutomation, which guarantees no two runs on one
// conversation overlap here, and none at all of an automation whose fire runs alone (FireLanes).
export const runFire = async (
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
        // The persona this fire wears and the service it acts as: the sender's lane when someone sent it, else the
        // automation's own. Resolved once here so the hold snapshot and the turn cannot disagree.
        const { actsAs, runAs } = lane ?? automation;
        const standing = await standingOrSkip(services, automation.id, runAs, stream);
        if (standing === "skipped") {
            return {};
        }
        // Admission runs on every fire, even cleared: a deny still refuses; a hold is what `cleared` already answered.
        // A lane's hold only ever adds to the automation's, most-restrictive-wins like the floor.
        const { admission } = await services.sandboxSettings.get();
        const requireApproval = automation.requireApproval === true || lane?.requireApproval === true;
        const verdict = guard(sessionStart, {
            source: wakeSourceOf(automation.trigger),
            admission,
            ...(requireApproval ? { requireApproval } : {}),
            ...opt("holdForSeconds", automation.holdForSeconds),
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
                        runAs,
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
                : { origin: ownOrigin(automation) }),
            // Resolved rung spread verbatim, not through turn-resume's fill step, since this turn walked its ladder.
            ...pinFields(pin),
            ...opt("account", account),
            // Absence here is deliberate: the resolver reads no pin as no account on an unattended turn, not all.
            ...(actsAs !== undefined ? { actsAs } : {}),
            // Who the turn acts for, and the fence it is born inside: the service's steward held to its profile.
            ...opt("runAs", runAs),
            ...opt("areas", standing?.areas),
            // Nobody presses Send again on a wake: it answers a spent allowance or a stop itself (wake-fallback.ts).
            postures: wakePostures((await services.sandboxSettings.get()).limitPolicy),
        };
        // The detached run every daemon-started turn takes (a loop's iteration, a spawned child): held by the
        // conversation, so a window opening it attaches to the live rows instead of waiting on a record written only
        // at the end, then opened, folded and recorded by the run itself. Unjournalled: the fire journal above is what
        // a restart re-fires from, and a turn entry beside it could resume the same wake twice.
        const run = services.turns.run(turn);
        if (run === "busy" || run === "archived") {
            failure = run === "busy" ? "A turn was already running on this conversation." : "The conversation is archived, and only a person reopens it.";
            services.logger.warn({ automation: automation.id, conversationId, refused: run }, "automation turn not started");
        } else {
            announceOpened(services, stream, conversationId);
            const progress = turnProgressReader();
            // Every frame from the first (taken before the run's first await), ending once the turn is on the record.
            for await (const event of run.frames()) {
                if (event.kind === "session") {
                    runtimeSessionId = event.sessionId;
                }
                if (event.kind === "error") {
                    failure = event.message;
                    refusal = refusalOf(event);
                }
                tellStream(stream, progress, event);
            }
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
