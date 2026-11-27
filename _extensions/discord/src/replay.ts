import type { SleepHeardMessage } from "@intentic/extension-api/runtime";
import type { GatewayCtx } from "@intentic/connector-runtime";
import { type Client, DiscordAPIError, type Message } from "discord.js";
import { visibleChannel } from "./client.js";

/* WHAT WAS SAID WHILE THE SANDBOX SLEPT (2026-11-27). A bot whose owner turned on the card's wake-on-mention had its token
 * held by Intentic's servers while the hosted sandbox slept; they noted where each message for the bot was (channel,
 * message and server ids, never the words) and woke the sandbox. At the gateway's start after such a sleep it asks for
 * those notes once (`api.sleep.heard()`, which forgets them), and as each bot connects it fetches its messages over
 * REST with that bot's token and hands each to the same handler a live message takes: the same addressing, thread,
 * conversation and reply rules, and the same duplicate check. A message deleted since, or one the bot can no longer
 * read, is skipped with a log line. */

// What the gateway fetches a heard message with: the bot's own client.
export type FetchHeard = (client: Client, heard: Pick<SleepHeardMessage, "channelId" | "messageId">) => Promise<Message | null>;

// What Discord answers for a message deleted since, or one this bot may no longer read.
const GONE: ReadonlySet<number> = new Set([400, 403, 404]);

/** One heard message as the bot can read it now, with its author's member loaded so a sender rule naming a role still
 * holds (a fetched message carries no member); null for one deleted, or in a channel the bot no longer sees. */
const fetchHeard: FetchHeard = async (client, heard) => {
    const channel = await visibleChannel(client, heard.channelId);
    if (channel === null || !channel.isTextBased()) {
        return null;
    }
    let message: Message;
    try {
        message = await channel.messages.fetch(heard.messageId);
    } catch (error) {
        if (error instanceof DiscordAPIError && GONE.has(error.status)) {
            return null;
        }
        throw error;
    }
    if (message.guild !== null && message.member === null) {
        // allow(silent-catch): a member who left is still the author; the message is answered without their roles
        await message.guild.members.fetch(message.author.id).catch(() => undefined);
    }
    return message;
};

export interface HeardReplay {
    /** Answers what was heard for the connections a bot just connected with, through `dispatch`, oldest first. */
    readonly connected: (client: Client, connectionIds: readonly string[]) => Promise<void>;
}

/** Asks once, after a hosted sleep, what was heard for this extension's connections, and holds each connection's share
 * until its bot connects. */
export const heardReplay = (
    ctx: Pick<GatewayCtx, "api" | "log">,
    dispatch: (message: Message) => void,
    fetch: FetchHeard = fetchHeard,
): HeardReplay => {
    const asked = ctx.api.sleep
        .boot()
        .then((boot) => (boot.afterSleep ? ctx.api.sleep.heard() : []))
        .catch((error: Error) => {
            ctx.log.warn({ err: error }, "discord: what was said while the sandbox slept could not be asked for; it is not answered");
            return [];
        });
    const pending = asked.then((heard) => {
        const byConnection = new Map<string, SleepHeardMessage[]>();
        for (const message of heard) {
            byConnection.set(message.connection, [...(byConnection.get(message.connection) ?? []), message]);
        }
        return byConnection;
    });
    return {
        connected: async (client, connectionIds) => {
            const byConnection = await pending;
            const mine = connectionIds.flatMap((id) => {
                const heard = byConnection.get(id) ?? [];
                byConnection.delete(id);
                return heard;
            });
            for (const heard of mine.toSorted((a, b) => a.at - b.at)) {
                const message = await fetch(client, heard).catch((error: Error) => {
                    ctx.log.warn({ err: error, channel: heard.channelId, message: heard.messageId }, "discord: a message said while the sandbox slept could not be fetched; skipped");
                    return null;
                });
                if (message === null) {
                    ctx.log.info({ channel: heard.channelId, message: heard.messageId }, "discord: a message said while the sandbox slept is gone or unreadable; skipped");
                    continue;
                }
                ctx.log.info({ channel: heard.channelId, message: heard.messageId }, "discord: answering a message said while the sandbox slept");
                dispatch(message);
            }
        },
    };
};
