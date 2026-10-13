import { type REST, Routes } from "discord.js";

// The handful of Discord REST calls a reply makes, over whatever REST handle holds the bot's credential: a connected
// client's own (`client.rest`), or one pointed anywhere else that attaches it. Plain routes and bodies rather than
// discord.js's cached structures, so a reply posts the same way whether or not a gateway socket is open, and a test
// fakes five methods instead of a client.

export type DiscordRest = Pick<REST, "get" | "post" | "patch" | "put" | "delete">;

// A created message's or thread's id, the one field every write here reads back.
interface Created {
    readonly id: string;
}

// Nobody is pinged by what the bot posts unless a post names them on purpose: an agent quoting `@everyone` from a log, or
// a role name in its answer, must not page a whole server.
export const NO_PINGS = { parse: [] } as const;

export interface MessageBody {
    readonly content?: string;
    readonly embeds?: readonly object[];
    readonly components?: readonly object[];
    readonly allowed_mentions?: { readonly parse: readonly string[]; readonly users?: readonly string[]; readonly replied_user?: boolean };
    readonly message_reference?: { readonly message_id: string; readonly fail_if_not_exists: boolean };
}

export const postMessage = async (rest: DiscordRest, channelId: string, body: MessageBody): Promise<string> => {
    // SAFETY: POST /channels/{id}/messages answers the message it created, which always carries its id.
    const created = (await rest.post(Routes.channelMessages(channelId), { body: { allowed_mentions: NO_PINGS, ...body } })) as Created;
    return created.id;
};

export const editMessage = async (rest: DiscordRest, channelId: string, messageId: string, body: MessageBody): Promise<void> => {
    await rest.patch(Routes.channelMessage(channelId, messageId), { body: { allowed_mentions: NO_PINGS, ...body } });
};

// A reaction route names its emoji percent-encoded; discord.js's route builder leaves that to the caller.
export const react = async (rest: DiscordRest, channelId: string, messageId: string, emoji: string): Promise<void> => {
    await rest.put(Routes.channelMessageOwnReaction(channelId, messageId, encodeURIComponent(emoji)));
};

export const unreact = async (rest: DiscordRest, channelId: string, messageId: string, emoji: string): Promise<void> => {
    await rest.delete(Routes.channelMessageOwnReaction(channelId, messageId, encodeURIComponent(emoji)));
};

// "<bot> is typing…" in a room for about ten seconds, or until the bot posts there.
export const typing = async (rest: DiscordRest, channelId: string): Promise<void> => {
    await rest.post(Routes.channelTyping(channelId));
};

// How long a quiet thread stays open in the channel's list, in minutes (one of Discord's fixed choices).
const THREAD_ARCHIVE_MINUTES = 1440;

// A public thread started from a message; Discord gives it the message's own id. Answers that id.
export const startThread = async (rest: DiscordRest, channelId: string, messageId: string, name: string): Promise<string> => {
    // SAFETY: POST /channels/{id}/messages/{id}/threads answers the thread channel it created, which always carries its id.
    const created = (await rest.post(Routes.threads(channelId, messageId), { body: { name, auto_archive_duration: THREAD_ARCHIVE_MINUTES } })) as Created;
    return created.id;
};

// Puts someone in a thread, so it shows in their thread list and they hear what is said there.
export const addThreadMember = async (rest: DiscordRest, threadId: string, userId: string): Promise<void> => {
    await rest.put(Routes.threadMembers(threadId, userId));
};
