import type { AgentOrigin } from "@intentic/sandbox-contract";
import { z } from "zod";
import { streamAgent } from "../agent/agent.routes.js";
import type { Services } from "../composition.js";
import { CHANNEL_SESSION_TTL_MS, threadKey } from "../sessions/thread-sessions.js";
import { fireAutomation, mintConversationId, PAYLOAD_MAX, TITLE_MAX, type TurnStream, type WakeFn } from "./scheduler.js";

// Realtime agent wake-ups: provider sources hold a live connection (e.g. the Discord gateway) and dispatch
// normalized messages here; `listener`-kind automations fire from them through the same guard/wake/run-history
// path as schedule and event automations. The reconciler below connects/disconnects each source on a poll
// tick, so the daemon holds a provider connection ONLY while an enabled listener automation and the
// provider's capability both exist.
//
// Each fire opens or CONTINUES a real conversation (see FireOptions.origin): the message rides in as the
// opening context of an isolated agent that shows up on the fleet board and opens as a chat tab, so an inbound
// Discord mention is the same object as a chat the user started — only the first prompt comes from the
// automation's config and the message rather than from a person. That's why the batcher carries provenance, a
// title and a thread key alongside the payload: they are what the conversation is created with, and which one
// it is.
//
// A channel is a THREAD (sessions/thread-sessions.ts), not a series of strangers: every message in it resumes
// the same conversation and provider session until the channel goes quiet past CHANNEL_SESSION_TTL_MS, after
// which the next one starts fresh. Without that, tagging the bot five times in #eng was five fleet cards, five
// worktrees, and five agents that had never heard of each other.

// How long a quiet gap ends a burst — rapid-fire messages batch into one wake. The timer restarts on
// every message, so bursts still coalesce; a lone mention just stops paying dead time before it fires.
// ponytail: 750ms floor tuned for snappy single mentions; raise if real bursts start firing mid-typing.
export const DEBOUNCE_MS = 750;

// One normalized inbound event — serialized as a JSON line in the automation's payload, and the JSON body a
// realtime source POSTs to /listeners/<provider>/dispatch. A zod schema (not a bare interface) because it's
// parsed from an extension gateway's request; `provider` and `type` are open strings — the source is now
// extension-declared (contributes.listener), not a core enum.
export const ListenerMessageSchema = z.object({
    provider: z.string().min(1),
    type: z.string().min(1),
    id: z.string(),
    channelId: z.string(),
    author: z.object({ id: z.string(), name: z.string() }),
    content: z.string(),
    // Discord message: it @mentions one of our bots or replies to a bot's message. Voice events never set it.
    mentioned: z.boolean().optional(),
    // CI pipeline event: the ref it ran on. Top-level rather than inside `extra` for the same reason
    // `mentioned` is — the dispatcher below MATCHES on it, and a narrowing axis the trigger can name has to be
    // a field of the message rather than a key in a provider's opaque bag.
    branch: z.string().optional(),
    // Prior channel messages (chronological) fetched when a bot is tagged, so the agent can reason about why.
    // Kept a top-level field (not in `extra`) so it reaches the model's payload but stays out of the activity
    // feed, which logs only content/extra.
    history: z
        .array(
            z.object({
                author: z.object({ id: z.string(), name: z.string() }),
                content: z.string(),
                timestamp: z.string(),
                self: z.boolean().optional(),
            }),
        )
        .optional(),
    timestamp: z.string(),
    // Provider-specific fields (discord message: guildId, attachments; voice_utterance: path;
    // voice_transcript: path, participants, durationSeconds).
    extra: z.record(z.string(), z.unknown()).optional(),
});
export type ListenerMessage = z.infer<typeof ListenerMessageSchema>;

// What the message that triggers a fire contributes to the conversation that fire opens or CONTINUES: where it
// came from, what to call it on the board, which thread it belongs to, and (when the source wants the turn
// streamed back) the live reply sink.
export interface MessageContext {
    readonly origin: AgentOrigin;
    readonly title: string;
    // The channel this message arrived in, as a thread-sessions key. Computed at push time (where the message
    // is) rather than at fire time, because one automation can watch every channel — the batch's key is the
    // newest message's, exactly as its origin and title are.
    readonly thread: string;
    readonly stream?: TurnStream;
}

export interface MessageBatcher {
    readonly push: (line: string, context: MessageContext) => void;
}

// Batches payload lines into one wake. fireAutomation's inFlight set DROPS concurrent fires, so naive
// per-message fires would silently lose messages arriving while the agent runs — this serializes instead:
// a burst debounces into one fire, and lines arriving mid-run accumulate and fire once more when it finishes
// (no debounce on the follow-up; they waited long enough).
export const createMessageBatcher = (
    fire: (payload: string, context: MessageContext) => Promise<void>,
    onError: (error: unknown) => void,
    debounceMs = DEBOUNCE_MS,
): MessageBatcher => {
    let pending: string[] = [];
    // The context of the next fire — the most recent message in the batch wins, so the conversation it opens is
    // named after what actually asked for it (a burst spanning channels attributes to the latest; rare enough
    // not to split). undefined ⇒ nothing is batched right now.
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
                // End the sink this one supersedes so its consumer (the dispatch route's held-open ndjson
                // response) isn't left hanging on a stream that will never fire — the batch keeps only the newest
                // reply target, and a burst of two messages before a flush must not orphan the first's response.
                carried?.end();
            }
            // The reply sink is the newest one that HAS a sink, while everything else is simply the newest: a
            // plain follow-up message must not silently drop an earlier mention's held-open response.
            pendingContext = context.stream === undefined && carried !== undefined ? { ...context, stream: carried } : context;
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

// What the conversation this message opens is CALLED on the board and in the chat tab list. Every fire of one
// automation carries the identical configured prompt, so a title derived from the prompt would give a column of
// indistinguishable cards — the message's own first line is the only thing that says which mention this is.
// A content-less event (a voice utterance) falls back to naming what happened.
const titleOf = (message: ListenerMessage): string => {
    const line = message.content
        .split("\n")
        .find((candidate) => candidate.trim() !== "")
        ?.trim();
    return (line !== undefined ? `${message.author.name}: ${line}` : `${message.provider} ${message.type}`).slice(0, TITLE_MAX);
};

// Route one event to every matching enabled listener automation's batcher. Matching re-reads the manifest so
// an edit/disable/delete is honored immediately; the batcher's fire re-reads once more at wake time.
export const dispatchListenerMessage = async (
    services: Services,
    message: ListenerMessage,
    wake: WakeFn = streamAgent,
    debounceMs = DEBOUNCE_MS,
    // Builds a fresh live reply sink for a matched automation when the source wants the turn streamed back (e.g. a
    // Discord mention → a channel message edited as the model types). Called per matched automation with its id so
    // the dispatch route can tag each frame by automationId. undefined / returns undefined ⇒ the agent sends its own
    // reply as before. Returns the ids that matched so a streaming caller knows which reply sinks to await.
    makeStream?: (automationId: string) => TurnStream | undefined,
): Promise<string[]> => {
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
        if (trigger.branch !== undefined && trigger.branch !== message.branch) {
            continue;
        }
        let batcher = batchers.get(automation.id);
        if (batcher === undefined) {
            const id = automation.id;
            batcher = createMessageBatcher(
                async (payload, context) => {
                    const fresh = await services.automations.get(id);
                    if (fresh === undefined || !fresh.enabled || fresh.trigger.kind !== "listener") {
                        // Disabled/deleted between dispatch and this debounced wake — end the reply sink so a
                        // streamed dispatch doesn't hang awaiting a turn that will never run.
                        context.stream?.end();
                        return;
                    }
                    /* The channel's LIVE conversation, or a fresh one when it has been quiet past the TTL. This
                     * is what makes a run of mentions in one channel one agent that remembers what it just said,
                     * instead of a fleet card and a worktree per message: the same shape the Doorbell gives a
                     * visitor's chat, keyed by channel instead of by visitor. */
                    const openedAt = Date.now();
                    const session = await services.threadSessions.open(
                        context.thread,
                        () => mintConversationId(id, openedAt),
                        CHANNEL_SESSION_TTL_MS,
                        openedAt,
                    );
                    const settled = await fireAutomation(services, fresh, wake, {
                        payload,
                        conversationId: session.conversationId,
                        // Resume the provider session the last message in this channel ran on, so a follow-up
                        // continues the thread rather than meeting the same people again.
                        ...(session.sessionId !== undefined ? { sessionId: session.sessionId } : {}),
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
            batchers.set(automation.id, batcher);
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
            thread: threadKey(message.provider, automation.id, message.channelId),
            ...(stream !== undefined ? { stream } : {}),
        });
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
    return matched;
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
