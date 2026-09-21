import type { AgentOrigin, ListenerMessage, Trigger } from "@intentic/sandbox-contract";
import { streamAgent } from "../agent/routes/agent.routes.js";
import type { Services } from "../composition.js";
import { CHANNEL_SESSION_TTL_MS, threadKey } from "../sessions/thread-sessions.js";
import { fireAutomation, mintConversationId, PAYLOAD_MAX, TITLE_MAX, type TurnStream, type WakeFn } from "./scheduler.js";
import { type SenderLane, senderLane } from "./senders.js";

// Provider sources hold a live connection (Discord gateway) and dispatch normalized messages here; listener automations
// fire through the same guard/wake/run-history path as schedule and event automations.
// The daemon holds a provider connection only while an enabled listener automation and its capability both exist; the
// reconciler connects/disconnects on a poll tick.
// A channel is a thread (sessions/thread-sessions.ts): messages resume the same conversation and session until quiet
// past CHANNEL_SESSION_TTL_MS, then start fresh. Who sent the message picks its lane (senders.ts): the persona the
// wake wears and whether a person releases it. Batches and threads are keyed by lane as well as channel, so a burst
// from two people the automation answers as different agents becomes two wakes, never one.

// Quiet gap that ends a burst; the timer restarts on every message so a burst keeps coalescing into one wake.
export const DEBOUNCE_MS = 750;

// What a triggering message contributes to the conversation it opens or resumes: origin, board title, thread key, and
// the live reply sink when the source streams back.
export interface MessageContext {
    readonly origin: AgentOrigin;
    readonly title: string;
    // Thread-sessions key for this message's channel and lane, computed at push time; a batch's key is its newest
    // message's, which is the same key since the batcher itself is keyed by lane.
    readonly thread: string;
    // What the sender's rule decided; every message in a batch shares one, by construction of the batcher key.
    readonly lane: SenderLane;
    readonly stream?: TurnStream;
}

export interface MessageBatcher {
    readonly push: (line: string, context: MessageContext) => void;
}

// Batches lines into one wake per debounce window; lines arriving mid-run accumulate and fire once more, immediately,
// when it finishes.
// A fire already running elsewhere is queued rather than dropped, by the fire itself.
export const createMessageBatcher = (
    fire: (payload: string, context: MessageContext) => Promise<void>,
    onError: (error: unknown) => void,
    debounceMs = DEBOUNCE_MS,
): MessageBatcher => {
    let pending: string[] = [];
    // Context for the next fire; the newest message in the batch wins. Undefined means nothing is batched.
    let pendingContext: MessageContext | undefined;
    let running = false;
    let timer: NodeJS.Timeout | undefined;
    const flush = async (): Promise<void> => {
        if (running || pending.length === 0 || pendingContext === undefined) {
            return;
        }
        running = true;
        const batch = pending;
        const context = pendingContext;
        pending = [];
        pendingContext = undefined;
        try {
            await fire(joinNewestWithin(batch, PAYLOAD_MAX), context);
        } catch (error) {
            onError(error);
        } finally {
            running = false;
            void flush();
        }
    };
    return {
        push: (line, context) => {
            pending.push(line);
            const carried = pendingContext?.stream;
            if (context.stream !== undefined) {
                // Ends the superseded sink so its held-open response isn't left hanging on a stream that won't fire.
                carried?.end();
            }
            // Reply sink carries from the newest message with one; a follow-up can't drop an earlier held-open
            // response.
            pendingContext = context.stream === undefined && carried !== undefined ? { ...context, stream: carried } : context;
            clearTimeout(timer);
            timer = setTimeout(() => void flush(), debounceMs);
        },
    };
};

// Newest lines that fit the payload cap, oldest dropped whole, fireAutomation's raw slice would cut mid-JSON.
const joinNewestWithin = (lines: string[], max: number): string => {
    const kept: string[] = [];
    let total = 0;
    for (let i = lines.length - 1; i >= 0 && total + (lines[i] as string).length + 1 <= max; i -= 1) {
        kept.unshift(lines[i] as string);
        total += (lines[i] as string).length + 1;
    }
    return kept.length > 0 ? kept.join("\n") : (lines.at(-1) as string).slice(0, max);
};

// Per-automation, per-lane queues, a module singleton so every dispatch path shares the same serialization.
const batchers = new Map<string, MessageBatcher>();

// One batcher per (automation, persona): a message for one persona must never ride a wake wearing another.
const batcherKey = (automationId: string, lane: SenderLane): string => (lane.actsAs === undefined ? automationId : `${automationId}:${lane.actsAs}`);

// Board/tab title for the conversation this message opens: the message's first line, since every fire of an automation
// shares the same configured prompt.
// A content-less event falls back to naming what happened.
const titleOf = (message: ListenerMessage): string => {
    const line = message.content
        .split("\n")
        .find((candidate) => candidate.trim() !== "")
        ?.trim();
    return (line !== undefined ? `${message.author.name}: ${line}` : `${message.provider} ${message.type}`).slice(0, TITLE_MAX);
};

// Whether a listener trigger's filters admit this message: everything about the message itself, nothing yet about who
// sent it. An absent filter admits.
const triggerAdmits = (trigger: Extract<Trigger, { kind: "listener" }>, message: ListenerMessage): boolean =>
    trigger.provider === message.provider &&
    (trigger.channelId === undefined || trigger.channelId === message.channelId) &&
    (trigger.eventType === undefined || trigger.eventType === message.type) &&
    (trigger.mentioned !== true || message.mentioned === true) &&
    (trigger.branch === undefined || trigger.branch === message.branch);

// Routes one event to every matching enabled listener automation's batcher. Matching re-reads automations so an edit,
// disable or delete is honored immediately; the fire re-reads once more at wake time.
export const dispatchListenerMessage = async (
    services: Services,
    message: ListenerMessage,
    wake: WakeFn = streamAgent,
    debounceMs = DEBOUNCE_MS,
    // Builds a live reply sink per matched automation; undefined or no return means the agent replies normally.
    makeStream?: (automationId: string) => TurnStream | undefined,
): Promise<string[]> => {
    const line = JSON.stringify(message);
    const matched: string[] = [];
    // Whether the message reached any automation's filters, admitted or not: the roster records who tried, once.
    let reached = false;
    for (const automation of await services.automations.list()) {
        if (!automation.enabled || automation.trigger.kind !== "listener" || !triggerAdmits(automation.trigger, message)) {
            continue;
        }
        reached = true;
        // Sender rules decide last, after every filter about the message itself: a stranger in the wrong channel is
        // still a stranger, but only the sender rules say so.
        const lane = senderLane(automation, message.author);
        if (lane === undefined) {
            continue;
        }
        const key = batcherKey(automation.id, lane);
        let batcher = batchers.get(key);
        if (batcher === undefined) {
            const id = automation.id;
            batcher = createMessageBatcher(
                async (payload, context) => {
                    const fresh = await services.automations.get(id);
                    if (fresh === undefined || !fresh.enabled || fresh.trigger.kind !== "listener") {
                        // Disabled or deleted since dispatch: end the sink so a streamed caller isn't left awaiting a
                        // dead turn.
                        context.stream?.end();
                        return;
                    }
                    // Reuses the channel's live conversation, or starts fresh past the TTL, keyed like the Visitor chat's
                    // chat.
                    const openedAt = Date.now();
                    const session = await services.threadSessions.open(
                        context.thread,
                        () => mintConversationId(id, openedAt),
                        CHANNEL_SESSION_TTL_MS,
                        openedAt,
                    );
                    const settled = await fireAutomation(services, fresh, wake, {
                        payload,
                        // Queues rather than drops: the blocking run may be an approved wake or a restart's re-fire,
                        // not the batcher's.
                        overlap: "queue",
                        conversationId: session.conversationId,
                        // Resumes the provider session the channel's last message ran on.
                        ...(session.sessionId !== undefined ? { sessionId: session.sessionId } : {}),
                        thread: context.thread,
                        lane: context.lane,
                        origin: context.origin,
                        title: context.title,
                        ...(context.stream !== undefined ? { stream: context.stream } : {}),
                    });
                    await services.threadSessions.settle(context.thread, settled.sessionId, Date.now());
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
            batchers.set(key, batcher);
        }
        const stream = makeStream?.(automation.id);
        batcher.push(line, {
            origin: {
                automationId: automation.id,
                provider: message.provider,
                channelId: message.channelId,
                author: message.author.name,
            },
            title: titleOf(message),
            thread: threadKey(message.provider, automation.id, message.channelId, lane.actsAs),
            lane,
            ...(stream !== undefined ? { stream } : {}),
        });
        matched.push(automation.id);
    }
    if (reached) {
        void services.senders
            .record(message.provider, message.author, Date.now())
            .catch((error: unknown) => services.logger.warn({ err: error }, "senders roster write failed"));
    }
    // Only messages that woke an automation are logged; the gateway sees every channel message, not just matches.
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
    return matched;
};

// Records a fatal source failure as an error run on each of the provider's listener automations, plus one activity
// event that /activity/status reads lastError from.
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
