import type { Capability } from "@intentic/sandbox-contract";
import { streamAgent } from "../agent/agent.routes.js";
import type { Services } from "../composition.js";
import type { AutomationRecord } from "./automations-store.js";
import { fireAutomation, PAYLOAD_MAX, type TurnStream, type WakeFn } from "./scheduler.js";

// Realtime agent wake-ups: provider sources hold a live connection (e.g. the Discord gateway) and dispatch
// normalized messages here; `listener`-kind automations fire from them through the same guard/wake/run-history
// path as schedule and event automations. The reconciler below connects/disconnects each source on a poll
// tick, so the daemon holds a provider connection ONLY while an enabled listener automation and the
// provider's capability both exist.

// How long a quiet gap ends a burst — rapid-fire messages batch into one wake. The timer restarts on
// every message, so bursts still coalesce; a lone mention just stops paying dead time before it fires.
// ponytail: 750ms floor tuned for snappy single mentions; raise if real bursts start firing mid-typing.
export const DEBOUNCE_MS = 750;
// A fatal source failure (bad credential, missing portal intent) pauses reconnects this long. Not sticky
// forever: a portal-side fix (e.g. enabling an intent) doesn't change the token, so it must heal unattended.
export const FATAL_RETRY_MS = 300_000;

// One normalized inbound event — serialized as a JSON line in the automation's payload.
export interface ListenerMessage {
    provider: "discord";
    type: "message" | "voice_utterance" | "voice_transcript";
    id: string;
    channelId: string;
    author: { id: string; name: string };
    content: string;
    // Discord message: it @mentions one of our bots or replies to a bot's message. Voice events never set it.
    mentioned?: boolean;
    // Prior channel messages (chronological) fetched when a bot is tagged, so the agent can reason about why.
    // Kept a top-level field (not in `extra`) so it reaches the model's payload but stays out of the activity
    // feed, which logs only content/extra.
    history?: Array<{ author: { id: string; name: string }; content: string; timestamp: string; self?: boolean }>;
    timestamp: string;
    // Provider-specific fields (discord message: guildId, attachments; voice_utterance: path;
    // voice_transcript: path, participants, durationSeconds).
    extra?: Record<string, unknown>;
}

// What the reconciler hands a source each tick: the enabled listener automations for ITS provider plus the
// full capability manifest (the source extracts its own credential).
export interface ListenerState {
    readonly automations: AutomationRecord[];
    readonly capabilities: Capability[];
}

// A provider's realtime connection. `ensure` reconciles desired-vs-actual (connect, disconnect, resubscribe)
// and must be idempotent; the source dispatches events via dispatchListenerMessage and reports fatal
// credential failures via reportListenerFailure.
export interface ListenerSource {
    readonly provider: ListenerMessage["provider"];
    readonly ensure: (state: ListenerState) => Promise<void>;
    readonly stop: () => void;
}

export interface MessageBatcher {
    readonly push: (line: string, stream?: TurnStream) => void;
}

// Batches payload lines into one wake. fireAutomation's inFlight set DROPS concurrent fires, so naive
// per-message fires would silently lose messages arriving while the agent runs — this serializes instead:
// a burst debounces into one fire, and lines arriving mid-run accumulate and fire once more when it finishes
// (no debounce on the follow-up; they waited long enough).
export const createMessageBatcher = (
    fire: (payload: string, stream?: TurnStream) => Promise<void>,
    onError: (error: unknown) => void,
    debounceMs = DEBOUNCE_MS,
): MessageBatcher => {
    let pending: string[] = [];
    // The live reply sink for the next fire — the most recent mention in the batch wins (a burst spanning
    // channels streams to the latest; rare enough not to dedup). undefined ⇒ this batch has no streamed reply.
    let pendingStream: TurnStream | undefined;
    let running = false;
    let timer: NodeJS.Timeout | undefined;
    const flush = async (): Promise<void> => {
        if (running || pending.length === 0) {
            return;
        }
        running = true;
        const batch = pending;
        const stream = pendingStream;
        pending = [];
        pendingStream = undefined;
        try {
            await fire(joinNewestWithin(batch, PAYLOAD_MAX), stream);
        } catch (error) {
            onError(error);
        } finally {
            running = false;
            void flush();
        }
    };
    return {
        push: (line, stream) => {
            pending.push(line);
            if (stream !== undefined) {
                pendingStream = stream;
            }
            clearTimeout(timer);
            timer = setTimeout(() => void flush(), debounceMs);
        },
    };
};

// Newest lines that fit the payload cap, oldest dropped whole — fireAutomation's raw slice would cut mid-JSON.
const joinNewestWithin = (lines: string[], max: number): string => {
    const kept: string[] = [];
    let total = 0;
    for (let i = lines.length - 1; i >= 0 && total + (lines[i] as string).length + 1 <= max; i -= 1) {
        kept.unshift(lines[i] as string);
        total += (lines[i] as string).length + 1;
    }
    return kept.length > 0 ? kept.join("\n") : (lines.at(-1) as string).slice(0, max);
};

// Per-automation queues. A module singleton (like scheduler's inFlight) so every dispatcher — a source's
// event handler, a voice session's end — shares the same serialization.
const batchers = new Map<string, MessageBatcher>();

// Route one event to every matching enabled listener automation's batcher. Matching re-reads the manifest so
// an edit/disable/delete is honored immediately; the batcher's fire re-reads once more at wake time.
export const dispatchListenerMessage = async (
    services: Services,
    message: ListenerMessage,
    wake: WakeFn = streamAgent,
    debounceMs = DEBOUNCE_MS,
    // Builds a fresh live reply sink for this message when the source wants the turn streamed back (e.g. a Discord
    // mention → a channel message edited as the model types). Called per matched automation so each streams its own
    // reply. undefined / returns undefined ⇒ the agent sends its own reply as before.
    makeStream?: () => TurnStream | undefined,
): Promise<void> => {
    const line = JSON.stringify(message);
    const matched: string[] = [];
    for (const automation of await services.automations.list()) {
        const trigger = automation.trigger;
        if (!automation.enabled || trigger.kind !== "listener" || trigger.provider !== message.provider) {
            continue;
        }
        if (trigger.channelId !== undefined && trigger.channelId !== message.channelId) {
            continue;
        }
        if (trigger.eventType !== undefined && trigger.eventType !== message.type) {
            continue;
        }
        if (trigger.mentioned === true && message.mentioned !== true) {
            continue;
        }
        let batcher = batchers.get(automation.id);
        if (batcher === undefined) {
            const id = automation.id;
            batcher = createMessageBatcher(
                async (payload, stream) => {
                    const fresh = await services.automations.get(id);
                    if (fresh === undefined || !fresh.enabled || fresh.trigger.kind !== "listener") {
                        return;
                    }
                    await fireAutomation(services, fresh, payload, wake, false, stream);
                },
                (error) => {
                    services.logger.error({ err: error, automation: id }, "automation run failed");
                    void services.activity
                        .append({
                            provider: message.provider,
                            direction: "system",
                            type: "dispatch.failed",
                            automationIds: [id],
                            outcome: "error",
                            error: String(error),
                        })
                        .catch((appendError: unknown) => services.logger.warn({ err: appendError }, "activity append failed"));
                },
                debounceMs,
            );
            batchers.set(automation.id, batcher);
        }
        batcher.push(line, makeStream?.());
        matched.push(automation.id);
    }
    // Only messages that actually woke an automation land in the activity log — the gateway sees every channel
    // message, and logging them all would be surveillance, not an activity feed.
    if (matched.length > 0) {
        void services.activity
            .append({
                provider: message.provider,
                direction: "in",
                type: `${message.type}.received`,
                channelId: message.channelId,
                author: message.author.name,
                content: message.content,
                automationIds: matched,
                ...(message.extra !== undefined ? { extra: message.extra } : {}),
            })
            .catch((error: unknown) => services.logger.warn({ err: error }, "activity append failed"));
    }
};

// Surface a fatal source failure where the user already looks: an error run on each of the provider's
// listener automations (the row's run history in the UI) — plus one system event in the activity feed, which
// is also where the /activity/status probe reads lastError from.
export const reportListenerFailure = async (services: Services, provider: ListenerMessage["provider"], detail: string): Promise<void> => {
    void services.activity
        .append({ provider, direction: "system", type: "gateway.login_failed", outcome: "error", error: detail })
        .catch((error: unknown) => services.logger.warn({ err: error }, "activity append failed"));
    for (const automation of await services.automations.list()) {
        if (!automation.enabled || automation.trigger.kind !== "listener" || automation.trigger.provider !== provider) {
            continue;
        }
        await services.automations.recordRun(automation.id, { at: Date.now(), outcome: "error", detail });
    }
};

export interface Listeners {
    readonly start: () => void;
    readonly stop: () => void;
    // One reconcile pass over every source; `start` runs it on an interval. Exposed for tests.
    readonly ensure: () => Promise<void>;
}

// Reconciles each source's connection against the manifest on a poll tick (the scheduler's shape) — creating
// an automation or saving a capability takes effect within a tick, with zero notification wiring. The tick
// cadence also serves as reconnect backoff after a non-fatal connection drop.
export const createListeners = (services: Services, sources: readonly ListenerSource[], intervalMs = 30_000): Listeners => {
    let timer: NodeJS.Timeout | undefined;

    const ensure = async (): Promise<void> => {
        const [automations, capabilities] = await Promise.all([services.automations.list(), services.capabilities.list()]);
        for (const source of sources) {
            const routed = automations.filter(
                (automation) => automation.enabled && automation.trigger.kind === "listener" && automation.trigger.provider === source.provider,
            );
            await source
                .ensure({ automations: routed, capabilities })
                .catch((error: unknown) => services.logger.error({ err: error, provider: source.provider }, "listener reconcile failed"));
        }
    };

    return {
        ensure,
        start: () => {
            void ensure();
            timer = setInterval(() => void ensure(), intervalMs);
        },
        stop: () => {
            clearInterval(timer);
            for (const source of sources) {
                source.stop();
            }
        },
    };
};
