import { createStreamingPainter, failureNotice, framePainter, type GatewayCtx, GatewayRefusal, type ListenerMessage, recentKeys, typingHeartbeat } from "@intentic/connector-runtime";
import type { Client, Message } from "discord.js";

// Text side of the gateway: builds a normalized listener message from every human-authored message a subscribed bot
// sees, and POSTs it to the daemon's dispatch route. On a mention, holds the stream and paints the reply back live, one
// painter per matched automation.

// Slice of the discord.js channel API the painter uses, kept structural so this file stays decoupled from discord.js's
// own classes.
export interface EditableMessage {
    readonly edit: (content: string) => Promise<unknown>;
}
export interface StreamChannel {
    readonly send: (content: string) => Promise<EditableMessage>;
}

// Discord's per-message content limit; a longer reply spills into follow-up messages.
const DISCORD_MAX = 2_000;
// Min gap between edits; Discord rate-limits them (~5/5s), and typing covers the gap until first paint.
const EDIT_INTERVAL_MS = 1_200;
// Recent message ids, deduping when two bots share a channel; a restart forgets it, at worst one duplicate.
const RECENT_MAX = 500;
// Prior messages pulled for context when a bot is tagged (discord fetch max is 100).
const HISTORY_LIMIT = 20;
// Re-sent since Discord's typing indicator expires after ~10s; capped so a stuck turn can't leak it forever.
const TYPING_INTERVAL_MS = 8_000;
const TYPING_MAX_MS = 300_000;

interface HistoryEntry {
    author: { id: string; name: string };
    content: string;
    timestamp: string;
    self?: boolean;
}

// Newest-first fetch results to chronological history, flagging our own bots' posts so the model recognizes its prior
// replies.
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

// The gateway's /deliver door: posts one message outside any live turn, whichever connected bot can see the channel
// (the first subscribed, matching inbound dedup order). Chunked at the same ceiling a streamed reply spills at.
export const deliverToChannel = async (subscribed: ReadonlyMap<string, Client>, channelId: string, text: string): Promise<void> => {
    for (const client of subscribed.values()) {
        const channel = await client.channels.fetch(channelId).catch(() => null);
        if (channel === null || !("send" in channel)) {
            continue;
        }
        for (let base = 0; base < text.length; base += DISCORD_MAX) {
            await (channel as unknown as StreamChannel).send(text.slice(base, base + DISCORD_MAX));
        }
        return;
    }
    throw new GatewayRefusal("no connected Discord bot can post in this channel");
};

export interface DiscordListener {
    readonly onMessage: (message: Message) => void;
    readonly stopAll: () => void;
}

export const createDiscordListener = (ctx: GatewayCtx, subscribed: Map<string, Client>): DiscordListener => {
    const recent = recentKeys(RECENT_MAX);
    // Live "typing…" indicators keyed by channelId, started on a mention, cleared when our own reply lands.
    const typing = typingHeartbeat({ intervalMs: TYPING_INTERVAL_MS, maxMs: TYPING_MAX_MS });
    const startTyping = (channel: Message["channel"]): void => {
        if (!("sendTyping" in channel)) {
            return;
        }
        typing.start(channel.id, () => void channel.sendTyping().catch(() => undefined));
    };

    const fetchHistory = async (message: Message): Promise<HistoryEntry[]> => {
        const fetched = await message.channel.messages.fetch({ limit: HISTORY_LIMIT, before: message.id });
        const selfIds = new Set([...subscribed.values()].flatMap((c) => (c.user !== null ? [c.user.id] : [])));
        return toHistory([...fetched.values()], selfIds);
    };

    const onMessage = (message: Message): void => {
        // Never wakes on our own bots, so a reply can't re-trigger itself or another; third-party bots still dispatch.
        for (const client of subscribed.values()) {
            if (client.user?.id === message.author.id) {
                // Our own reply landed in this channel, stop the "typing…" heartbeat.
                typing.stop(message.channelId);
                return;
            }
        }
        if (recent.duplicate(message.id)) {
            return;
        }
        // Tagged: an @mention or reply to any of our bots, checked against all since dedup may pick a different one.
        const mentioned = [...subscribed.values()].some(
            (client) => client.user !== null && message.mentions.has(client.user, { ignoreEveryone: true, ignoreRoles: true }),
        );
        if (mentioned) {
            // Immediate feedback: show "typing…" the moment we're tagged, before the (debounced) turn spins up.
            startTyping(message.channel);
        }
        const channel = message.channel;
        // Live-paints the reply only when we can post here; otherwise the agent replies via the Discord skill instead.
        const paintable = mentioned && "send" in channel;
        void (async () => {
            const history = mentioned
                ? await fetchHistory(message).catch((error: unknown) => {
                      // A history-fetch failure (missing perm, rate limit) must not drop the wake; degrades to no
                      // context.
                      ctx.log.warn({ err: error }, "discord history fetch failed");
                      return undefined;
                  })
                : undefined;
            const payload: ListenerMessage = {
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
            const onError = (error: unknown): void => ctx.log.warn({ err: error }, "discord stream paint failed");
            const poster = {
                post: (content: string) => (channel as StreamChannel).send(content),
                update: (handle: EditableMessage, content: string) => handle.edit(content),
            };
            try {
                await ctx.daemon.dispatchStreaming(
                    payload,
                    framePainter(
                        () => createStreamingPainter(poster, onError, { maxChars: DISCORD_MAX, editIntervalMs: EDIT_INTERVAL_MS }),
                        // Posted directly, not through the painter, which owns the reply text a failed turn usually has
                        // none of.
                        (reason) => void poster.post(failureNotice(reason, DISCORD_MAX)).catch(onError),
                    ),
                );
            } finally {
                // Turn ended or the stream broke either way; drop typing if our own reply didn't already clear it.
                typing.stop(message.channelId);
            }
        })().catch((error: unknown) => ctx.log.error({ err: error }, "discord message dispatch failed"));
    };

    return {
        onMessage,
        stopAll: typing.stopAll,
    };
};
