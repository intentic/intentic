import {
    type ChatReply,
    type ChatSurface,
    createChatReply,
    type Logger,
    MESSAGE_LIMITS,
    type ProgressDetail,
    type ReplyMark,
    type ReplyRegistry,
    type ReplyTiming,
    REPLY_TIMING,
    tablesToCode,
} from "@intentic/connector-runtime";
import { renderCard } from "./card.js";
import { addThreadMember, type DiscordRest, editMessage, type MessageBody, NO_PINGS, postMessage, react, startThread, typing, unreact } from "./discord-rest.js";
import type { Route } from "./inbound.js";

// One addressed message's answer in Discord. What happens when (the mark the moment it is heard, the status card once the
// work outlasts a quick answer, narration on the card and the answer below it, how it ended) is the shared chat reply
// (connector-runtime's createChatReply); this file is what it looks like in Discord: emoji reactions, "typing…", a
// thread opened from the message only once something answers (so a message no automation takes leaves no empty
// thread), the card as an embed, and, where no thread can be opened, a first reply that quotes the message it answers.

export { isNarration, LOST_NOTICE, REPLY_TIMING, type ReplyRegistry, type ReplyTiming, type RunControl } from "@intentic/connector-runtime";

const DISCORD_MAX = MESSAGE_LIMITS.discord;

export const EMOJI = { heard: "👀", done: "✅", failed: "❌", held: "✋", queued: "⏳", stopped: "⏹️" } as const satisfies Record<ReplyMark, string>;

export interface ReplyDeps {
    readonly rest: DiscordRest;
    readonly log: Logger;
    readonly detail: ProgressDetail;
    readonly registry: ReplyRegistry;
    // Remembers a thread the bot answered in, so its follow-ups are heard without a mention.
    readonly joined: (threadId: string) => void;
    readonly timing?: ReplyTiming;
}

export interface ReplyTarget {
    // The message being answered, and the room it was posted in.
    readonly messageId: string;
    readonly channelId: string;
    readonly authorId: string;
    readonly route: Route;
}

export type MessageReply = ChatReply;

// A card lives in the room it was posted in, whatever the reply's room becomes after it.
interface PostedCard {
    readonly room: string;
    readonly id: string;
}

export const createMessageReply = (deps: ReplyDeps, target: ReplyTarget): MessageReply => {
    const timing = deps.timing ?? REPLY_TIMING;
    const { rest, log } = deps;
    const { route } = target;
    // Where replies go: the thread once it is open, else the room the route names. In a channel with no thread, the
    // first reply quotes the message it answers.
    let room = route.room;
    let quoteFirst = route.opens === undefined && route.thread === undefined && route.room === target.channelId;

    const prepare = async (): Promise<void> => {
        const opens = route.opens;
        if (opens === undefined) {
            if (route.thread !== undefined) {
                deps.joined(route.thread);
            }
            return;
        }
        try {
            room = await startThread(rest, opens.parentId, opens.messageId, opens.name);
            quoteFirst = false;
            deps.joined(room);
        } catch (error) {
            // A channel that refuses threads (no permission, a type without them) still gets its answer, quoted.
            log.warn({ err: error }, "discord reply: could not open a thread, answering in the channel");
            quoteFirst = true;
            return;
        }
        // In the thread, the asker sees it in their list and hears what is said there.
        await addThreadMember(rest, room, target.authorId).catch((error: Error) => log.warn({ err: error }, "discord reply: could not add the asker to the thread"));
    };

    const surface: ChatSurface<PostedCard> = {
        maxChars: DISCORD_MAX,
        mentionCost: target.authorId.length + 5,
        format: tablesToCode,
        prepare,
        post: async (chunk, { mention }) => {
            const body: MessageBody = {
                content: mention ? `<@${target.authorId}> ${chunk}` : chunk,
                allowed_mentions: mention ? { parse: [], users: [target.authorId] } : NO_PINGS,
            };
            await postMessage(rest, room, quoteFirst ? { ...body, message_reference: { message_id: target.messageId, fail_if_not_exists: false } } : body);
            quoteFirst = false;
        },
        postCard: async (view) => ({ room, id: await postMessage(rest, room, renderCard(view)) }),
        editCard: (card, view) => editMessage(rest, card.room, card.id, renderCard(view)),
        mark: (message, mark) => react(rest, message.channelId, message.id, EMOJI[mark]),
        unmark: (message, mark) => unreact(rest, message.channelId, message.id, EMOJI[mark]),
        // Discord drops "typing…" after about ten seconds, or as soon as the bot posts.
        typing: { say: () => typing(rest, room), everyMs: timing.typingEveryMs },
    };
    return createChatReply(
        { provider: "discord", surface, log, detail: deps.detail, registry: deps.registry, timing },
        { message: { channelId: target.channelId, id: target.messageId }, place: route.thread ?? route.room },
    );
};
