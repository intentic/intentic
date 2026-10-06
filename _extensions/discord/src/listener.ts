import {
    type Delivered,
    deliverChunked,
    type GatewayCtx,
    GatewayRefusal,
    HISTORY_LIMIT,
    type ListenerHistoryEntry,
    type ListenerMessage,
    MESSAGE_LIMITS,
    paintReply,
    recentKeys,
    typingHeartbeat,
} from "@intentic/connector-runtime";
import { type Client, DiscordAPIError, type Message, type REST, Routes } from "discord.js";
import { visibleChannel } from "./client.js";

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
const DISCORD_MAX = MESSAGE_LIMITS.discord;
// Min gap between edits; Discord rate-limits them (~5/5s), and typing covers the gap until first paint.
const EDIT_INTERVAL_MS = 1_200;
// Re-sent since Discord's typing indicator expires after ~10s.
const TYPING_INTERVAL_MS = 8_000;

// Who wrote it, as Discord vouches for them: the user id (what a sender rule names), the username for display, and in a
// guild the member's role ids as `groups`, @everyone included, so a rule can name a role or the whole server. A DM has
// no member and so no groups.
export const authorOf = (message: Pick<Message, "author" | "member">): ListenerMessage["author"] => {
    const groups = message.member === null ? [] : [...message.member.roles.cache.values()].map((role) => role.id);
    return { id: message.author.id, name: message.author.username, ...(groups.length > 0 ? { groups } : {}) };
};

// Newest-first fetch results to chronological history, flagging our own bots' posts so the model recognizes its prior
// replies.
export const toHistory = (newestFirst: readonly Message[], selfIds: ReadonlySet<string>): ListenerHistoryEntry[] =>
    newestFirst.toReversed().map((m) => {
        const entry: ListenerHistoryEntry = {
            author: { id: m.author.id, name: m.author.username },
            content: m.content,
            timestamp: m.createdAt.toISOString(),
        };
        if (selfIds.has(m.author.id)) {
            entry.self = true;
        }
        return entry;
    });

// One bot's view of a channel, enough to post into it and link to what it posted; null when Discord answers that the
// bot cannot see the channel at all.
export interface PostableChannel {
    readonly guildId: string | null;
    readonly send: (content: string) => Promise<{ readonly id: string }>;
}
export type ChannelLookup = (channelId: string) => Promise<PostableChannel | null>;

// Through a connected client: the channel as its cache and Discord's REST answer it.
export const clientLookup =
    (client: Client): ChannelLookup =>
    async (channelId) => {
        const channel = await visibleChannel(client, channelId);
        if (channel === null || !("send" in channel)) {
            return null;
        }
        // SAFETY: `send` was just found on the channel; discord.js's union of channel classes does not narrow on it.
        const postable = channel as unknown as { readonly send: (content: string) => Promise<Message> };
        return { guildId: "guildId" in channel ? channel.guildId : null, send: (content) => postable.send(content) };
    };

// Through the bot token alone, over REST, for a delivery while no automation holds a connection: an approved post has
// no reason to open (and then hold) a gateway socket. discord.js's REST waits out a 429 itself, as the client does.
export const restLookup =
    (rest: Pick<REST, "get" | "post">): ChannelLookup =>
    async (channelId) => {
        let found: unknown;
        try {
            found = await rest.get(Routes.channel(channelId));
        } catch (error) {
            if (error instanceof DiscordAPIError && (error.status === 400 || error.status === 403 || error.status === 404)) {
                return null;
            }
            throw error;
        }
        // SAFETY: discord.js types every REST answer as unknown; GET /channels/{id} answers a channel object, whose
        // guild_id is absent for a DM.
        const channel = found as { readonly guild_id?: string };
        return {
            guildId: channel.guild_id ?? null,
            // SAFETY: POST /channels/{id}/messages answers the message it created, which always carries its id.
            send: async (content) => (await rest.post(Routes.channelMessages(channelId), { body: { content } })) as { id: string },
        };
    };

export const messageUrl = (guildId: string | null, channelId: string, messageId: string): string =>
    `https://discord.com/channels/${guildId ?? "@me"}/${channelId}/${messageId}`;

// Thrown inside a delivery attempt by a bot that cannot see the channel, so the next bot is tried.
class NotHere extends Error {}

// The gateway's /deliver door: posts one message outside any live turn through the first bot that can see the channel
// (subscribed order, matching inbound dedup), chunked at the same ceiling a streamed reply spills at. A bot whose
// lookup failed outright does not stop the others; its error is the answer only if none of them could post.
export const deliverToChannel = async (bots: Iterable<ChannelLookup>, channelId: string, text: string): Promise<Delivered> => {
    let lookupFailure: Error | undefined;
    const seen = new Map<ChannelLookup, Promise<PostableChannel | null>>();
    const channelOf = (lookup: ChannelLookup): Promise<PostableChannel | null> => {
        const pending = seen.get(lookup) ?? lookup(channelId);
        seen.set(lookup, pending);
        return pending;
    };
    try {
        const [first] = await deliverChunked(
            bots,
            async (lookup, chunk) => {
                const channel = await channelOf(lookup).catch((error: unknown) => {
                    lookupFailure ??= error instanceof Error ? error : new Error(String(error));
                    throw error;
                });
                if (channel === null) {
                    throw new NotHere();
                }
                return messageUrl(channel.guildId, channelId, (await channel.send(chunk)).id);
            },
            text,
            DISCORD_MAX,
            () => new GatewayRefusal("Discord isn't connected in this workspace, so there is no bot to post as."),
        );
        return first === undefined ? {} : { url: first };
    } catch (error) {
        if (lookupFailure !== undefined) {
            throw new Error(`no connected Discord bot could look up channel ${channelId}: ${lookupFailure.message}`, { cause: error });
        }
        if (error instanceof DiscordAPIError) {
            // Discord's own words (Missing Permissions, Unknown Channel) are what the owner can act on, and carry nothing
            // internal, so they pass the gateway's refusal filter instead of the generic sentence.
            throw new GatewayRefusal(`Discord refused the message (HTTP ${error.status}): ${error.message}`);
        }
        throw error instanceof NotHere ? new GatewayRefusal("no connected Discord bot can post in this channel") : error;
    }
};

export interface DiscordListener {
    readonly onMessage: (message: Message) => void;
    readonly stopAll: () => void;
}

export const createDiscordListener = (ctx: GatewayCtx, subscribed: Map<string, Client>): DiscordListener => {
    const recent = recentKeys();
    // Live "typing…" indicators keyed by channelId, started on a mention, cleared when our own reply lands.
    const typing = typingHeartbeat({ intervalMs: TYPING_INTERVAL_MS });
    const startTyping = (channel: Message["channel"]): void => {
        if (!("sendTyping" in channel)) {
            return;
        }
        typing.start(channel.id, () => void channel.sendTyping().catch(() => undefined));
    };

    const fetchHistory = async (message: Message): Promise<ListenerHistoryEntry[]> => {
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
                author: authorOf(message),
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
            await paintReply(ctx.daemon, payload, {
                surface: {
                    stream: {
                        // SAFETY: `paintable` holds only where `send` is on the channel.
                        post: (content: string) => (channel as StreamChannel).send(content),
                        update: (handle: EditableMessage, content: string) => handle.edit(content),
                    },
                    editIntervalMs: EDIT_INTERVAL_MS,
                },
                maxChars: DISCORD_MAX,
                onError: (error) => ctx.log.warn({ err: error }, "discord stream paint failed"),
                // Turn ended or the stream broke either way; drop typing if our own reply didn't already clear it.
                settle: () => typing.stop(message.channelId),
            });
        })().catch((error: unknown) => ctx.log.error({ err: error }, "discord message dispatch failed"));
    };

    return {
        onMessage,
        stopAll: typing.stopAll,
    };
};
