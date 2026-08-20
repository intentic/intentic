import {
    createStreamingPainter,
    failureNotice,
    framePainter,
    GatewayRefusal,
    type GatewayCtx,
    type ListenerMessage,
} from "@intentic/connector-runtime";
import type { Client, Message } from "discord.js";

// The text side of the gateway: for every human-authored message a subscribed bot sees, build a normalized
// listener message and POST it to the daemon's dispatch route. On a mention we hold the streaming response and
// paint the model's reply back into the channel live (one painter per matched automation, keyed by automationId).

// The slice of the discord.js channel API the painter uses, structural so this file stays decoupled from
// discord.js message classes. `channel.send(...)` returns a Message; `message.edit(...)` edits it in place.
export interface EditableMessage {
    readonly edit: (content: string) => Promise<unknown>;
}
export interface StreamChannel {
    readonly send: (content: string) => Promise<EditableMessage>;
}

// Discord's per-message content limit; a longer reply spills into follow-up messages.
const DISCORD_MAX = 2_000;
// Min gap between edits of the growing message. Discord rate-limits edits (~5/5s per channel) and we don't need
// to repaint on every token. The typing indicator covers the gap until the first paint.
const EDIT_INTERVAL_MS = 1_200;
// Recent message ids, to drop the duplicate delivery when two of our bots share a channel and both receive the
// same human message. ponytail: best-effort in-memory cap; a restart forgets it, at worst one duplicate wake.
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

/* The gateway's /deliver door (GatewayHooks.deliver): post one message into a channel outside any live turn,
 * the daemon's "speak as the agent" path for a Discord conversation. Which bot speaks is whichever connected
 * one can see the channel; with several bots sharing a channel that is the first subscribed, matching the
 * dedup order inbound messages already follow. Chunked at the same ceiling a streamed reply spills at. */
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
    const recent = new Set<string>();
    // Live "typing…" indicators keyed by channelId, started on a mention, cleared when our own reply lands or
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
        // Never wake on our own bots' posts (any connected instance), an agent reply in-channel must not
        // re-trigger, and bot A must not wake on bot B. Third-party bots/webhooks still dispatch (CI alerts are a
        // valid trigger); guards can filter them.
        for (const client of subscribed.values()) {
            if (client.user?.id === message.author.id) {
                // Our own reply landed in this channel, stop the "typing…" heartbeat.
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
        // excluded), checked against every subscribed bot because the recent-id dedup means only the first
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
                      // wake, degrade to no context.
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
                        // Its own message rather than through the painter: the painter owns the reply text, and a
                        // turn that failed usually has none to flush.
                        (reason) => void poster.post(failureNotice(reason, DISCORD_MAX)).catch(onError),
                    ),
                );
            } finally {
                // The turn(s) ended (or the stream broke), drop the typing heartbeat if our own reply didn't
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
