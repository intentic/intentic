import {
    type Delivered,
    deliverChunked,
    type GatewayCtx,
    GatewayRefusal,
    HISTORY_LIMIT,
    joinedThreads,
    type ListenerHistoryEntry,
    type ListenerMessage,
    type ListenerStop,
    MESSAGE_LIMITS,
    progressDetailOf,
    recentKeys,
    type ReplyTiming,
    runRegistry,
    stopFromChat,
    stopTarget,
} from "@intentic/connector-runtime";
import { type ButtonInteraction, type Client, DiscordAPIError, type Guild, type Interaction, type Message, MessageFlags, type REST, Routes } from "discord.js";
import { visibleChannel } from "./client.js";
import { postMessage } from "./discord-rest.js";
import { inboundOf, type Route, routeOf } from "./inbound.js";
import { createMessageReply, type ReplyDeps } from "./reply.js";

// Text side of the gateway: builds a normalized listener message from every human-authored message a subscribed bot
// sees, and POSTs it to the daemon's dispatch route. A message addressed to us (inbound.ts) gets its answer back live,
// in its own thread, with a status card and reactions (reply.ts); the card's Stop button comes back here.

// Discord's per-message content limit; a longer reply spills into follow-up messages.
const DISCORD_MAX = MESSAGE_LIMITS.discord;

// The parts of a discord.js message the dispatch reads, structural so a test can hand one in without a client.
export interface DispatchedMessage {
    readonly id: string;
    readonly guildId: string | null;
    readonly content: string;
    readonly createdAt: Date;
    readonly author: { readonly id: string; readonly username: string };
    readonly member: { readonly roles: { readonly cache: { values: () => Iterable<{ readonly id: string }> } } } | null;
    readonly attachments: { readonly size: number; map: <T>(each: (attachment: { readonly name: string; readonly url: string }) => T) => T[] };
}

// Who wrote it, as Discord vouches for them: the user id (what a sender rule names), the username for display, and in a
// guild the member's role ids as `groups`, @everyone included, so a rule can name a role or the whole server. A DM has
// no member and so no groups.
export const authorOf = (message: Pick<DispatchedMessage, "author" | "member">): ListenerMessage["author"] => {
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
    readonly onInteraction: (interaction: Interaction) => void;
    readonly onGuildJoin: (guild: Guild) => void;
}

// What the listener reads of a bot's connector: how much of the agent's work its threads show.
export interface ListenerOptions {
    readonly progressOf: (client: Client) => string | undefined;
    readonly timing?: ReplyTiming;
}

// The parts of a button press the Stop rule reads: who pressed it, and their roles in the server, which an interaction
// carries as a list of ids or, for a cached member, in its role cache.
export interface Presser {
    readonly user: { readonly id: string; readonly username: string };
    readonly member: { readonly roles: readonly string[] | { readonly cache: { keys: () => Iterable<string> } } } | null;
    readonly guildId: string | null;
}

// Who pressed a button, as the sender rules read people: their id, their name, and in a server their role ids with the
// server's own (the role everyone in it has).
export const presserOf = (interaction: Presser): ListenerStop["author"] => {
    const member = interaction.member;
    const roles = member === null ? [] : "cache" in member.roles ? [...member.roles.cache.keys()] : member.roles;
    const groups = [...new Set([...(interaction.guildId === null ? [] : [interaction.guildId]), ...roles])];
    return { id: interaction.user.id, name: interaction.user.username, ...(groups.length > 0 ? { groups } : {}) };
};

// The thread's opening message and what was said in it before this one, oldest first: in a thread, its own messages
// and the message it was opened from (which lives in the channel); anywhere else, the channel's last few.
const historyOf = async (message: Message, selfIds: ReadonlySet<string>): Promise<ListenerHistoryEntry[]> => {
    const fetched = await message.channel.messages.fetch({ limit: HISTORY_LIMIT, before: message.id });
    const history = toHistory([...fetched.values()], selfIds);
    const channel = message.channel;
    if (!channel.isThread() || history.length >= HISTORY_LIMIT) {
        return history;
    }
    // allow(silent-catch): a thread opened without a message, or whose opening message was deleted, has none to add
    const starter = await channel.fetchStarterMessage().catch(() => null);
    return starter === null || starter.id === message.id ? history : [...toHistory([starter], selfIds), ...history];
};

// What a Discord message carries beyond the common fields: its server, and the files attached to it.
type DiscordExtra = { guildId?: string; attachments?: Array<{ readonly name: string; readonly url: string }> };

// The normalized message the daemon dispatches on: where it belongs (the route's channel and thread), who wrote it, and
// for one addressed to us, that it was, with what was said before it.
export const payloadOf = (message: DispatchedMessage, route: Route, history: readonly ListenerHistoryEntry[] | undefined): ListenerMessage => {
    const extra: DiscordExtra = {};
    if (message.guildId !== null) {
        extra.guildId = message.guildId;
    }
    if (message.attachments.size > 0) {
        extra.attachments = message.attachments.map(({ name, url }) => ({ name, url }));
    }
    let payload: ListenerMessage = {
        provider: "discord",
        type: "message",
        id: message.id,
        channelId: route.channelId,
        author: authorOf(message),
        content: message.content,
        timestamp: message.createdAt.toISOString(),
        extra,
    };
    if (route.thread !== undefined) {
        payload = { ...payload, thread: route.thread };
    }
    if (route.addressed) {
        payload = { ...payload, mentioned: true };
    }
    if (history !== undefined && history.length > 0) {
        payload = { ...payload, history: [...history] };
    }
    return payload;
};

const welcomeText = (botId: string): string =>
    [
        `👋 Hi! I'm the agent from this team's Intentic sandbox.`,
        `Mention <@${botId}> with a question or a task: I answer in a thread of its own, show what I'm doing while I work, and anyone in the thread can steer me by replying, no mention needed.`,
    ].join("\n");

export const createDiscordListener = (ctx: GatewayCtx, subscribed: Map<string, Client>, options: ListenerOptions): DiscordListener => {
    const recent = recentKeys();
    const joined = joinedThreads();
    const runs = runRegistry();
    const botIds = (): Set<string> => new Set([...subscribed.values()].flatMap((client) => (client.user !== null ? [client.user.id] : [])));

    const dispatch = async (message: Message, route: Route, ours: ReadonlySet<string>): Promise<void> => {
        const history = route.addressed
            ? await historyOf(message, ours).catch((error: Error) => {
                  // A history-fetch failure (missing perm, rate limit) must not drop the wake; degrades to no context.
                  ctx.log.warn({ err: error }, "discord history fetch failed");
                  return undefined;
              })
            : undefined;
        const payload = payloadOf(message, route, history);
        if (!route.addressed) {
            await ctx.daemon.dispatch(payload);
            return;
        }
        const replyDeps: ReplyDeps = {
            rest: message.client.rest,
            log: ctx.log,
            detail: progressDetailOf(options.progressOf(message.client)),
            registry: runs,
            joined: joined.add,
        };
        const reply = createMessageReply(options.timing === undefined ? replyDeps : { ...replyDeps, timing: options.timing }, {
            messageId: message.id,
            channelId: message.channelId,
            authorId: message.author.id,
            route,
        });
        try {
            await ctx.daemon.dispatchStreaming(payload, reply.frame);
        } finally {
            await reply.settle();
        }
    };

    const onMessage = (message: Message): void => {
        const ours = botIds();
        // Never wakes on our own bots, so a reply can't re-trigger itself or another; third-party bots still dispatch.
        if (ours.has(message.author.id) || recent.duplicate(message.id)) {
            return;
        }
        const route = routeOf(inboundOf(message, ours), { botIds: ours, joined: joined.has });
        dispatch(message, route, ours).catch((error: Error) => ctx.log.error({ err: error }, "discord message dispatch failed"));
    };

    // The Stop button under a status card: the daemon decides whether the presser may, by the automation's own rules.
    const onStop = async (interaction: ButtonInteraction, conversationId: string): Promise<void> => {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const shownAs = interaction.user.globalName ?? interaction.user.username;
        await interaction.editReply(await stopFromChat(ctx.daemon, runs, { conversationId, author: presserOf(interaction) }, shownAs, ctx.log));
    };

    const onInteraction = (interaction: Interaction): void => {
        if (!interaction.isButton()) {
            return;
        }
        const conversationId = stopTarget(interaction.customId);
        if (conversationId === undefined) {
            return;
        }
        onStop(interaction, conversationId).catch((error: Error) => ctx.log.warn({ err: error }, "discord stop failed"));
    };

    // Joining a server while the assistant is on: say hello where the server greets newcomers, so people know how to
    // reach it. A server with no such channel, or one the bot cannot post in, is left quiet.
    const onGuildJoin = (guild: Guild): void => {
        const channelId = guild.systemChannelId;
        const botId = guild.client.user?.id;
        if (channelId === null || botId === undefined) {
            return;
        }
        postMessage(guild.client.rest, channelId, { content: welcomeText(botId) }).catch((error: Error) =>
            ctx.log.warn({ err: error, guild: guild.id }, "discord: could not say hello in a new server"),
        );
    };

    return { onMessage, onInteraction, onGuildJoin };
};
