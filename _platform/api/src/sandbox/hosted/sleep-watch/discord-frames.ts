import { parseJsonWith } from "@intentic/base/json";
import { z } from "zod";

/* WHAT THE DISCORD GATEWAY SAYS, AS THE SLEEP WATCH READS IT (2026-11-27): every frame parsed once, at the socket, into
 * the few things a watch acts on (discord-watch.ts). Anything else, and anything malformed, reads as nothing. */

const ThreadSchema = z.object({ id: z.string(), owner_id: z.string().optional() });
const AuthorSchema = z.object({ id: z.string(), bot: z.boolean().optional() });
export const DiscordMessageSchema = z.object({
    id: z.string(),
    channel_id: z.string(),
    // Absent for a direct message.
    guild_id: z
        .string()
        .nullish()
        .transform((value) => value ?? undefined),
    author: AuthorSchema,
    webhook_id: z.string().optional(),
    mentions: z.array(z.object({ id: z.string() })).optional(),
    referenced_message: z.object({ author: AuthorSchema.optional() }).nullable().optional(),
});
export type DiscordMessage = z.infer<typeof DiscordMessageSchema>;
export type DiscordThread = z.infer<typeof ThreadSchema>;

export type GatewayEvent =
    | { readonly kind: "hello"; readonly intervalMs: number }
    | { readonly kind: "ack" }
    | { readonly kind: "beat" }
    | { readonly kind: "reconnect" }
    | { readonly kind: "invalid"; readonly resumable: boolean }
    | { readonly kind: "ready"; readonly botId: string; readonly sessionId: string; readonly resumeUrl: string }
    | { readonly kind: "resumed" }
    | { readonly kind: "threads"; readonly threads: readonly DiscordThread[] }
    | { readonly kind: "thread-gone"; readonly id: string }
    | { readonly kind: "message"; readonly message: DiscordMessage }
    | { readonly kind: "other" };

export interface GatewayFrame {
    // The dispatch's sequence number, when it carries one.
    readonly seq?: number;
    readonly event: GatewayEvent;
}

// A frame as it arrived: its opcode, its payload (parsed further by what the opcode and type say it is), its sequence
// number and its dispatch type.
const FrameSchema = z.object({ op: z.number(), d: z.unknown(), s: z.number().nullable().optional(), t: z.string().nullable().optional() });
type Frame = z.infer<typeof FrameSchema>;
const HelloSchema = z.object({ heartbeat_interval: z.number().positive() });
const ReadySchema = z.object({ session_id: z.string(), resume_gateway_url: z.string(), user: z.object({ id: z.string() }) });
const ThreadsSchema = z.object({ threads: z.array(ThreadSchema).optional() });

const OTHER: GatewayEvent = { kind: "other" };

// One dispatch (op 0), by its type.
const dispatchOf = ({ t: type, d: payload }: Frame): GatewayEvent => {
    switch (type) {
        case "READY": {
            const ready = ReadySchema.safeParse(payload).data;
            return ready === undefined
                ? OTHER
                : { kind: "ready", botId: ready.user.id, sessionId: ready.session_id, resumeUrl: ready.resume_gateway_url };
        }
        case "RESUMED":
            return { kind: "resumed" };
        // A server's own list of open threads, a resync of it, and one thread made or changed.
        case "GUILD_CREATE":
        case "THREAD_LIST_SYNC":
            return { kind: "threads", threads: ThreadsSchema.safeParse(payload).data?.threads ?? [] };
        case "THREAD_CREATE":
        case "THREAD_UPDATE": {
            const thread = ThreadSchema.safeParse(payload).data;
            return thread === undefined ? OTHER : { kind: "threads", threads: [thread] };
        }
        case "THREAD_DELETE": {
            const thread = ThreadSchema.safeParse(payload).data;
            return thread === undefined ? OTHER : { kind: "thread-gone", id: thread.id };
        }
        case "MESSAGE_CREATE": {
            const message = DiscordMessageSchema.safeParse(payload).data;
            return message === undefined ? OTHER : { kind: "message", message };
        }
        default:
            return OTHER;
    }
};

// One frame's opcode: dispatch (0), heartbeat asked (1), reconnect (7), invalid session (9), hello (10), ack (11).
const eventOf = (frame: Frame): GatewayEvent => {
    const payload = frame.d;
    switch (frame.op) {
        case 0:
            return dispatchOf(frame);
        case 1:
            return { kind: "beat" };
        case 7:
            return { kind: "reconnect" };
        case 9:
            return { kind: "invalid", resumable: payload === true };
        case 10: {
            const hello = HelloSchema.safeParse(payload).data;
            return hello === undefined ? OTHER : { kind: "hello", intervalMs: hello.heartbeat_interval };
        }
        case 11:
            return { kind: "ack" };
        default:
            return OTHER;
    }
};

/** One text frame from the gateway as the watch acts on it; undefined for one that is not a gateway frame at all. */
export const gatewayFrameOf = (text: string): GatewayFrame | undefined => {
    const frame = parseJsonWith(text, FrameSchema);
    if (frame === undefined) {
        return undefined;
    }
    const event = eventOf(frame);
    return frame.s === null || frame.s === undefined ? { event } : { seq: frame.s, event };
};

/** Whether a message is for the bot, as the sandbox's gateway would judge it with what a sleeping watch can know: a
 * direct message, an @mention, a reply to the bot, or a message in a thread it owns. Never a bot's or a webhook's. */
export const addressedToBot = (message: DiscordMessage, botId: string, ownedThreads: ReadonlySet<string>): boolean => {
    if (message.author.id === botId || message.author.bot === true || message.webhook_id !== undefined) {
        return false;
    }
    return (
        message.guild_id === undefined ||
        (message.mentions ?? []).some((mentioned) => mentioned.id === botId) ||
        message.referenced_message?.author?.id === botId ||
        ownedThreads.has(message.channel_id)
    );
};
