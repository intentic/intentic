import { createSseParser, type SseParser } from "@intentic/sandbox-contract";
import type { Json } from "./walk.js";

// Server-Sent Events as both providers stream them, read off a byte stream that may be cut anywhere: inside a UTF-8
// character, inside a `\r\n`, inside an event. Each protocol's restorer sees whole events and answers with the events
// to send on; one it leaves alone goes out as the exact text it came in as.

export interface SseEvent {
    readonly event: string | undefined;
    // The data lines joined with `\n`; undefined for a block with none (a comment, a keep-alive, a stray blank line).
    readonly data: string | undefined;
    // The event's own text, blank line included, while it is forwarded as it came; undefined once rewritten.
    readonly raw: string | undefined;
}

export interface SseHandler {
    readonly onEvent: (event: SseEvent) => readonly SseEvent[];
    // The stream ended: whatever is still held, as events.
    readonly onEnd: () => readonly SseEvent[];
}

export const jsonEvent = (name: string | undefined, payload: Json): SseEvent => ({ event: name, data: JSON.stringify(payload), raw: undefined });

export const serializeEvent = (event: SseEvent): string => {
    if (event.raw !== undefined) {
        return event.raw;
    }
    const name = event.event === undefined ? "" : `event: ${event.event}\n`;
    const data = (event.data ?? "")
        .split(/\r\n|\r|\n/u)
        .map((line) => `data: ${line}\n`)
        .join("");
    return `${name}${data}\n`;
};

// The contract's WHATWG parser, narrowed to what a restorer reads: `event` and `data`, with `id` and `retry` riding
// along in `raw`. Every event leaves it raw, so one no restorer touches goes out byte for byte, an event the stream
// ended inside included (without the blank line it lacked).
const createParser = (dispatch: (event: SseEvent) => void): SseParser => createSseParser(({ event, data, raw }) => dispatch({ event, data, raw }));

export const sseTransform = (handler: SseHandler): TransformStream<Uint8Array, Uint8Array> => {
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let out = "";
    const parser = createParser((event) => {
        for (const next of handler.onEvent(event)) {
            out += serializeEvent(next);
        }
    });
    const drain = (controller: TransformStreamDefaultController<Uint8Array>): void => {
        if (out !== "") {
            controller.enqueue(encoder.encode(out));
            out = "";
        }
    };
    return new TransformStream<Uint8Array, Uint8Array>({
        transform: (chunk, controller) => {
            parser.feed(decoder.decode(chunk, { stream: true }));
            drain(controller);
        },
        flush: (controller) => {
            parser.feed(decoder.decode());
            parser.end();
            for (const next of handler.onEnd()) {
                out += serializeEvent(next);
            }
            drain(controller);
        },
    });
};

// The same stream with a change that has to wait for something (a masker, a picture reader): events are changed one at a
// time and in order, the next chunk read only once every event of this one has gone out.
export const sseAsyncTransform = (change: (event: SseEvent) => Promise<SseEvent>): TransformStream<Uint8Array, Uint8Array> => {
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let pending: SseEvent[] = [];
    const parser = createParser((event) => {
        pending.push(event);
    });
    const drain = async (controller: TransformStreamDefaultController<Uint8Array>): Promise<void> => {
        const events = pending;
        pending = [];
        let out = "";
        for (const event of events) {
            out += serializeEvent(event.data === undefined ? event : await change(event));
        }
        if (out !== "") {
            controller.enqueue(encoder.encode(out));
        }
    };
    return new TransformStream<Uint8Array, Uint8Array>({
        transform: async (chunk, controller) => {
            parser.feed(decoder.decode(chunk, { stream: true }));
            await drain(controller);
        },
        flush: async (controller) => {
            parser.feed(decoder.decode());
            parser.end();
            await drain(controller);
        },
    });
};
