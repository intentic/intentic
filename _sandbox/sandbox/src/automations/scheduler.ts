import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Cron } from "croner";
import type { AgentEvent, AgentOrigin, AgentTurn, AutomationApproval } from "@intentic/sandbox-contract";
import { WORKSPACE_ROOT_EXCLUDE_ENV } from "@intentic/sandbox-contract/chores";
import { REFERENCE_DIR } from "@intentic/workspace-ignore";
import { openTurnTranscript, recordTurnTranscript } from "../sessions/turn-transcript.js";
import type { Services } from "../composition.js";
import { sessionStart, wakeSourceOf } from "../guard/actions.js";
import { guard } from "../guard/guard.js";
import { wrapOutsideContent } from "@intentic/base/outside-text";
import { automationPending } from "../push/notifications.js";
import { threadKey } from "../sessions/thread-sessions.js";
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

// "Wake the agent", streamAgent's shape, INJECTED by every caller rather than imported here. Importing it
// would put this module downstream of agent.routes, which is itself an emitter of the workspace events
// workspace-events.ts turns back into fireAutomation calls: a cycle. Same reason turn-runs takes its TurnFn.
export type WakeFn = (services: Services, input: AgentTurn, signal: AbortSignal | undefined) => AsyncGenerator<AgentEvent>;

/* A live sink for a turn's assistant text. The Discord source backs it with a channel message it edits as token
 * deltas arrive, so a mention reply appears as it's written instead of only when the turn ends. undefined ⇒ no
 * live delivery: the agent sends its own reply (per its provider skill), as before.
 *
 * `failed` is the third frame because a turn that produces NO text is otherwise indistinguishable from a turn
 * that errored, and the two are opposite things to say to whoever is waiting. Every sink used to end on `end`
 * alone, so a Front Desk visitor whose wake died on a revoked credential watched the typing dots disappear and
 * got nothing at all, while the daemon had the provider's exact sentence and wrote it to a row nobody was
 * looking at. It carries the RAW reason: what an audience may be told differs per sink (a stranger on a
 * customer's website and the owner's own Discord channel are not owed the same sentence), so the redaction
 * belongs to each implementation rather than here. Always followed by `end`. */
export interface TurnStream {
    readonly delta: (text: string) => void;
    readonly failed: (reason: string) => void;
    readonly end: () => void;
}

// Prepended to a streamed wake's prompt so the model doesn't ALSO send the reply itself (which would duplicate
// the streamed message). Provider-neutral: the daemon delivers the assistant text; tools are for other actions.
const STREAM_NOTE =
    "Your reply is delivered to the user live as you type it: just answer normally in plain text. Do NOT send it yourself with any tool (no curl/API post of your reply); use provider send tools only to act elsewhere (react, or post to a different channel).";

/* THE SPIN-LOOP GUARD. An automation that fails is normal; one that fails EVERY time is misconfigured, and the
 * scheduler will otherwise keep spending a turn's worth of tokens on it on every tick, nightly, hourly, or
 * once a minute, until a human happens to look at the row.
 *
 * So after `automationFailureLimit` consecutive errors the job is disabled rather than fired again. Disabled,
 * not deleted and not marked broken: `enabled` is the field the user's own toggle writes, so re-enabling it is
 * the switch they already know, and the run history that earned the quarantine stays on the row underneath it.
 *
 * Returns the sentence to put on the run's activity record, or undefined when nothing was quarantined, the
 * guard is off (0), the streak is short, or the automation was edited away underneath this fire. */
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

// Run the guard command in the workspace root; exit 0 ⇒ wake. An event's payload is in AUTOMATION_PAYLOAD so
// guards can filter on it. On failure the stderr/stdout tail becomes the run's detail ("Skipped by guard" in
// the UI). The process env also names the root-only shelf exclusion for scanner-backed guards; guards are
// sandbox scripts, not agent turns.
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

// An automation never overlaps itself, but what happens to the fire that arrives while one is running depends
// on who sent it (see FireOptions.overlap), so the entry is the run in PROGRESS rather than a bare mark: it is
// what a queued fire waits on. A module singleton (like agent-requests' bridge) so the scheduler's tick, the
// listener dispatchers and the /automations/{id}/fire route all share one lock per automation.
const inFlight = new Map<string, Promise<unknown>>();

// A conversation id is a branch name (agent/<id>) and a worktree dir, so it is bounded and charset-checked by
// the contract's ConversationIdSchema, this builds one that satisfies it from the automation's id. Room for
// the "a-" prefix and the suffix is bought out of the automation id, which is the part that repeats.
const AUTOMATION_ID_IN_CONVERSATION = 40;
// Two fires of one automation can't share a millisecond (fires are serialized per automation), but the counter
// costs nothing and makes the id unique per PROCESS regardless of who calls this.
let fireSeq = 0;
export const mintConversationId = (automationId: string, now: number): string =>
    `a-${automationId.slice(0, AUTOMATION_ID_IN_CONVERSATION)}-${now.toString(36)}${(fireSeq++).toString(36)}`;

// Everything a fire needs beyond the automation itself. An options object rather than five positional flags:
// the external dispatchers set a different subset than the tick does, and `payload, wake, false, undefined,
// origin` reads as nothing at all at the call site.
export interface FireOptions {
    // The trigger's payload, appended to the prompt and handed to the guard as AUTOMATION_PAYLOAD.
    readonly payload?: string;
    /* Which of the two pre-wake gates this fire has ALREADY satisfied and so must not put itself through again.
     * One field rather than a flag per gate, because the gates are not independent in practice, every caller
     * that clears the guard has also cleared the approval, and `preApproved, byHand` at a call site reads as
     * neither.
     *
     * "approval", the owner has approved THIS fire: they pressed Run now (the click is the approval, and holding
     *   it in their own queue for their own approval is a queue entry that says nothing), or a restart is
     *   re-firing a wake that was already past the gate and running when the daemon died. The guard still runs,
     *   deliberately: it is the check on whether the work is still wanted, and "skipped by guard" is the single
     *   most useful thing a by-hand fire can report about an automation that appears to do nothing.
     * "both", the approve route replaying a held wake. Its guard ran and passed when the wake was held; running
     *   it a second time would be asking a question already answered. */
    readonly cleared?: "approval" | "both";
    // How many times a boot has already re-fired this wake, carried through the journal so an interrupted fire
    // that dies the same way again is not re-fired forever (see turn-resume's boot pass). A first fire is 0.
    readonly attempts?: number;
    /* Set by the restart path, and by any dispatcher that owns a CONTINUING thread rather than a one-off wake:
     * the Front Desk hands the same id every time a visitor writes, so their whole chat is one conversation,
     * one fleet card, one worktree, one agent that remembers the last message. A first fire mints its own
     * identity after the guard/approval gates clear. */
    readonly conversationId?: string;
    // The provider session that conversation last ran on, resumed so the turn continues rather than restarts.
    // Only meaningful alongside conversationId, and only for a thread that has already completed a turn.
    readonly sessionId?: string;
    // Narrows the wake's toolbox (AgentTurn.allowedTools), the automation's own allowlist, carried in by the
    // dispatcher so the turn a stranger's message drives can be smaller than the one the owner's own is.
    readonly allowedTools?: readonly string[];
    // When set, the agent's text deltas stream here live and it's told (via STREAM_NOTE) not to send the reply itself.
    readonly stream?: TurnStream;
    // Set by dispatchers that receive an OUTSIDE message (listener sources, the web-chat widget, the event
    // webhook). Every fire is a first-class surfaced conversation; origin changes only its placement and
    // provenance. Present ⇒ an isolated worktree conversation. Absent (schedules, chores) ⇒ a shared-workspace
    // conversation.
    readonly origin?: AgentOrigin;
    // The card/tab title for a surfaced wake, the inbound message's first line, which is the only thing that
    // tells two fires of one automation apart (the prompt is identical every time). Absent ⇒ derived below.
    readonly title?: string;
    /* What to do when this automation is ALREADY running. "drop" (the default) suits a trigger that fires again
     * on its own: a cron occurrence or a workspace event landing on top of the previous run is not wanted
     * twice, and the next tick comes round regardless.
     *
     * "queue" is for an inbound MESSAGE, and the difference is that there is no next tick. Somebody is waiting
     * for an answer and the dispatcher holds the only copy of what they said, so a drop loses it outright,
     * a Discord mention that arrived while an unrelated fire of the same automation happened to be running was
     * never answered and never retried, and the channel saw nothing at all. A queued fire waits for the run in
     * progress and then takes its turn, keeping its reply sink open across the wait. */
    readonly overlap?: "drop" | "queue";
}

// What a fire leaves behind for a caller that has to run ANOTHER one on the same conversation: the provider
// session the turn ran on, so the next fire resumes it instead of starting over. Absent whenever no turn ran
// (dropped as overlapping, skipped by the guard, held for approval) or the provider minted no session.
export interface FireOutcome {
    readonly sessionId?: string;
}

/* Fire one automation now, one turn at a time. This half owns only the overlap policy, whether a fire that
 * meets a running one is refused or made to wait, and `runFire` below is the fire itself.
 *
 * Callers run it detached from their tick/request lifecycles; tests await it directly. */
export const fireAutomation = async (services: Services, automation: AutomationRecord, wake: WakeFn, options: FireOptions = {}): Promise<FireOutcome> => {
    const running = inFlight.get(automation.id);
    if (running !== undefined && options.overlap !== "queue") {
        // Dropped as overlapping, which is a REPLY THAT WILL NEVER COME for anyone waiting on the sink, and
        // runFire's finally is never reached from here, so this exit closes the sink itself or nothing does.
        // A QUEUED fire keeps its sink open instead: it is still going to answer, just not yet.
        options.stream?.failed("this automation is already running, so the message was not picked up");
        options.stream?.end();
        return {};
    }
    // The chain IS the lock: each fire runs after the one before it, and a fire that fails still lets the next
    // one start (`.then(job, job)`, the same queue the web-chat route runs its visitor turns through).
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
        // Only the LAST fire in the chain clears the slot. An earlier one finishing must not unlock an
        // automation whose next turn is already queued behind it, that is the overlap this exists to prevent.
        if (inFlight.get(automation.id) === settled) {
            inFlight.delete(automation.id);
        }
    });
    return turn;
};

/* Wait for whatever fire is running for one automation, if any. The tick fires DETACHED, so seeing a run
 * recorded is not the same as the automation being free again: the record is written inside the fire, and the
 * overlap lock only releases once the fire returns. Anything that must fire the same automation a second time
 * and mean it (a test's next tick, a caller driving two fires in a row) awaits this in between, otherwise the
 * second fire lands in that window and is dropped as overlapping. */
export const automationIdle = async (id: string): Promise<void> => {
    await inFlight.get(id);
};

// Guard (payload visible) → wake the agent (payload appended to the prompt) → record the run. Reached only
// through fireAutomation, which guarantees no two runs of one automation are ever inside this at once.
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
        const capped = payload?.slice(0, PAYLOAD_MAX);
        /* ADMISSION, the session.start guard, consulted on EVERY fire including approved replays. A deny
         * refuses even a `cleared` fire (the checks re-run live, so approve-then-tighten does not execute); a
         * hold is what `cleared` satisfies, the owner's click, or the approve route's replay, already answered
         * it. The verdict folds the workspace admission floor and the automation's own requireApproval /
         * holdForSeconds into one decision (guard/actions.ts owns the precedence). */
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
            // Refused by policy is the workspace working as configured, but to whoever is waiting on the
            // sink it is still a reply that never arrives, so it is said rather than left silent.
            stream?.failed(verdict.reason);
            return {};
        }
        if (cleared !== "both") {
            if (automation.guard !== undefined) {
                const precheck = await runGuard(automation.guard, services.workspace.root, capped);
                if (!precheck.pass) {
                    await services.automations.recordRun(automation.id, {
                        at: Date.now(),
                        outcome: "skipped",
                        ...(precheck.detail !== undefined ? { detail: precheck.detail } : {}),
                    });
                    // A guard saying no is the automation working as configured, but to whoever is waiting on
                    // the sink it is still a reply that never arrives, so it is said rather than left silent.
                    stream?.failed(precheck.detail ?? "this automation's guard skipped the run");
                    return {};
                }
            }
            // Approval gate: hold the wake (payload snapshotted) instead of running. inFlight releases in the
            // finally, so the lock is NOT held while it waits for the owner, the approve route runs it later,
            // or (a countdown hold) the scheduler's own tick does once the countdown passes unanswered.
            if (verdict.effect === "hold" && cleared === undefined) {
                await services.approvals.add({
                    automationId: automation.id,
                    // Only a pure-countdown hold carries autoRunAfterS (guard/actions.ts): "ask me", whether
                    // the automation's own requireApproval or the admission floor, never auto-runs.
                    ...(verdict.autoRunAfterS !== undefined ? { autoRunAt: Date.now() + verdict.autoRunAfterS * 1_000 } : {}),
                    ...(capped !== undefined ? { payload: capped } : {}),
                    // Snapshotted with the payload so the approved run opens the same conversation this fire
                    // would have, an approved Discord mention lands on the board as a Discord agent, not as
                    // an anonymous turn.
                    ...(origin !== undefined ? { origin } : {}),
                    ...(title !== undefined ? { title } : {}),
                    // …and the THREAD it would have continued, for the same reason. A dispatcher that owns a
                    // running conversation (the Front Desk, a Discord channel) resolved it before firing; without
                    // carrying it here the approve route has nothing to resume and mints a fresh one.
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
                // A held wake goes nowhere until the owner acts, and nothing else will tell them, an
                // automation fires precisely when they are not looking. notifyIfAway keeps it quiet if they are.
                void services.pushSender.notifyIfAway(automationPending(automation.id, automation.prompt));
                return {};
            }
        }
        /* This fire is now in flight, written down so a daemon death doesn't erase it. Its TRIGGER inputs, not
         * the resolved turn: a re-fire goes back through this same function (see turn-resume's boot pass), which
         * is what keeps the overlap guard, the run record and the activity append, and re-reads a prompt the
         * owner may have fixed in the meantime. Awaited, unlike the chat-turn journal: nothing is waiting on a
         * response here, and a wake that outlives the write by a millisecond is worth nothing. */
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
        /* The wake's prompt is the automation's configured one plus the context that woke it, which is exactly
         * a chat's opening message, written by the configuration instead of by a person. A LISTENER's payload is
         * a stranger's words (a Discord message, a webchat visitor), so it rides inside the outside-content
         * envelope, wrapped HERE, at the one point every listener provider's payload joins a prompt, and only
         * here: the guard's AUTOMATION_PAYLOAD env, the held snapshot and the journal keep the raw payload, so a
         * guard command parses what arrived and an approved replay wraps freshly on its way back through. A
         * schedule/event/workspace payload is the workspace talking to itself and rides bare. */
        const sealed = automation.trigger.kind === "listener" ? wrapOutsideContent(capped ?? "", { source: automation.trigger.provider }) : capped;
        const body = capped !== undefined && capped !== "" ? `${automation.prompt}\n\n--- Event payload ---\n${sealed}` : automation.prompt;
        let failure: string | undefined;
        let runtimeSessionId: string | undefined;
        // Every fire lands in a CONVERSATION and therefore on a fleet card. Outside messages are isolated so the
        // user can open, follow live, and keep talking in after the wake ends. WHICH conversation is the
        // dispatcher's call: a listener channel and a Front Desk visitor each own one for as long as they stay
        // active (thread-sessions.ts), so a run of messages is one reviewable agent; a schedule or chore wake
        // has no thread and mints a fresh one below. Schedule and chore wakes work in the shared workspace but
        // keep the same registry, transcript and restart lifecycle; placement no longer decides whether a
        // conversation exists.
        const turn: AgentTurn & { conversationId: string } = {
            // STREAM_NOTE is applied here rather than folded into `body`, so it belongs to THIS fire and not to
            // the journal entry above. A re-fire has no live sink to write into, the Discord message the deltas
            // were being edited into died with the daemon, and a wake still told "your reply is delivered live,
            // don't send it yourself" would answer into nothing. Without the note it sends its own reply, which
            // is exactly what an unstreamed wake does.
            prompt: stream !== undefined ? `${STREAM_NOTE}\n\n${body}` : body,
            conversationId,
            /* NOBODY IS AT A COMPOSER FOR THIS ONE, which is what the flag means (AgentTurn.unattended names a
             * Maintenance chore among its examples), and every module downstream already assumed it: the
             * command gate's unattended branch exists so an automation turn gets a refusal instead of a
             * permission card nobody can answer, and the plan/ask tools are withheld for the same reason. The
             * dispatchers simply never said it, so a wake fired at 3am could still park itself on a question.
             *
             * It also decides what this turn is worth retrieving workspace context for: the pre-turn search is
             * scoped to the opening message of a conversation a PERSON started (turn-plan.ts), and a schedule
             * that mints a fresh conversation on every fire looks exactly like one until the flag says
             * otherwise. Its prompt is the automation's standing brief, whose first 400 characters are a brief
             * about being a brief. */
            unattended: true,
            /* SOMEBODY ELSE'S WORDS STARTED THIS TURN, set for a listener wake only, and named by the provider
             * that carried it. It is the same fact the envelope above states to the model, said once more to
             * the guard layer, which does not depend on the model believing it (guard/turn-taint.ts). A
             * schedule, a workspace event and a webhook are the workspace talking to itself and set nothing. */
            ...(automation.trigger.kind === "listener" ? { outsideWake: automation.trigger.provider } : {}),
            // A continuing thread resumes its provider session, so the agent answers the follow-up rather than
            // meeting the visitor again. Absent on a first turn and on every one-off wake.
            ...(resumedSessionId !== undefined ? { sessionId: resumedSessionId } : {}),
            ...(allowedTools !== undefined ? { allowedTools: [...allowedTools] } : {}),
            ...(origin !== undefined
                ? {
                      isolated: true,
                      origin,
                      title: (title ?? `${origin.provider}: ${automation.id}`).slice(0, TITLE_MAX),
                  }
                : {}),
            ...(automation.agent !== undefined ? { agent: automation.agent } : {}),
            // The pinned account, when the owner chose one. Absent leaves the resolution where it was, the
            // provider's first account, so an automation nobody configured keeps behaving as it always has.
            ...(automation.account !== undefined ? { account: automation.account } : {}),
            /* The persona this wake shows the outside world, and, unlike `account` on the line above, absence here
             * is a DECISION rather than a deferral. `unattended: true` is already set, which means the resolver
             * (personas/personas.ts) reads a missing persona as "no logged-in account at all" rather than
             * "all of them". So an automation the owner never pinned cannot post as anybody, and one they did
             * pin reaches exactly the accounts on that card.
             *
             * Spread the same way as the rest for consistency, though the absent case is what carries the
             * meaning: what makes the default strict is the resolver, not this line. */
            ...(automation.actsAs !== undefined ? { actsAs: automation.actsAs } : {}),
            ...(automation.harness !== undefined ? { harness: automation.harness } : {}),
            ...(automation.model !== undefined ? { model: automation.model } : {}),
        };
        const events: AgentEvent[] = [];
        // When this wake's turn began, the stamp its recorded message carries, taken here rather than at the
        // append below, which on a long turn runs many minutes later (see RestoredMessage.sentAt).
        const startedAt = Date.now();
        // Opened before the provider runs, like every other conversation turn. A first fire has nothing to adopt;
        // a RE-fire reuses its interrupted run's id, so its record is already open and this is a no-op.
        await openTurnTranscript(services, turn);
        try {
            for await (const event of wake(services, turn, undefined)) {
                events.push(event);
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
            await recordTurnTranscript(services, turn, events, startedAt);
        }
        /* Tell the sink the turn is not going to answer, BEFORE the finally closes it. The daemon has always
         * known this, it is on the run record below and in the activity feed, and used to keep it: a wake
         * that died on a revoked credential closed the stream with no text, which every audience reads as the
         * agent having nothing to say. The raw reason goes out; each sink decides what its audience is told. */
        if (failure !== undefined) {
            stream?.failed(failure);
        }
        // The stable conversation rides onto the run record, which makes every wake that reached a turn
        // openable from its row, even when the provider never minted a runtime session.
        await services.automations.recordRun(automation.id, {
            at: Date.now(),
            ...(failure === undefined ? { outcome: "completed" as const } : { outcome: "error" as const, detail: failure }),
            conversationId,
        });
        // Read AFTER recording so this fire's own outcome is part of the streak the guard weighs.
        const quarantined = failure === undefined ? undefined : await quarantineIfSpinning(services, automation.id);
        // The runtime session is the activity feed's join key between an inbound trigger and the outbound calls its
        // wake produced (the sniffer stamps the same id on them).
        void services.activity
            .append({
                direction: "system",
                type: "automation.run",
                automationIds: [automation.id],
                ...(automation.trigger.kind === "listener" ? { provider: automation.trigger.provider } : {}),
                ...(runtimeSessionId !== undefined ? { sessionId: runtimeSessionId } : {}),
                outcome: failure === undefined ? "ok" : "error",
                // The quarantine rides the run's own activity row rather than a second event: it is the reason
                // this fire was the last one, and the feed is where someone asks why an automation went quiet.
                ...(failure !== undefined ? { error: quarantined === undefined ? failure : `${failure}\n\n${quarantined}` } : {}),
            })
            .catch((error: unknown) => services.logger.warn({ err: error }, "activity append failed"));
        // Handed back so a dispatcher owning a continuing thread (the Front Desk) can resume this exact session
        // on the visitor's next message. Everyone else ignores it.
        return runtimeSessionId !== undefined ? { sessionId: runtimeSessionId } : {};
    } finally {
        // Flush the final buffered text (the deltas after the last rate-limited edit). No-op if nothing streamed.
        stream?.end();
        // No longer in flight, by whatever road it left: a completed wake, a failed one, a guard that skipped it
        // (which never journalled) and a thrown one all reached a state the row can show. Only the fire that got
        // no chance to reach one leaves its entry behind, which is the whole signal the boot pass reads.
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

/* Run a wake the approvals queue was holding, with everything the hold snapshotted: `cleared: "both"` (its
 * guard ran when it was held, and whoever calls this holds the release, the owner's click or a countdown
 * that ran out), and the thread it belonged to settled afterwards so the next message resumes the same
 * conversation. One function because there are now two releases, the approve route and the scheduler's
 * countdown scan, and the thread-settling half is exactly the part a second copy would forget. */
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

// Polls the automations manifest and fires whatever came due since the last pass, so edits are picked up with
// no resync bookkeeping. Fires run detached from the tick (an agent turn can outlast many polls). Event-kind
// automations don't tick; they fire from the /automations/{id}/fire route.
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
        /* Countdown holds whose deadline passed unanswered, silence is consent (holdForSeconds), but only
         * while no turn is live: the wake edits the tree, and the countdown's whole point is not starting
         * work under someone. A busy fleet just leaves the hold for a later tick; the row keeps showing it.
         * The entry is removed BEFORE the run so a wake that fails cannot re-fire on every tick, and an
         * automation deleted or disabled while its countdown ran is read as the cancel it is. */
        for (const held of await services.approvals.list()) {
            if (held.autoRunAt === undefined || held.autoRunAt > now || services.agents.liveSessionIds().length > 0) {
                continue;
            }
            const automation = await services.automations.get(held.automationId);
            await services.approvals.remove(held.id);
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
