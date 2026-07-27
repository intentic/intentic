import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Cron } from "croner";
import type { AgentEvent, AgentOrigin, AgentTurn } from "@intentic/sandbox-contract";
import type { Services } from "../composition.js";
import { automationPending } from "../push/notifications.js";
import type { AutomationRecord } from "./automations-store.js";

const execFileAsync = promisify(execFile);

// How long a guard command may run before it counts as failed (skipping the wake).
const GUARD_TIMEOUT_MS = 60_000;
// How much guard output survives into the run's detail.
const GUARD_DETAIL_TAIL = 500;
// How much of an event's webhook body reaches the guard's env and the wake prompt.
export const PAYLOAD_MAX = 64_000;
// The contract's cap on AgentTurn.title — a surfaced wake's title is built from a message, so it's clamped here.
export const TITLE_MAX = 80;

// "Wake the agent" — streamAgent's shape, INJECTED by every caller rather than imported here. Importing it
// would put this module downstream of agent.routes, which is itself an emitter of the workspace events
// workspace-events.ts turns back into fireAutomation calls: a cycle. Same reason turn-runs takes its TurnFn.
export type WakeFn = (services: Services, input: AgentTurn, signal: AbortSignal | undefined) => AsyncGenerator<AgentEvent>;

// A live sink for a turn's assistant text. The Discord source backs it with a channel message it edits as token
// deltas arrive, so a mention reply appears as it's written instead of only when the turn ends. undefined ⇒ no
// live delivery: the agent sends its own reply (per its provider skill), as before.
export interface TurnStream {
    readonly delta: (text: string) => void;
    readonly end: () => void;
}

// Prepended to a streamed wake's prompt so the model doesn't ALSO send the reply itself (which would duplicate
// the streamed message). Provider-neutral: the daemon delivers the assistant text; tools are for other actions.
const STREAM_NOTE =
    "Your reply is delivered to the user live as you type it — just answer normally in plain text. Do NOT send it yourself with any tool (no curl/API post of your reply); use provider send tools only to act elsewhere (react, or post to a different channel).";

// Run the guard command in the workspace root; exit 0 ⇒ wake. An event's payload is in AUTOMATION_PAYLOAD so
// guards can filter on it. On failure the stderr/stdout tail becomes the run's detail ("Skipped by guard" in
// the UI). Plain process env otherwise — guards are sandbox scripts, not agent turns.
const runGuard = async (command: string, cwd: string, payload: string | undefined): Promise<{ pass: boolean; detail?: string }> => {
    try {
        await execFileAsync("sh", ["-c", command], {
            cwd,
            timeout: GUARD_TIMEOUT_MS,
            env: { ...process.env, ...(payload !== undefined ? { AUTOMATION_PAYLOAD: payload } : {}) },
        });
        return { pass: true };
    } catch (error) {
        const { stdout, stderr } = error as { stdout?: string; stderr?: string };
        const detail = `${stderr ?? ""}${stdout ?? ""}`.trim().slice(-GUARD_DETAIL_TAIL);
        return { pass: false, ...(detail !== "" ? { detail } : {}) };
    }
};

// An automation never overlaps itself — cron occurrences or webhook events that arrive while its previous run
// is still going are dropped, not queued. A module singleton (like agent-requests' bridge) so the scheduler's
// tick and the /automations/{id}/fire route share it.
const inFlight = new Set<string>();

// A conversation id is a branch name (agent/<id>) and a worktree dir, so it is bounded and charset-checked by
// the contract's ConversationIdSchema — this builds one that satisfies it from the automation's id. Room for
// the "a-" prefix and the suffix is bought out of the automation id, which is the part that repeats.
const AUTOMATION_ID_IN_CONVERSATION = 40;
// Two fires of one automation can't share a millisecond (fires are serialized per automation), but the counter
// costs nothing and makes the id unique per PROCESS regardless of who calls this.
let fireSeq = 0;
const mintConversationId = (automationId: string, now: number): string =>
    `a-${automationId.slice(0, AUTOMATION_ID_IN_CONVERSATION)}-${now.toString(36)}${(fireSeq++).toString(36)}`;

// Everything a fire needs beyond the automation itself. An options object rather than five positional flags:
// the external dispatchers set a different subset than the tick does, and `payload, wake, false, undefined,
// origin` reads as nothing at all at the call site.
export interface FireOptions {
    // The trigger's payload — appended to the prompt and handed to the guard as AUTOMATION_PAYLOAD.
    readonly payload?: string;
    // Set by the approve route: the owner already approved a held wake, so skip the guard + approval gate and run.
    readonly preApproved?: boolean;
    // When set, the agent's text deltas stream here live and it's told (via STREAM_NOTE) not to send the reply itself.
    readonly stream?: TurnStream;
    // Set by the dispatchers that receive an OUTSIDE message (listener sources, the web-chat widget, the event
    // webhook). Its presence is what makes the wake a first-class conversation instead of an anonymous headless
    // turn: it gets its own conversation id, its own worktree, a fleet card, and a chat tab the user can take
    // over in — the wake is the conversation's first turn, with the automation's configured prompt and the
    // message as its context. Absent (schedules, chores) ⇒ the main-tree headless turn, as before.
    readonly origin?: AgentOrigin;
    // The card/tab title for a surfaced wake — the inbound message's first line, which is the only thing that
    // tells two fires of one automation apart (the prompt is identical every time). Absent ⇒ derived below.
    readonly title?: string;
}

// Fire one automation now: guard (payload visible) → wake the agent (payload appended to the prompt) → record
// the run. Callers run it detached from their tick/request lifecycles; tests await it directly.
export const fireAutomation = async (
    services: Services,
    automation: AutomationRecord,
    wake: WakeFn,
    { payload, preApproved = false, stream, origin, title }: FireOptions = {},
): Promise<void> => {
    if (inFlight.has(automation.id)) {
        return;
    }
    inFlight.add(automation.id);
    try {
        const capped = payload?.slice(0, PAYLOAD_MAX);
        if (!preApproved) {
            if (automation.guard !== undefined) {
                const guard = await runGuard(automation.guard, services.workspace.root, capped);
                if (!guard.pass) {
                    await services.automations.recordRun(automation.id, {
                        at: Date.now(),
                        outcome: "skipped",
                        ...(guard.detail !== undefined ? { detail: guard.detail } : {}),
                    });
                    return;
                }
            }
            // Approval gate: hold the wake (payload snapshotted) instead of running. inFlight releases in the
            // finally, so the lock is NOT held while it waits for the owner — the approve route runs it later.
            if (automation.requireApproval === true) {
                await services.approvals.add({
                    automationId: automation.id,
                    ...(capped !== undefined ? { payload: capped } : {}),
                    // Snapshotted with the payload so the approved run opens the same conversation this fire
                    // would have — an approved Discord mention lands on the board as a Discord agent, not as
                    // an anonymous turn.
                    ...(origin !== undefined ? { origin } : {}),
                    ...(title !== undefined ? { title } : {}),
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
                // A held wake goes nowhere until the owner acts, and nothing else will tell them — an
                // automation fires precisely when they are not looking. notifyIfAway keeps it quiet if they are.
                void services.pushSender.notifyIfAway(automationPending(automation.id, automation.prompt));
                return;
            }
        }
        // The wake's prompt is the automation's configured one plus the outside context that woke it — which is
        // exactly a chat's opening message, written by the configuration instead of by a person.
        const body = capped !== undefined && capped !== "" ? `${automation.prompt}\n\n--- Event payload ---\n${capped}` : automation.prompt;
        const prompt = stream !== undefined ? `${STREAM_NOTE}\n\n${body}` : body;
        let failure: string | undefined;
        let sessionId: string | undefined;
        // An outside message opens a CONVERSATION: its own id, its own worktree, a card on the fleet and a tab
        // the user can open, follow live, and keep talking in after the wake ends. One per FIRE, not per channel
        // — each mention is its own agent with its own branch, which is what makes two of them reviewable
        // separately. (Fires of one automation are still serialized by inFlight and the listener batcher; the
        // worktree keeps them from colliding in the tree, the queue keeps a flood from becoming N turns of
        // spend.) A schedule or chore wake stays a headless main-tree turn — its transcript still lands in the
        // workspace sessions like a chat turn.
        const turn: AgentTurn = {
            prompt,
            ...(origin !== undefined
                ? {
                      conversationId: mintConversationId(automation.id, Date.now()),
                      isolated: true,
                      origin,
                      title: (title ?? `${origin.provider}: ${automation.id}`).slice(0, TITLE_MAX),
                  }
                : {}),
            ...(automation.agent !== undefined ? { agent: automation.agent } : {}),
            ...(automation.harness !== undefined ? { harness: automation.harness } : {}),
            ...(automation.model !== undefined ? { model: automation.model } : {}),
        };
        for await (const event of wake(services, turn, undefined)) {
            if (event.kind === "session") {
                sessionId = event.sessionId;
            }
            if (event.kind === "error") {
                failure = event.message;
            }
            if (event.kind === "delta") {
                stream?.delta(event.text);
            }
        }
        await services.automations.recordRun(
            automation.id,
            failure === undefined ? { at: Date.now(), outcome: "completed" } : { at: Date.now(), outcome: "error", detail: failure },
        );
        // sessionId is the activity feed's join key between an inbound trigger and the outbound calls its
        // wake produced (the sniffer stamps the same id on them).
        void services.activity
            .append({
                direction: "system",
                type: "automation.run",
                automationIds: [automation.id],
                ...(automation.trigger.kind === "listener" ? { provider: automation.trigger.provider } : {}),
                ...(sessionId !== undefined ? { sessionId } : {}),
                outcome: failure === undefined ? "ok" : "error",
                ...(failure !== undefined ? { error: failure } : {}),
            })
            .catch((error: unknown) => services.logger.warn({ err: error }, "activity append failed"));
    } finally {
        // Flush the final buffered text (the deltas after the last rate-limited edit). No-op if nothing streamed.
        stream?.end();
        inFlight.delete(automation.id);
    }
};

export interface AutomationsScheduler {
    readonly start: () => void;
    readonly stop: () => void;
    // One poll pass over the manifest; `start` runs it on an interval. Exposed for tests.
    readonly tick: (now?: number) => Promise<void>;
}

// Polls the automations manifest and fires whatever came due since the last pass — so edits are picked up with
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
    };

    return {
        tick,
        start: () => {
            timer = setInterval(() => void tick(), intervalMs);
        },
        stop: () => clearInterval(timer),
    };
};
