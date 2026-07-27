import type { Client, Message } from "discord.js";
import type { GatewayCtx } from "./context.js";
import { createDiscordStream, type Painter, type StreamChannel } from "./stream.js";

// The text side of the gateway: for every human-authored message a subscribed bot sees, build a normalized
// listener message and POST it to the daemon's dispatch route. On a mention we hold the streaming response and
// paint the model's reply back into the channel live (one painter per matched automation, keyed by automationId).

// Recent message ids, to drop the duplicate delivery when two of our bots share a channel and both receive the
// same human message. ponytail: best-effort in-memory cap; a restart forgets it — at worst one duplicate wake.
const RECENT_MAX = 500;
// Prior messages pulled for context when a bot is tagged (discord fetch max is 100).
const HISTORY_LIMIT = 20;
// Discord's typing indicator auto-expires after ~10s; re-send on this cadence so the bot shows "typing…" for the
// whole turn. Capped so a turn that never replies can't leak the interval forever.
const TYPING_INTERVAL_MS = 8_000;
const TYPING_MAX_MS = 300_000;

interface HistoryEntry {
    author: { id: string; name: string };
    content: string;
    timestamp: string;
    self?: boolean;
}

// Newest-first discord messages (as fetch returns them) → chronological history entries, flagging posts by our
// own bots so the model recognizes its prior replies. Exported for tests.
export const toHistory = (newestFirst: readonly Message[], selfIds: ReadonlySet<string>): HistoryEntry[] =>
    newestFirst.toReversed().map((m) => {
        const entry: HistoryEntry = {
            author: { id: m.author.id, name: m.author.username },
            content: m.content,
            timestamp: m.createdAt.toISOString(),
        };
        if (selfIds.has(m.author.id)) {
            entry.self = true;
        }
        return entry;
    });

export interface DiscordListener {
    readonly onMessage: (message: Message) => void;
    readonly stopAll: () => void;
}

export const createDiscordListener = (ctx: GatewayCtx, subscribed: Map<string, Client>): DiscordListener => {
    const recent = new Set<string>();
    // Live "typing…" indicators keyed by channelId — started on a mention, cleared when our own reply lands or
    // after TYPING_MAX_MS.
    const typing = new Map<string, NodeJS.Timeout>();
    const stopTyping = (channelId: string): void => {
        const timer = typing.get(channelId);
        if (timer !== undefined) {
            clearInterval(timer);
            typing.delete(channelId);
        }
    };
    const startTyping = (channel: Message["channel"]): void => {
        if (!("sendTyping" in channel)) {
            return;
        }
        stopTyping(channel.id);
        void channel.sendTyping().catch(() => undefined);
        const startedAt = Date.now();
        typing.set(
            channel.id,
            setInterval(() => {
                if (Date.now() - startedAt > TYPING_MAX_MS) {
                    stopTyping(channel.id);
                    return;
                }
                void channel.sendTyping().catch(() => undefined);
            }, TYPING_INTERVAL_MS),
        );
    };

    const fetchHistory = async (message: Message): Promise<HistoryEntry[]> => {
        const fetched = await message.channel.messages.fetch({ limit: HISTORY_LIMIT, before: message.id });
        const selfIds = new Set([...subscribed.values()].flatMap((c) => (c.user !== null ? [c.user.id] : [])));
        return toHistory([...fetched.values()], selfIds);
    };

    const onMessage = (message: Message): void => {
        // Never wake on our own bots' posts (any connected instance) — an agent reply in-channel must not
        // re-trigger, and bot A must not wake on bot B. Third-party bots/webhooks still dispatch (CI alerts are a
        // valid trigger); guards can filter them.
        for (const client of subscribed.values()) {
            if (client.user?.id === message.author.id) {
                // Our own reply landed in this channel — stop the "typing…" heartbeat.
                stopTyping(message.channelId);
                return;
            }
        }
        if (recent.has(message.id)) {
            return;
        }
        recent.add(message.id);
        if (recent.size > RECENT_MAX) {
            const oldest = recent.values().next().value;
            if (oldest !== undefined) {
                recent.delete(oldest);
            }
        }
        // "Tagged": a direct @mention of any of our bots or a reply to one of their messages (roles/@everyone
        // excluded) — checked against every subscribed bot because the recent-id dedup means only the first
        // delivery dispatches, and it may reach a bot other than the one tagged.
        const mentioned = [...subscribed.values()].some(
            (client) => client.user !== null && message.mentions.has(client.user, { ignoreEveryone: true, ignoreRoles: true }),
        );
        if (mentioned) {
            // Immediate feedback: show "typing…" the moment we're tagged, before the (debounced) turn spins up.
            startTyping(message.channel);
        }
        const channel = message.channel;
        // Paint the mention reply back into this channel live only when we can post here; otherwise the agent
        // sends its own reply via the Discord skill, as before.
        const paintable = mentioned && "send" in channel;
        void (async () => {
            const history = mentioned
                ? await fetchHistory(message).catch((error: unknown) => {
                      // A history-fetch failure (missing Read Message History perm, rate limit) must not drop the
                      // wake — degrade to no context.
                      ctx.log.warn({ err: error }, "discord history fetch failed");
                      return undefined;
                  })
                : undefined;
            const payload = {
                provider: "discord",
                type: "message",
                id: message.id,
                channelId: message.channelId,
                author: { id: message.author.id, name: message.author.username },
                content: message.content,
                ...(mentioned ? { mentioned: true } : {}),
                ...(history !== undefined && history.length > 0 ? { history } : {}),
                timestamp: message.createdAt.toISOString(),
                extra: {
                    ...(message.guildId !== null ? { guildId: message.guildId } : {}),
                    ...(message.attachments.size > 0 ? { attachments: message.attachments.map(({ name, url }) => ({ name, url })) } : {}),
                },
            };
            if (!paintable) {
                await ctx.daemon.dispatch(payload);
                return;
            }
            const painters = new Map<string, Painter>();
            const onError = (error: unknown): void => ctx.log.warn({ err: error }, "discord stream paint failed");
            try {
                await ctx.daemon.dispatchStreaming(payload, (frame) => {
                    let painter = painters.get(frame.automationId);
                    if (painter === undefined) {
                        painter = createDiscordStream(channel as StreamChannel, onError);
                        painters.set(frame.automationId, painter);
                    }
                    if (frame.delta !== undefined) {
                        painter.delta(frame.delta);
                    }
                    if (frame.end === true) {
                        painter.end();
                    }
                });
            } finally {
                // The turn(s) ended (or the stream broke) — drop the typing heartbeat if our own reply didn't
                // already clear it.
                stopTyping(message.channelId);
            }
        })().catch((error: unknown) => ctx.log.error({ err: error }, "discord message dispatch failed"));
    };

    return {
        onMessage,
        stopAll: () => {
            for (const timer of typing.values()) {
                clearInterval(timer);
            }
            typing.clear();
        },
    };
};
