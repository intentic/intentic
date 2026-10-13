import { ChannelType, type Message } from "discord.js";

// Where a Discord message belongs and whether it is for us, decided before anything is dispatched: the room an
// automation's channel filter names, the thread its conversation lives in, where a reply goes right now, and whether a
// thread has to be opened for it. A mention in a channel opens a thread of its own (named after the message, carrying
// the message's id, which Discord gives every thread started from a message), so each request is one conversation and
// the channel stays readable; a message in a thread we opened, or have answered in, needs no mention to be heard.

// The parts of a message the decision reads, so it can be judged without a client.
export interface IncomingMessage {
    readonly id: string;
    readonly channelId: string;
    readonly content: string;
    readonly authorName: string;
    // An @mention of one of our bots, or a reply to one of them.
    readonly mentionsUs: boolean;
    readonly channel:
        | { readonly kind: "dm" }
        | { readonly kind: "thread"; readonly parentId: string | null; readonly ownerId: string | null }
        // A channel a thread can be started in from a message (text, announcement).
        | { readonly kind: "threadable" }
        // Anywhere else a message can be: a voice channel's chat, a stage.
        | { readonly kind: "other" };
}

export interface Route {
    readonly addressed: boolean;
    // What an automation's channel filter names: for a message in a thread, the channel the thread hangs off.
    readonly channelId: string;
    // The thread the conversation lives in, existing or about to be opened.
    readonly thread?: string;
    // Where a reply can be posted right now.
    readonly room: string;
    // The thread to open before the first reply, when a mention in a channel needs one.
    readonly opens?: { readonly parentId: string; readonly messageId: string; readonly name: string };
}

export interface OurSide {
    readonly botIds: ReadonlySet<string>;
    // Whether we answered in this thread before (this process's memory; an owned thread needs none).
    readonly joined: (threadId: string) => boolean;
}

// Discord's ceiling on a thread name.
const THREAD_NAME_MAX = 100;
// What a thread is called is a glance at what was asked; past this it is cut at a word.
const THREAD_NAME_WANTED = 80;

// A thread's name, from the message that opened it: its first line, with mentions, emoji codes and markup taken out, cut
// at a word; the asker's name when nothing readable is left.
export const threadNameOf = (content: string, authorName: string): string => {
    const firstLine =
        content
            .replaceAll(/<(@[!&]?|#)\d+>/g, " ")
            .replaceAll(/<a?:\w+:\d+>/g, " ")
            .split("\n")
            .map((line) => line.replaceAll(/[`*_~|>]/g, "").replaceAll(/\s+/g, " ").trim())
            .find((line) => line !== "") ?? "";
    if (firstLine === "") {
        return `Request from ${authorName}`.slice(0, THREAD_NAME_MAX);
    }
    if (firstLine.length <= THREAD_NAME_WANTED) {
        return firstLine;
    }
    const cut = firstLine.slice(0, THREAD_NAME_WANTED);
    const space = cut.lastIndexOf(" ");
    return `${space > THREAD_NAME_WANTED / 2 ? cut.slice(0, space) : cut}…`;
};

export const routeOf = (message: IncomingMessage, ours: OurSide): Route => {
    const { channel } = message;
    switch (channel.kind) {
        case "dm":
            return { addressed: true, channelId: message.channelId, room: message.channelId };
        case "thread": {
            const owned = channel.ownerId !== null && ours.botIds.has(channel.ownerId);
            return {
                addressed: message.mentionsUs || owned || ours.joined(message.channelId),
                channelId: channel.parentId ?? message.channelId,
                thread: message.channelId,
                room: message.channelId,
            };
        }
        case "threadable":
            return message.mentionsUs
                ? {
                      addressed: true,
                      channelId: message.channelId,
                      thread: message.id,
                      room: message.channelId,
                      opens: { parentId: message.channelId, messageId: message.id, name: threadNameOf(message.content, message.authorName) },
                  }
                : { addressed: false, channelId: message.channelId, room: message.channelId };
        case "other":
            return { addressed: message.mentionsUs, channelId: message.channelId, room: message.channelId };
    }
};

// Channels a thread can be started in from one of their messages.
const THREADABLE = new Set<ChannelType>([ChannelType.GuildText, ChannelType.GuildAnnouncement]);

// A discord.js message as the decision reads it.
export const inboundOf = (message: Message, botIds: ReadonlySet<string>): IncomingMessage => {
    const { channel } = message;
    const mentionsUs = [...botIds].some((id) => message.mentions.users.has(id) || message.mentions.repliedUser?.id === id);
    const heard = { id: message.id, channelId: message.channelId, content: message.content, authorName: message.author.username, mentionsUs };
    if (channel.isDMBased()) {
        return { ...heard, channel: { kind: "dm" } };
    }
    if (channel.isThread()) {
        return { ...heard, channel: { kind: "thread", parentId: channel.parentId, ownerId: channel.ownerId } };
    }
    return { ...heard, channel: { kind: THREADABLE.has(channel.type) ? "threadable" : "other" } };
};
