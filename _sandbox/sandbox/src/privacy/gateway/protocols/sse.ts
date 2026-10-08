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

interface SseParser {
    readonly feed: (text: string) => void;
    readonly end: () => void;
}

// Fields per the WHATWG event-stream grammar: `field: value` (one leading space dropped), `:` starts a comment, a
// blank line ends the event. Only `event` and `data` matter to a restorer; the rest rides along in `raw`.
const createParser = (dispatch: (event: SseEvent) => void): SseParser => {
    let buffer = "";
    // How far into `buffer` is known to hold no terminator, so a long line arriving in small chunks is scanned once.
    let scanned = 0;
    let raw = "";
    let name: string | undefined;
    let data: string[] | undefined;

    const line = (text: string, terminator: string): void => {
        raw += text + terminator;
        if (text === "") {
            dispatch({ event: name, data: data?.join("\n"), raw });
            raw = "";
            name = undefined;
            data = undefined;
            return;
        }
        const colon = text.indexOf(":");
        const field = colon < 0 ? text : text.slice(0, colon);
        const value = colon < 0 ? "" : text.slice(colon + (text.charAt(colon + 1) === " " ? 2 : 1));
        if (field === "event") {
            name = value;
        } else if (field === "data") {
            data = [...(data ?? []), value];
        }
    };

    const lines = (final: boolean): void => {
        const terminators = /\r\n|\r|\n/gu;
        terminators.lastIndex = scanned;
        let start = 0;
        for (let found = terminators.exec(buffer); found !== null; found = terminators.exec(buffer)) {
            // A `\r` that ends the buffer may be the first half of a `\r\n` still in flight.
            if (found[0] === "\r" && found.index === buffer.length - 1 && !final) {
                break;
            }
            line(buffer.slice(start, found.index), found[0]);
            start = found.index + found[0].length;
        }
        buffer = buffer.slice(start);
        scanned = Math.max(0, buffer.length - 1);
    };

    return {
        feed: (text) => {
            buffer += text;
            lines(false);
        },
        end: () => {
            lines(true);
            // An event the stream ended inside: dispatched as it stands, its raw text without the blank line it lacked.
            if (buffer !== "") {
                line(buffer, "");
                buffer = "";
            }
            if (raw !== "") {
                dispatch({ event: name, data: data?.join("\n"), raw });
                raw = "";
            }
        },
    };
};

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
