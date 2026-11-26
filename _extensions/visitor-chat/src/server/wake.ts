import { randomUUID } from "node:crypto";
import type { ListenerHistoryEntry, ListenerMessage } from "@intentic/sandbox-contract/protocol/doors/listener-protocol";
import type { WebchatMessage } from "@intentic/sandbox-contract/schemas/automations";
import { z } from "zod";
import { WEBCHAT_PROVIDER } from "./chats.js";
import type { VisitorIdentity } from "./identity.js";

// WAKING THE CHAT'S AGENT ON A VISITOR'S MESSAGE (2026-11-26): through this extension's own listener source, as any chat
// extension's gateway wakes its automations, so the sandbox's scheduler decides, not this backend. The daemon's listener
// door (POST /listeners/webchat/dispatch, reached by the extension that owns the `webchat` listener and no other) runs the
// message through the automation's filters, the owner's admission floor for a website visitor (the listener declares
// `strangers: "visitor"`), the chat's own approval, the day's wake ceiling, held wakes and the fire journal. The message
// names its chat (`automationId`), so it wakes that one alone.
//
// One sandbox conversation per thread generation (threads.ts): `channelId` is the widget's conversation id, which a
// trigger's channel filter names, and `thread` is the chat and the generation, which is also how a late reply that comes
// back through the gateway (`/deliver`) finds the visitor's outbox. The answer is streamed back as ndjson frames, which
// go on to the visitor as the widget's SSE events.

// The SSE events the widget reads (the contract's `embed` WEBCHAT_EVENT, which an extension may not import).
export const WEBCHAT_EVENT = { delta: `delta`, pending: `pending`, error: `error`, done: `done` } as const;

// One sentence for every failure: the real reasons are the owner's own facts, recorded on the run, not the visitor's.
export const VISITOR_FAILURE = `Sorry: I couldn't answer that just now. Please try again in a moment.`;
// What a visitor whose message waits for a person is told.
export const PENDING_NOTICE = `Thanks, your request was received and a human will review it shortly.`;

/** The listener message's `thread` for a chat's generation, and back. */
export const threadOf = (automationId: string, generation: number): string => `${automationId}.${generation}`;
export const automationOfThread = (thread: string | undefined): string | undefined => {
    const dot = thread?.lastIndexOf(`.`) ?? -1;
    return thread === undefined || dot <= 0 ? undefined : thread.slice(0, dot);
};

export interface Wake {
    readonly automationId: string;
    readonly conversationId: string;
    readonly generation: number;
    readonly visitor: VisitorIdentity;
    readonly content: string;
    // The widget's transcript, handed on only when this message starts a conversation.
    readonly history?: WebchatMessage[`history`] | undefined;
    readonly now: number;
}

// The widget's transcript as the listener's history: the visitor's turns under their name, the agent's as its own.
const historyOf = (history: NonNullable<WebchatMessage[`history`]>, visitor: VisitorIdentity, at: string): ListenerHistoryEntry[] =>
    history.map((entry) =>
        entry.author === undefined
            ? { author: { id: `agent`, name: `agent` }, content: entry.content, timestamp: at, self: true }
            : { author: { id: `visitor`, name: visitor.displayName ?? entry.author }, content: entry.content, timestamp: at },
    );

// The message's `extra`: the visitor's identity in fields of its own, the agent's prompt naming each.
interface VisitorClaims {
    verified?: NonNullable<VisitorIdentity[`verified`]>;
    unverifiedDisplayName?: string;
    member?: true;
}

/** The listener message one visitor's message is dispatched as. */
export const listenerMessageOf = (wake: Wake): ListenerMessage => {
    const at = new Date(wake.now).toISOString();
    const { visitor } = wake;
    // What is known of who is writing, apart from what they wrote: only `verified` is signature-backed, so a visitor
    // cannot promote themselves by typing it.
    const extra: VisitorClaims = {};
    if (visitor.verified !== undefined) {
        extra.verified = visitor.verified;
    }
    if (visitor.displayName !== undefined) {
        extra.unverifiedDisplayName = visitor.displayName;
    }
    if (visitor.member === true) {
        extra.member = true;
    }
    const message: ListenerMessage = {
        provider: WEBCHAT_PROVIDER,
        type: `message`,
        id: randomUUID(),
        channelId: wake.conversationId,
        thread: threadOf(wake.automationId, wake.generation),
        automationId: wake.automationId,
        // The browser's thread is who is writing, as far as anyone vouches: per-sender limits count it, never a name.
        author: { id: wake.conversationId, name: visitor.author },
        content: wake.content,
        timestamp: at,
    };
    if (wake.history !== undefined && wake.history.length > 0) {
        message.history = historyOf(wake.history, visitor, at);
    }
    if (Object.keys(extra).length > 0) {
        message.extra = { ...extra };
    }
    return message;
};

// The frames this backend reads, every field optional so a daemon newer or older than this build still reads.
const FrameSchema = z
    .object({
        automationId: z.string().optional(),
        delta: z.string().optional(),
        failed: z.string().optional(),
        held: z.string().optional(),
        steered: z.boolean().optional(),
        end: z.boolean().optional(),
    })
    .loose();
type Frame = z.infer<typeof FrameSchema>;

const frameOf = (line: string): Frame | undefined => {
    try {
        return FrameSchema.safeParse(JSON.parse(line)).data;
    } catch {
        // allow(silent-catch): a line that is not a frame carries nothing for the visitor
        return undefined;
    }
};

// One SSE event; a multi-line text is one `data:` line per line, which the widget's parser joins again.
export const sseEvent = (event: string, data: string): string => `event: ${event}\n${data.split(`\n`).map((line) => `data: ${line}`).join(`\n`)}\n\n`;

// What the visitor has been told so far, to tell an answer apart from a stream that ended with nothing.
interface Told {
    answered: boolean;
}

// The SSE events one frame becomes, and whether the turn is over.
interface Translated {
    readonly events: string[];
    readonly over: boolean;
}

const eventsOf = (frame: Frame, told: Told): Translated => {
    const events: string[] = [];
    if (frame.delta !== undefined && frame.delta !== ``) {
        told.answered = true;
        events.push(sseEvent(WEBCHAT_EVENT.delta, frame.delta));
    }
    if (frame.held !== undefined) {
        // Held for a person: nothing streams now, and the answer reaches the outbox once they let it.
        told.answered = true;
        events.push(sseEvent(WEBCHAT_EVENT.pending, PENDING_NOTICE));
    }
    if (frame.steered === true) {
        // Taken into the turn already answering this thread, whose own stream carries the answer.
        told.answered = true;
    }
    if (frame.failed !== undefined) {
        told.answered = true;
        events.push(sseEvent(WEBCHAT_EVENT.error, VISITOR_FAILURE));
    }
    if (frame.end === true) {
        // A turn that ended having said nothing (no answer, the day's ceiling spent) is a failure to the visitor.
        if (!told.answered) {
            events.push(sseEvent(WEBCHAT_EVENT.error, VISITOR_FAILURE));
        }
        events.push(sseEvent(WEBCHAT_EVENT.done, ``));
        return { events, over: true };
    }
    return { events, over: false };
};

/**
 * The daemon's streamed dispatch answer (ndjson frames for this chat) as the widget's SSE stream. A stream that closes
 * without its turn ending says so as a failure, and the visitor going away lets the dispatch stream go; the turn runs on.
 */
export const sseFromFrames = (dispatched: Response, automationId: string): Response => {
    const reader = dispatched.body?.getReader();
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const told: Told = { answered: false };
    let buffer = ``;
    const body = new ReadableStream<Uint8Array>({
        pull: async (controller) => {
            if (reader === undefined) {
                controller.enqueue(encoder.encode(sseEvent(WEBCHAT_EVENT.error, VISITOR_FAILURE) + sseEvent(WEBCHAT_EVENT.done, ``)));
                controller.close();
                return;
            }
            const chunk = await reader.read();
            if (chunk.done) {
                controller.enqueue(encoder.encode(sseEvent(WEBCHAT_EVENT.error, VISITOR_FAILURE) + sseEvent(WEBCHAT_EVENT.done, ``)));
                controller.close();
                return;
            }
            buffer += decoder.decode(chunk.value, { stream: true });
            const lines = buffer.split(`\n`);
            buffer = lines.pop() ?? ``;
            for (const frame of lines.map(frameOf)) {
                if (frame === undefined || frame.automationId !== automationId) {
                    continue;
                }
                const { events, over } = eventsOf(frame, told);
                if (events.length > 0) {
                    controller.enqueue(encoder.encode(events.join(``)));
                }
                if (over) {
                    controller.close();
                    // allow(silent-catch): the turn is over and said so; a dispatch stream that will not cancel holds nothing
                    await reader.cancel().catch(() => undefined);
                    return;
                }
            }
        },
        // The visitor went away: the dispatch stream is let go and the turn runs on in the sandbox.
        cancel: async () => {
            // allow(silent-catch): nobody is left to tell, and a stream that will not cancel holds nothing
            await reader?.cancel().catch(() => undefined);
        },
    });
    return new Response(body, { headers: { "content-type": `text/event-stream; charset=utf-8`, "cache-control": `no-cache` } });
};
