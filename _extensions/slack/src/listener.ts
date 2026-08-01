import type { GatewayCtx } from "./context.js";
import type { SlackConnection } from "./client.js";
import { createSlackStream, type Painter } from "./stream.js";

/* The inbound half of the gateway: every Socket Mode envelope a connected app receives becomes a normalized
 * listener message POSTed to the daemon's dispatch route. On a mention we hold the streaming response and paint
 * the model's reply into the thread live (one painter per matched automation, keyed by automationId).
 *
 * Slack has no bot typing indicator, so the "I'm on it" signal is an :eyes: reaction on the triggering message,
 * added the moment we're tagged and removed when the turn ends — the same job ext-discord's typing heartbeat
 * does, in the gesture Slack actually has. */

// Recent `channel:ts` keys, to drop the duplicate delivery when two of our apps share a channel, and the
// message/app_mention double-delivery Slack sends when a manifest subscribes to both.
// ponytail: best-effort in-memory cap; a restart forgets it — at worst one duplicate wake.
const RECENT_MAX = 500;
// Prior messages pulled for context when the bot is tagged.
const HISTORY_LIMIT = 20;
// The "working on it" reaction. A name, not an emoji — Slack's reactions API is keyed by shortcode.
const ACK_REACTION = "eyes";

/* Message subtypes worth waking on. A Slack channel event stream is mostly bookkeeping — joins, leaves, topic
 * and purpose changes, pins, edits, deletions, huddle notices — and every one of those would otherwise fire an
 * automation. An allowlist rather than a denylist because Slack keeps adding subtypes, and the failure mode of
 * guessing wrong is an agent woken by someone joining a channel. `bot_message` IS here: a third-party bot's CI
 * alert is a legitimate trigger (our own apps' posts are dropped by author below, not by subtype). */
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

// One `slack_event` envelope, narrowed to what this gateway reads. `ack` MUST be called for every envelope or
// Slack redelivers it three times and then drops the app's socket.
export interface SlackEnvelope {
    readonly ack: () => Promise<void>;
    readonly type: string;
    readonly body: { readonly event?: SlackMessage | SlackReaction; readonly team_id?: string };
}

// A Slack `ts` ("1755102030.001900") is epoch seconds with a microsecond fraction.
export const tsToIso = (ts: string): string => new Date(Number(ts) * 1000).toISOString();

// Chronological history entries from raw Slack messages, flagging posts by our own apps so the model recognizes
// its prior replies. `order` says which way the API handed them over: conversations.history is newest-first,
// conversations.replies is oldest-first. Exported for tests.
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

export interface SlackListener {
    readonly onEvent: (connection: SlackConnection, envelope: SlackEnvelope) => void;
}

export const createSlackListener = (ctx: GatewayCtx, connections: () => ReadonlyMap<string, SlackConnection>): SlackListener => {
    const recent = new Set<string>();
    // Slack events carry a user ID and nothing else; the model needs a name. One lookup per user, then cached
    // for the life of the process — display names change rarely enough that a restart is a fine refresh.
    const names = new Map<string, string>();

    const selfIds = (): Set<string> => new Set([...connections().values()].map((connection) => connection.selfUserId));

    const resolveName = async (connection: SlackConnection, userId: string): Promise<string> => {
        const cached = names.get(userId);
        if (cached !== undefined) {
            return cached;
        }
        const info = await connection.web.users.info({ user: userId }).catch((error: unknown) => {
            // A name lookup must never drop a wake — the id is a worse label, not a missing one.
            ctx.log.warn({ err: error, userId }, "slack users.info failed");
            return undefined;
        });
        const name = info?.user?.profile?.display_name || info?.user?.real_name || info?.user?.name || userId;
        names.set(userId, name);
        return name;
    };

    // Whatever we can call the author without a round trip — bots have no user record to look up.
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
            // A history fetch failure (the bot isn't in the channel, a missing scope, a rate limit) must not drop
            // the wake — degrade to no context.
            ctx.log.warn({ err: error }, "slack history fetch failed");
            return undefined;
        }
    };

    // The :eyes: acknowledgement. Both halves are best-effort: already_reacted / no_reaction are ordinary races
    // (two apps in one channel, a turn that finished before the add landed), not failures worth logging.
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
        // Never wake on our own apps' posts — an agent reply in-channel must not re-trigger, and app A must not
        // wake on app B. Third-party bots still dispatch; guards can filter them.
        if (message.user !== undefined && ours.has(message.user)) {
            return;
        }
        const key = `${channel}:${message.ts}`;
        if (recent.has(key)) {
            return;
        }
        recent.add(key);
        if (recent.size > RECENT_MAX) {
            const oldest = recent.values().next().value;
            if (oldest !== undefined) {
                recent.delete(oldest);
            }
        }

        const text = message.text ?? "";
        // "Tagged": an @mention of any of our bots, or a DM — where every message is addressed to us. A thread
        // the bot is already in counts too, so a follow-up in its own reply thread doesn't need re-tagging;
        // that's decided from the history below, which we only fetch when it might matter.
        const directlyTagged = [...ours].some((id) => text.includes(`<@${id}>`)) || message.channel_type === "im";
        const threaded = message.thread_ts !== undefined;
        const history = directlyTagged || threaded ? await fetchHistory(connection, message, channel) : undefined;
        const mentioned = directlyTagged || (threaded && history !== undefined && history.some((entry) => entry.self === true));
        if (mentioned) {
            // Immediate feedback: show we've seen it before the (debounced) turn spins up.
            await react(connection, channel, message.ts, true);
        }

        const author = message.user !== undefined ? { id: message.user, name: await resolveName(connection, message.user) } : undefined;
        const payload = {
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
                // The reply target — a mention inside a thread continues that thread, a top-level one opens one.
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
        // Paint the reply into the thread live. Each matched automation gets its own painter, so two automations
        // answering one mention don't scribble over each other's message.
        const threadTs = message.thread_ts ?? message.ts;
        const painters = new Map<string, Painter>();
        const onError = (error: unknown): void => ctx.log.warn({ err: error }, "slack stream paint failed");
        try {
            await ctx.daemon.dispatchStreaming(payload, (frame) => {
                let painter = painters.get(frame.automationId);
                if (painter === undefined) {
                    painter = createSlackStream(
                        {
                            post: async (body) => {
                                // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Slack's chat.postMessage, not window.postMessage; there is no targetOrigin to pass
                                const posted = await connection.web.chat.postMessage({ channel, thread_ts: threadTs, text: body });
                                if (posted.ts === undefined) {
                                    throw new Error("slack chat.postMessage returned no ts");
                                }
                                return posted.ts;
                            },
                            update: (ts, body) => connection.web.chat.update({ channel, ts, text: body }),
                        },
                        onError,
                    );
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
            // The turn(s) ended (or the stream broke) — the reply is there, so retire the acknowledgement.
            await react(connection, channel, message.ts, false);
        }
    };

    const onReaction = async (connection: SlackConnection, reaction: SlackReaction): Promise<void> => {
        if (reaction.item.type !== "message" || selfIds().has(reaction.user)) {
            return;
        }
        // A reaction says "this message" — which is useless without the message, so fetch the one it points at.
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
            // Ack FIRST and unconditionally: an unacked envelope is redelivered, and a wake we chose not to fire
            // is still an envelope we handled.
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
                // `app_mention` is normalized as a message: Slack delivers BOTH for a mention when a manifest
                // subscribes to both, and the recent-key dedup drops whichever arrives second. Handling them
                // identically is what makes either manifest work without double-firing.
                if (event.type === "message" || event.type === "app_mention") {
                    await onMessage(connection, event as SlackMessage, envelope.body.team_id);
                }
            })().catch((error: unknown) => ctx.log.error({ err: error }, "slack event dispatch failed"));
        },
    };
};
