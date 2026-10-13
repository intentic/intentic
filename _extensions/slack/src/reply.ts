import {
    type ChatReply,
    type ChatReplyDeps,
    type CardView,
    type ChatSurface,
    createChatReply,
    type Logger,
    MESSAGE_LIMITS,
    type ProgressDetail,
    type ReplyMark,
    type ReplyRegistry,
    type ReplyTiming,
    statusCardOf,
} from "@intentic/connector-runtime";
import { type ChatStopStreamArguments, WebAPIPlatformError } from "@slack/web-api";
import { renderCard, type SlackBlock } from "./card.js";
import type { SlackConnection } from "./client.js";
import { streamChunks, type StreamShown, streamShown } from "./stream.js";

// One addressed message's answer in Slack. What happens when (the mark the moment it is heard, the status card once the
// work outlasts a quick answer, narration on the card and the answer below it, how it ended) is the shared chat reply
// (connector-runtime's createChatReply), the same as Discord's; this file is what it looks like in Slack: reactions by
// shortcode, Slack's own "is working…" status in the thread, the card as Block Kit, and the answer as Markdown blocks,
// which Slack renders as written (headings, lists, code with its language, tables) rather than as its own mrkdwn.

const SLACK_MAX = MESSAGE_LIMITS.slack;

// Slack's reactions API takes a shortcode, not the emoji.
export const REACTIONS = {
    heard: "eyes",
    done: "white_check_mark",
    failed: "x",
    held: "raised_hand",
    queued: "hourglass_flowing_sand",
    stopped: "black_square_for_stop",
} as const satisfies Record<ReplyMark, string>;

// What the thread's status line says while the agent works ("intentic is working on it…").
export const WORKING_STATUS = "is working on it…";
// Slack clears the status after two minutes, and whenever the app posts; it is set again on this cadence.
const STATUS_EVERY_MS = 30_000;

// The code Slack answered a call with ("already_reacted", "not_allowed"), for a call Slack itself refused.
export const slackErrorCode = (error: Error): string | undefined => (error instanceof WebAPIPlatformError ? error.data.error : undefined);

// Codes that say the thread status will never work for this app, so it stops asking.
const STATUS_REFUSALS = new Set(["not_allowed", "not_allowed_token_type", "missing_scope", "unknown_method", "method_deprecated", "feature_not_enabled"]);

// An agent quoting `<!channel>` from a log must not page a whole channel: broadcasts and group pings become their words.
export const withoutBroadcasts = (text: string): string =>
    text
        .replaceAll(/<!(channel|here|everyone)(?:\|[^>]*)?>/g, "@$1")
        .replaceAll(/<!subteam\^[A-Z0-9]+(?:\|([^>]*))?>/g, (_, label: string | undefined) => label ?? "@group");

// A switch Slack can refuse once and for good, remembered per app so it is not asked again for each reply.
export interface Refusable {
    readonly refused: () => boolean;
    readonly refuse: () => void;
}

// How the work shows: a status card edited in place, or Slack's own streamed message with its task list.
export type StatusStyle = "card" | "native";

export const statusStyleOf = (value: string | undefined): StatusStyle => (value === "native" ? "native" : "card");

export interface SlackReplyDeps {
    readonly connection: SlackConnection;
    readonly log: Logger;
    readonly detail: ProgressDetail;
    readonly style: StatusStyle;
    readonly registry: ReplyRegistry;
    // Whether this app's thread status ("is working…") is known not to work.
    readonly status: Refusable;
    // Whether Slack refused this app a streamed message, so the card is drawn instead.
    readonly streaming: Refusable;
    readonly timing?: ReplyTiming;
}

export interface SlackReplyTarget {
    readonly channel: string;
    // The message being answered, and the thread its conversation lives in (its own ts, for a top-level mention).
    readonly messageTs: string;
    readonly thread: string;
    // Who asked, named in the answer to a long-running request so they hear it finished, and their workspace: a stream
    // in a channel is addressed to them.
    readonly askerId: string | undefined;
    readonly teamId: string | undefined;
    readonly place: string;
    // Runs once an automation takes the message, so the thread's follow-ups are heard without a mention.
    readonly onTaken: () => void;
    // Someone stopped the streamed answer with Slack's own stop: the turn behind it should stop too.
    readonly onStreamStopped?: () => void;
}

// Codes that say this app gets no streamed messages at all (an older workspace, a channel kind streams do not reach).
const STREAM_REFUSALS = new Set([
    "not_allowed",
    "not_allowed_token_type",
    "missing_scope",
    "unknown_method",
    "method_deprecated",
    "feature_not_enabled",
    "missing_recipient_user_id",
    "missing_recipient_team_id",
    "channel_type_not_supported",
    "invalid_chunks",
]);
// Codes that say the stream itself is over: stopped by a person in Slack, or no longer streaming.
const STREAM_ENDED = new Set(["stopped_by_user", "message_not_in_streaming_state"]);

// A status shown on its message: a card edited in place, or a stream appended to until it is stopped.
type Shown = { readonly kind: "card"; readonly ts: string } | { readonly kind: "stream"; readonly ts: string; readonly shown: StreamShown };

// What every reply message carries: no link previews, which would bury a short answer under a card for each URL it cites.
const QUIET = { unfurl_links: false, unfurl_media: false } as const;

export const createSlackReply = (deps: SlackReplyDeps, target: SlackReplyTarget): ChatReply => {
    const { web } = deps.connection;
    const { channel, thread, askerId } = target;
    // Benign races: a reaction already there, or already gone.
    const ignoring =
        (code: string) =>
        (error: Error): void => {
            if (slackErrorCode(error) !== code) {
                throw error;
            }
        };
    const setStatus = async (status: string): Promise<void> => {
        await web.assistant.threads.setStatus({ channel_id: channel, thread_ts: thread, status }).catch((error: Error) => {
            const code = slackErrorCode(error);
            if (code === undefined || !STATUS_REFUSALS.has(code)) {
                throw error;
            }
            deps.status.refuse();
        });
    };
    // The stream the answer goes into while it is open; a reply without one posts its answer as messages of its own.
    let streaming: { readonly ts: string } | undefined;
    // A stream that ended on Slack's side takes nothing more; one a person stopped asks for the turn to stop.
    const streamCall = async <T>(call: () => Promise<T>): Promise<boolean> => {
        try {
            await call();
            return true;
        } catch (error) {
            const code = error instanceof Error ? slackErrorCode(error) : undefined;
            if (code === undefined || !STREAM_ENDED.has(code)) {
                throw error;
            }
            streaming = undefined;
            if (code === "stopped_by_user") {
                target.onStreamStopped?.();
            }
            return false;
        }
    };
    const postCard = async (view: CardView): Promise<Shown> => {
        // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Slack postMessage has no targetOrigin.
        const posted = await web.chat.postMessage({ channel, thread_ts: thread, ...renderCard(view), ...QUIET });
        if (posted.ts === undefined) {
            throw new Error("slack chat.postMessage returned no ts for the status card");
        }
        return { kind: "card", ts: posted.ts };
    };
    // A request that waits (for approval, behind another) shows the card: a stream left open while it waits reads as
    // stuck. Work under way streams, unless Slack refuses this app streams, when it falls back to the card for good.
    const startStream = async (view: CardView): Promise<Shown | undefined> => {
        if (deps.style !== "native" || deps.streaming.refused() || statusCardOf(view).state !== "working") {
            return undefined;
        }
        const shown = streamShown();
        const recipient = askerId === undefined || target.teamId === undefined ? {} : { recipient_user_id: askerId, recipient_team_id: target.teamId };
        try {
            const started = await web.chat.startStream({ channel, thread_ts: thread, task_display_mode: "plan", chunks: streamChunks(view, shown), ...recipient });
            if (started.ts === undefined) {
                throw new Error("slack chat.startStream returned no ts");
            }
            streaming = { ts: started.ts };
            return { kind: "stream", ts: started.ts, shown };
        } catch (error) {
            const code = error instanceof Error ? slackErrorCode(error) : undefined;
            if (code === undefined || !STREAM_REFUSALS.has(code)) {
                throw error;
            }
            deps.log.warn({ code }, "slack: streamed messages refused for this app, showing the status card instead");
            deps.streaming.refuse();
            return undefined;
        }
    };
    const editStream = async (ts: string, shown: StreamShown, view: CardView): Promise<void> => {
        if (streaming?.ts !== ts) {
            return;
        }
        const chunks = streamChunks(view, shown);
        if (!view.progress.ended) {
            if (chunks.length > 0) {
                await streamCall(() => web.chat.appendStream({ channel, ts, chunks }));
            }
            return;
        }
        // The finished stream keeps the link to the conversation under the answer.
        let stop: ChatStopStreamArguments = { channel, ts };
        if (chunks.length > 0) {
            stop = { ...stop, chunks };
        }
        const link = statusCardOf(view).link;
        if (link !== undefined) {
            stop = { ...stop, blocks: [{ type: "actions", elements: [{ type: "button", action_id: "intentic:open", text: { type: "plain_text", text: "Open in Intentic" }, url: link }] }] };
        }
        streaming = undefined;
        await web.chat.stopStream(stop).catch((error: Error) => {
            const code = slackErrorCode(error);
            if (code === undefined || !STREAM_ENDED.has(code)) {
                throw error;
            }
        });
    };
    const surface: ChatSurface<Shown> = {
        maxChars: SLACK_MAX,
        format: withoutBroadcasts,
        post: async (chunk, { mention }) => {
            const named = mention && askerId !== undefined;
            const open = streaming;
            if (open !== undefined) {
                const text = named ? `<@${askerId}> ${chunk}` : chunk;
                if (await streamCall(() => web.chat.appendStream({ channel, ts: open.ts, chunks: [{ type: "markdown_text", text }] }))) {
                    return;
                }
            }
            const blocks: SlackBlock[] = [{ type: "markdown", text: chunk }];
            if (named) {
                blocks.unshift({ type: "section", text: { type: "mrkdwn", text: `<@${askerId}>` } });
            }
            // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Slack postMessage has no targetOrigin.
            await web.chat.postMessage({ channel, thread_ts: thread, text: chunk, blocks, ...QUIET });
        },
        postCard: async (view) => (await startStream(view)) ?? (await postCard(view)),
        editCard: async (shown, view) => {
            if (shown.kind === "stream") {
                await editStream(shown.ts, shown.shown, view);
                return;
            }
            await web.chat.update({ channel, ts: shown.ts, ...renderCard(view) });
        },
        mark: async (message, mark) => {
            await web.reactions.add({ channel: message.channelId, timestamp: message.id, name: REACTIONS[mark] }).catch(ignoring("already_reacted"));
        },
        unmark: async (message, mark) => {
            await web.reactions.remove({ channel: message.channelId, timestamp: message.id, name: REACTIONS[mark] }).catch(ignoring("no_reaction"));
        },
        typing: {
            say: async () => {
                if (!deps.status.refused()) {
                    await setStatus(WORKING_STATUS);
                }
            },
            everyMs: STATUS_EVERY_MS,
            // Posting clears it, but a status set after the last post (a turn that ended without one) would linger.
            clear: async () => {
                if (!deps.status.refused()) {
                    await setStatus("");
                }
            },
        },
    };
    const replyDeps: ChatReplyDeps<Shown> = { provider: "slack", surface, log: deps.log, detail: deps.detail, registry: deps.registry };
    return createChatReply(deps.timing === undefined ? replyDeps : { ...replyDeps, timing: deps.timing }, {
        message: { channelId: channel, id: target.messageTs },
        place: target.place,
        onTaken: target.onTaken,
    });
};
