import {
    type ChatReply,
    deliverChunked,
    type GatewayCtx,
    GatewayRefusal,
    HISTORY_LIMIT,
    joinedThreads,
    type ListenerHistoryEntry,
    type ListenerMessage,
    MESSAGE_LIMITS,
    progressDetailOf,
    recentKeys,
    type ReplyTiming,
    runRegistry,
    stopFromChat,
    stopTarget,
} from "@intentic/connector-runtime";
import { STATUS_BLOCK_ID } from "./card.js";
import type { SlackConnection } from "./client.js";
import { createSlackReply, type SlackReplyDeps, statusStyleOf } from "./reply.js";

// Inbound half of the gateway: every Socket Mode envelope becomes a normalized message posted to the daemon's dispatch
// route. A message addressed to us gets its answer back in its thread through the shared chat reply (reply.ts): 👀 at
// once, a status card with Stop once the work outlasts a quick answer, the answer posted below it, and a reaction for how
// it ended. Replies in a thread we answer in need no mention, and one sent while the agent works goes into that turn.
// The card's Stop button comes back here as an `interactive` envelope.

// A longer reply spills into follow-up messages in the thread.
const SLACK_MAX = MESSAGE_LIMITS.slack;

// Allowlist, not denylist: Slack keeps adding bookkeeping subtypes; third-party `bot_message` can trigger us.
const WAKING_SUBTYPES = new Set(["file_share", "thread_broadcast", "bot_message"]);

// One raw Slack message, in the shape both the event payload and the history APIs deliver it.
export interface SlackMessage {
    readonly type?: string;
    readonly subtype?: string;
    readonly channel?: string;
    readonly channel_type?: string;
    readonly user?: string;
    readonly bot_id?: string;
    readonly username?: string;
    readonly text?: string;
    readonly ts: string;
    readonly thread_ts?: string;
    readonly team?: string;
    readonly files?: ReadonlyArray<{ name?: string; url_private?: string }>;
    readonly blocks?: ReadonlyArray<{ readonly block_id?: string }>;
}

export interface SlackReaction {
    readonly type: "reaction_added";
    readonly user: string;
    readonly reaction: string;
    readonly item: { type: string; channel: string; ts: string };
    readonly event_ts: string;
}

// Someone joined a channel; when it is one of our apps, it was just invited there.
export interface SlackMemberJoined {
    readonly type: "member_joined_channel";
    readonly user: string;
    readonly channel: string;
}

// A button pressed on one of our messages (Socket Mode's `interactive` envelope), narrowed to what Stop reads.
export interface SlackBlockActions {
    readonly type: "block_actions";
    readonly user: { readonly id: string };
    readonly channel?: { readonly id: string };
    readonly message?: { readonly ts: string; readonly thread_ts?: string };
    readonly actions: ReadonlyArray<{ readonly action_id: string }>;
}

// An `events_api` envelope's body.
export interface SlackEventsBody {
    readonly event?: SlackMessage | SlackReaction | SlackMemberJoined;
    readonly team_id?: string;
}

// One `slack_event` envelope, narrowed to what this gateway reads; `ack` must be called for every one or Slack
// redelivers it three times, then drops the socket.
export interface SlackEnvelope {
    readonly ack: () => Promise<void>;
    readonly type: string;
    readonly body: SlackEventsBody | SlackBlockActions;
}

// A Slack `ts` ("1755102030.001900") is epoch seconds with a microsecond fraction.
export const tsToIso = (ts: string): string => new Date(Number(ts) * 1000).toISOString();

// Chronological history entries, flagging our own apps' posts so the model recognizes its prior replies. `order` says
// which way the source API delivered them (history: newest-first, replies: oldest-first).
export const toHistory = (
    messages: readonly SlackMessage[],
    order: "newest-first" | "oldest-first",
    selfIds: ReadonlySet<string>,
    nameOf: (message: SlackMessage) => string,
): ListenerHistoryEntry[] =>
    (order === "newest-first" ? messages.toReversed() : [...messages]).map((message) => {
        const id = message.user ?? message.bot_id ?? "";
        const entry: ListenerHistoryEntry = {
            author: { id, name: nameOf(message) },
            content: message.text ?? "",
            timestamp: tsToIso(message.ts),
        };
        if (selfIds.has(id)) {
            entry.self = true;
        }
        return entry;
    });

// Posts into a channel outside any live turn (the daemon's speak-as-the-agent path): into the conversation's thread when
// it lives in one, else top-level. Tries the next app only if nothing posted yet, so a partial spill is never duplicated.
export const deliverToChannel = async (connections: ReadonlyMap<string, SlackConnection>, channel: string, text: string, thread?: string): Promise<void> => {
    await deliverChunked(
        connections.values(),
        // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Slack postMessage has no targetOrigin.
        (connection, chunk) => connection.web.chat.postMessage(thread === undefined ? { channel, text: chunk } : { channel, thread_ts: thread, text: chunk }),
        text,
        SLACK_MAX,
        () => new GatewayRefusal("no Slack app is connected"),
    );
};

// The thread a message's conversation lives in: the one it was posted in, or, for a message addressed to us at the top
// level, the thread our reply opens under it. A top-level message not for us belongs to the channel.
export const threadOf = (message: Pick<SlackMessage, "ts" | "thread_ts">, mentioned: boolean): string | undefined =>
    message.thread_ts ?? (mentioned ? message.ts : undefined);

// How a message was heard: whether it is addressed to us, the thread its conversation lives in, and what was said
// before it (empty when it is not for us).
export interface Heard {
    readonly mentioned: boolean;
    readonly thread: string | undefined;
    readonly history: readonly ListenerHistoryEntry[];
}

// What a Slack message carries beyond the common fields: where a reply goes, its workspace, and the files attached to it.
type SlackExtra = { threadTs: string; teamId?: string; attachments?: Array<{ readonly name: string | undefined; readonly url: string | undefined }> };

// The normalized message the daemon dispatches on.
export const payloadOf = (
    message: SlackMessage & { readonly channel: string },
    heard: Heard,
    author: ListenerMessage["author"] | undefined,
    teamId: string | undefined,
): ListenerMessage => {
    // Reply target: a threaded message continues that thread; a top-level one opens a new one.
    const extra: SlackExtra = { threadTs: message.thread_ts ?? message.ts };
    if (teamId !== undefined) {
        extra.teamId = teamId;
    }
    if (message.files !== undefined && message.files.length > 0) {
        extra.attachments = message.files.map(({ name, url_private }) => ({ name, url: url_private }));
    }
    let payload: ListenerMessage = {
        provider: "slack",
        type: "message",
        id: message.ts,
        channelId: message.channel,
        author: author ?? { id: message.bot_id ?? "unknown", name: message.username ?? "bot" },
        content: message.text ?? "",
        timestamp: tsToIso(message.ts),
        extra,
    };
    if (heard.thread !== undefined) {
        payload = { ...payload, thread: heard.thread };
    }
    if (heard.mentioned) {
        payload = { ...payload, mentioned: true };
    }
    if (heard.history.length > 0) {
        payload = { ...payload, history: [...heard.history] };
    }
    return payload;
};

// Reactions that stop the turn working on the request they are put on.
export const STOP_REACTIONS = new Set(["black_square_for_stop", "octagonal_sign", "stop_sign"]);
// How many answered requests a ⏹️ reaction can still find.
const REQUESTS_KEPT = 2_000;

// Where a conversation lives, as the gateway's memory keys it: a thread's ts is unique only within its channel.
export const placeOf = (channel: string, thread: string): string => `${channel}/${thread}`;

// A status card is the agent's status, not something it said, so the history the model reads leaves it out.
const isStatusCard = (message: SlackMessage): boolean => message.blocks?.[0]?.block_id === STATUS_BLOCK_ID;

export const welcomeText = (botId: string): string =>
    [
        "👋 Hi! I'm the agent from this team's Intentic sandbox.",
        `Mention <@${botId}> with a question or a task: I answer in its thread, show what I'm doing while I work, and anyone in the thread can steer me by replying, no mention needed.`,
    ].join("\n");

export interface SlackListener {
    readonly onEvent: (connection: SlackConnection, envelope: SlackEnvelope) => void;
}

// What the listener reads of an app's connector: how much of the agent's work its threads show.
export interface SlackListenerOptions {
    readonly progressOf: (connection: SlackConnection) => string | undefined;
    // How the work shows in a thread: the status card (the default) or Slack's own streamed task list.
    readonly styleOf?: (connection: SlackConnection) => string | undefined;
    readonly timing?: ReplyTiming;
}

// What was said before a message: the entries the model reads, and whether one of our apps spoke there.
interface Context {
    readonly history: ListenerHistoryEntry[];
    readonly participated: boolean;
}

export const createSlackListener = (
    ctx: GatewayCtx,
    connections: () => ReadonlyMap<string, SlackConnection>,
    options: SlackListenerOptions = { progressOf: () => undefined },
): SlackListener => {
    const recent = recentKeys();
    // Threads this process answered in, so a follow-up there is heard before our first post lands (after a restart,
    // our earlier posts in the thread say it instead), and the turns running now, for Stop and steered replies.
    const joined = joinedThreads();
    const runs = runRegistry();
    // Apps whose thread status Slack refused once ("is working…"), so it is not asked again for each reply.
    const statusRefused = new Set<string>();
    // Apps Slack refused a streamed message once, which show the status card from then on.
    const streamRefused = new Set<string>();
    // The requests this process answered, by "<channel>:<ts>", to where their conversation lives: a ⏹️ reaction on one
    // stops the turn working on it.
    const requests = new Map<string, string>();
    const rememberRequest = (channel: string, ts: string, place: string): void => {
        requests.set(`${channel}:${ts}`, place);
        const oldest = requests.size > REQUESTS_KEPT ? requests.keys().next().value : undefined;
        if (oldest !== undefined) {
            requests.delete(oldest);
        }
    };
    const refusable = (refused: Set<string>, connection: SlackConnection) => ({
        refused: () => refused.has(connection.appToken),
        refuse: () => void refused.add(connection.appToken),
    });
    // User id to display name, one lookup per user then cached for the process's life; a restart is a fine refresh.
    const names = new Map<string, string>();

    const selfIds = (): Set<string> => new Set([...connections().values()].map((connection) => connection.selfUserId));

    const resolveName = async (connection: SlackConnection, userId: string): Promise<string> => {
        const cached = names.get(userId);
        if (cached !== undefined) {
            return cached;
        }
        const info = await connection.web.users.info({ user: userId }).catch((error: unknown) => {
            // A name lookup must never drop a wake, the id is a worse label, not a missing one.
            ctx.log.warn({ err: error, userId }, "slack users.info failed");
            return undefined;
        });
        const name = info?.user?.profile?.display_name || info?.user?.real_name || info?.user?.name || userId;
        names.set(userId, name);
        return name;
    };

    // Whatever we can call the author without a round trip, bots have no user record to look up.
    const localName = (message: SlackMessage): string =>
        message.username ?? (message.user !== undefined ? (names.get(message.user) ?? message.user) : (message.bot_id ?? "unknown"));

    const contextOf = (raw: readonly SlackMessage[], order: "newest-first" | "oldest-first"): Context => {
        const ours = selfIds();
        return {
            history: toHistory(
                raw.filter((message) => !isStatusCard(message)),
                order,
                ours,
                localName,
            ),
            participated: raw.some((message) => ours.has(message.user ?? message.bot_id ?? "")),
        };
    };

    const fetchContext = async (connection: SlackConnection, message: SlackMessage, channel: string): Promise<Context | undefined> => {
        try {
            // In a thread the thread IS the context; in a channel it's what was said just before.
            if (message.thread_ts !== undefined) {
                const replies = await connection.web.conversations.replies({ channel, ts: message.thread_ts, limit: HISTORY_LIMIT });
                // SAFETY: conversations.replies answers messages in the shape the event payload delivers them.
                return contextOf((replies.messages ?? []) as SlackMessage[], "oldest-first");
            }
            const history = await connection.web.conversations.history({ channel, latest: message.ts, limit: HISTORY_LIMIT });
            // SAFETY: conversations.history answers messages in the shape the event payload delivers them.
            return contextOf((history.messages ?? []) as SlackMessage[], "newest-first");
        } catch (error) {
            // A history fetch failure must not drop the wake; degrade to no context instead.
            ctx.log.warn({ err: error }, "slack history fetch failed");
            return undefined;
        }
    };

    // Whether a message wakes anything at all: a channel message, not bookkeeping, not ours, not seen before.
    const admitted = (message: SlackMessage): message is SlackMessage & { readonly channel: string } => {
        if (message.channel === undefined || (message.subtype !== undefined && !WAKING_SUBTYPES.has(message.subtype))) {
            return false;
        }
        // Never wakes on our own apps' posts: a reply must not re-trigger, and app A must not wake on app B.
        if (message.user !== undefined && selfIds().has(message.user)) {
            return false;
        }
        return !recent.duplicate(`${message.channel}:${message.ts}`);
    };

    // Whether the message is for us, where its conversation lives, and what was said before it. 'Tagged': a mention or a
    // DM. In a thread, also one we answer in: this process's memory first, then our earlier posts in it, read from the
    // thread's history, fetched only when it matters.
    const hear = async (connection: SlackConnection, message: SlackMessage, channel: string): Promise<Heard> => {
        const text = message.text ?? "";
        const directlyTagged = [...selfIds()].some((id) => text.includes(`<@${id}>`)) || message.channel_type === "im";
        const context = directlyTagged || message.thread_ts !== undefined ? await fetchContext(connection, message, channel) : undefined;
        const answering = message.thread_ts !== undefined && (joined.has(placeOf(channel, message.thread_ts)) || context?.participated === true);
        const mentioned = directlyTagged || answering;
        return { mentioned, thread: threadOf(message, mentioned), history: context?.history ?? [] };
    };

    // The answer to a message addressed to us, made the moment it is heard so 👀 lands before the (debounced) turn
    // spins up.
    // A person stopping the turn working in a place, from somewhere that names the place rather than the conversation;
    // the daemon decides whether they may, and only they are told how it went.
    const stopAt = async (connection: SlackConnection, place: string, userId: string, told: { readonly channel: string; readonly thread: string }): Promise<boolean> => {
        const conversationId = runs.conversationAt(place);
        if (conversationId === undefined) {
            return false;
        }
        const shownAs = await resolveName(connection, userId);
        const text = await stopFromChat(ctx.daemon, runs, { conversationId, author: { id: userId, name: shownAs } }, shownAs, ctx.log);
        await connection.web.chat.postEphemeral({ channel: told.channel, user: userId, thread_ts: told.thread, text });
        return true;
    };

    const replyFor = (connection: SlackConnection, message: SlackMessage, channel: string, thread: string, teamId: string | undefined): ChatReply => {
        const place = placeOf(channel, thread);
        rememberRequest(channel, message.ts, place);
        const deps: SlackReplyDeps = {
            connection,
            log: ctx.log,
            detail: progressDetailOf(options.progressOf(connection)),
            style: statusStyleOf(options.styleOf?.(connection)),
            registry: runs,
            status: refusable(statusRefused, connection),
            streaming: refusable(streamRefused, connection),
        };
        const asker = message.user;
        return createSlackReply(options.timing === undefined ? deps : { ...deps, timing: options.timing }, {
            channel,
            messageTs: message.ts,
            thread,
            askerId: asker,
            teamId,
            place,
            onTaken: () => joined.add(place),
            // Slack's own stop on a streamed answer is the asker's: it is their stream.
            onStreamStopped: () => {
                if (asker !== undefined) {
                    stopAt(connection, place, asker, { channel, thread }).catch((error: Error) => ctx.log.warn({ err: error }, "slack: stopping a stopped stream's turn failed"));
                }
            },
        });
    };

    const onMessage = async (connection: SlackConnection, message: SlackMessage, teamId: string | undefined): Promise<void> => {
        if (!admitted(message)) {
            return;
        }
        const heard = await hear(connection, message, message.channel);
        const reply = heard.mentioned && heard.thread !== undefined ? replyFor(connection, message, message.channel, heard.thread, teamId) : undefined;
        const author = message.user === undefined ? undefined : { id: message.user, name: await resolveName(connection, message.user) };
        const payload = payloadOf(message, heard, author, teamId);
        if (reply === undefined) {
            await ctx.daemon.dispatch(payload);
            return;
        }
        try {
            await ctx.daemon.dispatchStreaming(payload, reply.frame);
        } finally {
            await reply.settle();
        }
    };

    // A status card's Stop: the daemon decides whether the presser may, by the automation's own sender rules, and the
    // presser alone is told how it went. "Open in Intentic" presses arrive here too, and need nothing but the ack.
    const onAction = async (connection: SlackConnection, action: SlackBlockActions): Promise<void> => {
        const conversationId = action.actions.map((each) => stopTarget(each.action_id)).find((id) => id !== undefined);
        if (conversationId === undefined) {
            return;
        }
        const shownAs = await resolveName(connection, action.user.id);
        const sentence = await stopFromChat(ctx.daemon, runs, { conversationId, author: { id: action.user.id, name: shownAs } }, shownAs, ctx.log);
        const channel = action.channel?.id;
        if (channel === undefined) {
            return;
        }
        const thread = action.message?.thread_ts ?? action.message?.ts;
        const told = { channel, user: action.user.id, text: sentence };
        await connection.web.chat.postEphemeral(thread === undefined ? told : { ...told, thread_ts: thread });
    };

    // Invited into a channel while the assistant is on: say hello there, so people know how to reach it.
    const onJoined = async (connection: SlackConnection, joinedEvent: SlackMemberJoined): Promise<void> => {
        if (joinedEvent.user !== connection.selfUserId || recent.duplicate(`joined:${joinedEvent.channel}:${joinedEvent.user}`)) {
            return;
        }
        // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Slack postMessage has no targetOrigin.
        await connection.web.chat.postMessage({ channel: joinedEvent.channel, text: welcomeText(connection.selfUserId) });
    };

    const onReaction = async (connection: SlackConnection, reaction: SlackReaction): Promise<void> => {
        if (reaction.item.type !== "message" || selfIds().has(reaction.user)) {
            return;
        }
        // ⏹️ on a request whose turn is running is a Stop, not news for an automation.
        const place = STOP_REACTIONS.has(reaction.reaction) ? requests.get(`${reaction.item.channel}:${reaction.item.ts}`) : undefined;
        const thread = place?.slice(place.indexOf("/") + 1);
        if (place !== undefined && thread !== undefined && (await stopAt(connection, place, reaction.user, { channel: reaction.item.channel, thread }))) {
            return;
        }
        // A reaction says "this message", which is useless without the message, so fetch the one it points at.
        const target = await connection.web.conversations
            .history({ channel: reaction.item.channel, latest: reaction.item.ts, inclusive: true, limit: 1 })
            .then((result) => (result.messages ?? [])[0] as SlackMessage | undefined)
            .catch((error: unknown) => {
                ctx.log.warn({ err: error }, "slack reaction target fetch failed");
                return undefined;
            });
        await ctx.daemon.dispatch({
            provider: "slack",
            type: "reaction_added",
            id: reaction.event_ts,
            channelId: reaction.item.channel,
            author: { id: reaction.user, name: await resolveName(connection, reaction.user) },
            content: target?.text ?? "",
            timestamp: tsToIso(reaction.event_ts),
            extra: { reaction: reaction.reaction, threadTs: target?.thread_ts ?? reaction.item.ts, messageTs: reaction.item.ts },
        });
    };

    const onEvents = async (connection: SlackConnection, body: SlackEventsBody): Promise<void> => {
        const event = body.event;
        if (event === undefined) {
            return;
        }
        // SAFETY: Slack names each event's shape by its `type`; the three cast below are the shapes those types carry.
        if (event.type === "reaction_added") {
            await onReaction(connection, event as SlackReaction);
            return;
        }
        if (event.type === "member_joined_channel") {
            await onJoined(connection, event as SlackMemberJoined);
            return;
        }
        // `app_mention` handled like `message`: Slack can send both; dedup drops whichever arrives second.
        if (event.type === "message" || event.type === "app_mention") {
            await onMessage(connection, event as SlackMessage, body.team_id);
        }
    };

    return {
        onEvent: (connection, envelope) => {
            // Ack first, unconditionally: an unacked envelope is redelivered, even one we chose not to wake on.
            void envelope.ack().catch((error: unknown) => ctx.log.warn({ err: error }, "slack ack failed"));
            const { body } = envelope;
            if (envelope.type === "interactive" && "actions" in body && body.type === "block_actions") {
                onAction(connection, body).catch((error: Error) => ctx.log.warn({ err: error }, "slack stop failed"));
                return;
            }
            if (envelope.type === "events_api" && !("actions" in body)) {
                onEvents(connection, body).catch((error: Error) => ctx.log.error({ err: error }, "slack event dispatch failed"));
            }
        },
    };
};
