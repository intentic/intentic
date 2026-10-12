// Server-Sent Events as the WHATWG event-stream grammar defines them, read off a byte stream that may be cut anywhere:
// inside a UTF-8 character, inside a `\r\n`, inside an event. Protocol-only (no domain shapes). Its readers: the ACP
// bridge and the extension SDK on the daemon's streamed routes, the privacy gateway's restorers, and the daemon's own
// MCP calls (an app's tool calls, a capability probe's `initialize`). Each had a parser of its own, and they disagreed:
// this one used to split on `\n\n` only and read the first `data:` line of an event, where the grammar allows `\r\n`
// and `\r` and joins every data line with `\n`. The webchat widget reads its replies with it too, through the `./sse`
// subpath: a bundle on customers' pages may take only modules with no imports, as this one is and must stay.

// A live daemon writes to a stream at least this often (oRPC's keep-alive comment every 5 s, a heartbeat on the rest), so
// this long with no bytes means the connection is dead even though nothing closed it.
export const SSE_IDLE_MS = 120_000;

export interface SseEvent {
    // The `event:` field, undefined when the event named none (a listener reads that as "message").
    readonly event: string | undefined;
    // The data lines joined with `\n`; undefined for a block with none (a comment, a keep-alive, a stray blank line).
    readonly data: string | undefined;
    // The last event id the stream has set, as EventSource carries it: it persists across events until set again.
    readonly id: string | undefined;
    // The reconnection time an event asked for, in milliseconds.
    readonly retry: number | undefined;
    // The event's own text as it arrived, its terminating blank line included, for a reader that forwards it unchanged.
    readonly raw: string;
}

export interface SseParser {
    readonly feed: (text: string) => void;
    // The stream ended: an event it ended inside is dispatched as it stands.
    readonly end: () => void;
}

interface Pending {
    raw: string;
    name: string | undefined;
    data: string[] | undefined;
    retry: number | undefined;
}

const fresh = (): Pending => ({ raw: ``, name: undefined, data: undefined, retry: undefined });

// Fields per the grammar: `field: value` (one leading space dropped), `:` starts a comment, a blank line ends the event.
// Every block is dispatched, a comment-only one too, so a reader forwarding the stream loses nothing; a reader of
// messages skips the ones whose `data` is undefined.
export const createSseParser = (dispatch: (event: SseEvent) => void): SseParser => {
    let buffer = ``;
    // How far into `buffer` is known to hold no terminator, so a long line arriving in small chunks is scanned once.
    let scanned = 0;
    let started = false;
    let lastId: string | undefined;
    let pending = fresh();

    const emit = (): void => {
        dispatch({ event: pending.name, data: pending.data?.join(`\n`), id: lastId, retry: pending.retry, raw: pending.raw });
        pending = fresh();
    };

    const field = (name: string, value: string): void => {
        if (name === `event`) {
            pending.name = value;
        } else if (name === `data`) {
            pending.data = [...(pending.data ?? []), value];
        } else if (name === `id` && !value.includes(`\0`)) {
            lastId = value;
        } else if (name === `retry` && /^\d+$/.test(value)) {
            pending.retry = Number(value);
        }
    };

    const line = (text: string, terminator: string): void => {
        pending.raw += text + terminator;
        if (text === ``) {
            emit();
            return;
        }
        if (text.startsWith(`:`)) {
            return;
        }
        const colon = text.indexOf(`:`);
        field(colon < 0 ? text : text.slice(0, colon), colon < 0 ? `` : text.slice(colon + (text.charAt(colon + 1) === ` ` ? 2 : 1)));
    };

    const lines = (final: boolean): void => {
        const terminators = /\r\n|\r|\n/gu;
        terminators.lastIndex = scanned;
        let start = 0;
        for (let found = terminators.exec(buffer); found !== null; found = terminators.exec(buffer)) {
            // A `\r` that ends the buffer may be the first half of a `\r\n` still in flight.
            if (found[0] === `\r` && found.index === buffer.length - 1 && !final) {
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
            let next = text;
            // The grammar drops one byte-order mark at the very start; it stays in the first event's raw text.
            if (!started && next !== ``) {
                started = true;
                if (next.startsWith(`\uFEFF`)) {
                    pending.raw += `\uFEFF`;
                    next = next.slice(1);
                }
            }
            buffer += next;
            lines(false);
        },
        end: () => {
            lines(true);
            if (buffer !== ``) {
                line(buffer, ``);
                buffer = ``;
            }
            if (pending.raw !== ``) {
                emit();
            }
        },
    };
};

// Every event in a body already read whole (a short MCP answer), the last one dispatched even without its blank line.
export const parseSseText = (text: string): SseEvent[] => {
    const events: SseEvent[] = [];
    const parser = createSseParser((event) => events.push(event));
    parser.feed(text);
    parser.end();
    return events;
};

// Yields each event as it arrives. Ends, cancelling the reader, after `idleMs` of silence, so a reader of a daemon that
// went quiet without closing (a sleeping laptop's tunnel, a wedged proxy) finishes instead of hanging.
export async function* sseEvents(body: ReadableStream<Uint8Array>, idleMs: number = SSE_IDLE_MS): AsyncGenerator<SseEvent> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let ready: SseEvent[] = [];
    const parser = createSseParser((event) => ready.push(event));
    try {
        for (;;) {
            let timer: ReturnType<typeof setTimeout> | undefined;
            const idle = new Promise<`idle`>((resolve) => {
                timer = setTimeout(() => resolve(`idle`), idleMs);
            });
            // oxlint-disable-next-line eslint/no-await-in-loop -- streaming reader; each chunk must be awaited in order as it arrives
            const result = await Promise.race([reader.read(), idle]);
            clearTimeout(timer);
            if (result === `idle`) {
                return;
            }
            if (result.done) {
                parser.feed(decoder.decode());
                parser.end();
            } else {
                parser.feed(decoder.decode(result.value, { stream: true }));
            }
            const events = ready;
            ready = [];
            yield* events;
            if (result.done) {
                return;
            }
        }
    } finally {
        // allow(silent-catch): A stream already errored or closed has nothing left to cancel.
        await reader.cancel().catch(() => undefined);
    }
}

// Each event's text as it arrived, without the blank line that ended it: for a reader that keeps the frame and reads
// it with `sseData`. The same idle window as `sseEvents`.
export async function* sseFrames(body: ReadableStream<Uint8Array>, idleMs: number = SSE_IDLE_MS): AsyncGenerator<string> {
    for await (const event of sseEvents(body, idleMs)) {
        yield event.raw.replace(/(?:\r\n|\r|\n)+$/u, ``);
    }
}

// What a data payload parses to, before a caller's schema reads it.
export type SseJsonValue = string | number | boolean | null | readonly SseJsonValue[] | { readonly [key: string]: SseJsonValue };

// An event's data as JSON, or undefined for an event with no data, an empty payload, or malformed JSON (all cases
// the callers skip).
export const sseJson = (event: SseEvent): SseJsonValue | undefined => {
    if (event.data === undefined || event.data.trim() === ``) {
        return undefined;
    }
    try {
        // SAFETY: JSON.parse returns only JSON values; each caller's schema reads the shape it expects.
        return JSON.parse(event.data) as SseJsonValue;
    } catch {
        return undefined; // Skip a malformed frame.
    }
};

// The same, for a frame's text as `sseFrames` yields it.
export const sseData = (frame: string): SseJsonValue | undefined => {
    const event = parseSseText(frame).find((parsed) => parsed.data !== undefined);
    return event === undefined ? undefined : sseJson(event);
};

// The `event:` name of a frame's text, for a reader holding the frame rather than the parsed event.
export const sseEventName = (frame: string): string | undefined => parseSseText(frame)[0]?.event;
