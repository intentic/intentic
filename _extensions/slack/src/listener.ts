import { createStreamingPainter, failureNotice, framePainter, type GatewayCtx, GatewayRefusal, type ListenerMessage, recentKeys } from "@intentic/connector-runtime";
import type { SlackConnection } from "./client.js";

// Inbound half of the gateway: every Socket Mode envelope becomes a normalized message posted to the daemon's dispatch
// route. On a mention, holds the streaming response and paints the reply into the thread live, one painter per
// automation. :eyes: is Slack's stand-in for a typing indicator, added on tag and removed at turn end.

// Slack truncates messages beyond ~4000 chars; a longer reply spills into follow-up messages in the thread.
const SLACK_MAX = 3_800;
// Min gap between edits; chat.update is rate-limited, and :eyes: covers the gap until the first paint.
const EDIT_INTERVAL_MS = 1_500;
// Recent `channel:ts` keys dedupe shared channels and message+app_mention double-delivery; lost on restart.
const RECENT_MAX = 500;
// Prior messages pulled for context when the bot is tagged.
const HISTORY_LIMIT = 20;
// 'Working on it' reaction name (not an emoji); Slack's reactions API is keyed by shortcode.
const ACK_REACTION = "eyes";

// Allowlist, not denylist: Slack keeps adding bookkeeping subtypes; third-party `bot_message` can trigger us.
const WAKING_SUBTYPES = new Set(["file_share", "thread_broadcast", "bot_message"]);

interface HistoryEntry {
    author: { id: string; name: string };
    content: string;
    timestamp: string;
    self?: boolean;
}

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
}

export interface SlackReaction {
    readonly type: "reaction_added";
    readonly user: string;
    readonly reaction: string;
    readonly item: { type: string; channel: string; ts: string };
    readonly event_ts: string;
}

// One `slack_event` envelope, narrowed to what this gateway reads; `ack` must be called for every one or Slack
// redelivers it three times, then drops the socket.
export interface SlackEnvelope {
    readonly ack: () => Promise<void>;
    readonly type: string;
    readonly body: { readonly event?: SlackMessage | SlackReaction; readonly team_id?: string };
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
): HistoryEntry[] =>
    (order === "newest-first" ? messages.toReversed() : [...messages]).map((message) => {
        const id = message.user ?? message.bot_id ?? "";
        const entry: HistoryEntry = {
            author: { id, name: nameOf(message) },
            content: message.text ?? "",
            timestamp: tsToIso(message.ts),
        };
        if (selfIds.has(id)) {
            entry.self = true;
        }
        return entry;
    });

// Posts into a channel outside any live turn (the daemon's speak-as-the-agent path), top-level since only the channel
// was recorded. Tries the next app only if nothing posted yet, so a partial spill is never duplicated.
export const deliverToChannel = async (connections: ReadonlyMap<string, SlackConnection>, channel: string, text: string): Promise<void> => {
    let refusal: unknown = new GatewayRefusal("no Slack app is connected");
    for (const connection of connections.values()) {
        let posted = false;
        try {
            for (let base = 0; base < text.length; base += SLACK_MAX) {
                // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Slack's chat.postMessage, not window.postMessage; there is no targetOrigin to pass
                await connection.web.chat.postMessage({ channel, text: text.slice(base, base + SLACK_MAX) });
                posted = true;
            }
            return;
        } catch (error) {
            if (posted) {
                throw error;
            }
            refusal = error;
        }
    }
    throw refusal;
};

export interface SlackListener {
    readonly onEvent: (connection: SlackConnection, envelope: SlackEnvelope) => void;
}

export const createSlackListener = (ctx: GatewayCtx, connections: () => ReadonlyMap<string, SlackConnection>): SlackListener => {
    const recent = recentKeys(RECENT_MAX);
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

    const fetchHistory = async (connection: SlackConnection, message: SlackMessage, channel: string): Promise<HistoryEntry[] | undefined> => {
        try {
            // In a thread the thread IS the context; in a channel it's what was said just before.
            if (message.thread_ts !== undefined) {
                const replies = await connection.web.conversations.replies({ channel, ts: message.thread_ts, limit: HISTORY_LIMIT });
                return toHistory((replies.messages ?? []) as SlackMessage[], "oldest-first", selfIds(), localName);
            }
            const history = await connection.web.conversations.history({ channel, latest: message.ts, limit: HISTORY_LIMIT });
            return toHistory((history.messages ?? []) as SlackMessage[], "newest-first", selfIds(), localName);
        } catch (error) {
            // A history fetch failure must not drop the wake; degrade to no context instead.
            ctx.log.warn({ err: error }, "slack history fetch failed");
            return undefined;
        }
    };

    // :eyes: acknowledgement; both add/remove are best-effort, since already_reacted/no_reaction are ordinary races,
    // not failures worth logging.
    const react = async (connection: SlackConnection, channel: string, ts: string, on: boolean): Promise<void> => {
        const args = { channel, timestamp: ts, name: ACK_REACTION };
        if (on) {
            await connection.web.reactions.add(args).catch(() => undefined);
            return;
        }
        await connection.web.reactions.remove(args).catch(() => undefined);
    };

    const onMessage = async (connection: SlackConnection, message: SlackMessage, teamId: string | undefined): Promise<void> => {
        const channel = message.channel;
        if (channel === undefined) {
            return;
        }
        if (message.subtype !== undefined && !WAKING_SUBTYPES.has(message.subtype)) {
            return;
        }
        const ours = selfIds();
        // Never wakes on our own apps' posts: a reply must not re-trigger, and app A must not wake on app B.
        if (message.user !== undefined && ours.has(message.user)) {
            return;
        }
        const key = `${channel}:${message.ts}`;
        if (recent.duplicate(key)) {
            return;
        }

        const text = message.text ?? "";
        // 'Tagged': a mention, a DM, or a joined thread; the last reads from history, fetched only when it matters.
        const directlyTagged = [...ours].some((id) => text.includes(`<@${id}>`)) || message.channel_type === "im";
        const threaded = message.thread_ts !== undefined;
        const history = directlyTagged || threaded ? await fetchHistory(connection, message, channel) : undefined;
        const mentioned = directlyTagged || (threaded && history !== undefined && history.some((entry) => entry.self === true));
        if (mentioned) {
            // Immediate feedback: show we've seen it before the (debounced) turn spins up.
            await react(connection, channel, message.ts, true);
        }

        const author = message.user !== undefined ? { id: message.user, name: await resolveName(connection, message.user) } : undefined;
        const payload: ListenerMessage = {
            provider: "slack",
            type: "message",
            id: message.ts,
            channelId: channel,
            author: author ?? { id: message.bot_id ?? "unknown", name: message.username ?? "bot" },
            content: text,
            ...(mentioned ? { mentioned: true } : {}),
            ...(history !== undefined && history.length > 0 ? { history } : {}),
            timestamp: tsToIso(message.ts),
            extra: {
                // Reply target: a threaded mention continues that thread; a top-level one opens a new one.
                threadTs: message.thread_ts ?? message.ts,
                ...(teamId !== undefined ? { teamId } : {}),
                ...(message.files !== undefined && message.files.length > 0
                    ? { attachments: message.files.map(({ name, url_private }) => ({ name, url: url_private })) }
                    : {}),
            },
        };

        if (!mentioned) {
            await ctx.daemon.dispatch(payload);
            return;
        }
        // One painter per matched automation (framePainter), so two automations answering one mention don't collide.
        const threadTs = message.thread_ts ?? message.ts;
        const onError = (error: unknown): void => ctx.log.warn({ err: error }, "slack stream paint failed");
        const poster = {
            post: async (body: string): Promise<string> => {
                // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Slack's chat.postMessage, not window.postMessage; there is no targetOrigin to pass
                const posted = await connection.web.chat.postMessage({ channel, thread_ts: threadTs, text: body });
                if (posted.ts === undefined) {
                    throw new Error("slack chat.postMessage returned no ts");
                }
                return posted.ts;
            },
            update: (ts: string, body: string) => connection.web.chat.update({ channel, ts, text: body }),
        };
        try {
            await ctx.daemon.dispatchStreaming(
                payload,
                framePainter(
                    () => createStreamingPainter(poster, onError, { maxChars: SLACK_MAX, editIntervalMs: EDIT_INTERVAL_MS }),
                    // Posted directly, not through the painter, which owns reply text; a failed turn usually has none
                    // to flush.
                    (reason) => void poster.post(failureNotice(reason, SLACK_MAX)).catch(onError),
                ),
            );
        } finally {
            // The turn(s) ended (or the stream broke), the reply is there, so retire the acknowledgement.
            await react(connection, channel, message.ts, false);
        }
    };

    const onReaction = async (connection: SlackConnection, reaction: SlackReaction): Promise<void> => {
        if (reaction.item.type !== "message" || selfIds().has(reaction.user)) {
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

    return {
        onEvent: (connection, envelope) => {
            // Ack first, unconditionally: an unacked envelope is redelivered, even one we chose not to wake on.
            void envelope.ack().catch((error: unknown) => ctx.log.warn({ err: error }, "slack ack failed"));
            if (envelope.type !== "events_api") {
                return;
            }
            const event = envelope.body.event;
            if (event === undefined) {
                return;
            }
            void (async () => {
                if (event.type === "reaction_added") {
                    await onReaction(connection, event as SlackReaction);
                    return;
                }
                // `app_mention` handled like `message`: Slack can send both; dedup drops whichever arrives second.
                if (event.type === "message" || event.type === "app_mention") {
                    await onMessage(connection, event as SlackMessage, envelope.body.team_id);
                }
            })().catch((error: unknown) => ctx.log.error({ err: error }, "slack event dispatch failed"));
        },
    };
};
