// A WebSocket spoken by hand over a byte stream: RFC 6455's client side (the opening handshake, masked frames out,
// unmasked frames in) on one bidirectional stream of the edge's WebTransport session. The edge serves each such stream as
// one HTTP/1.1 connection to the sandbox, so the front's own `/system/terminal` answers it exactly as it answers a
// WebSocket over TCP, and any front or daemon that serves a terminal serves this. The object reads as a WebSocket to
// whoever holds it (`SocketLike`), so the terminal channel treats both carriers alike.

// What the terminal channel needs of a socket, which a browser's `WebSocket` already is.
export interface SocketLike extends EventTarget {
    binaryType: BinaryType;
    readonly readyState: number;
    send(data: string): void;
    close(): void;
}

// Where on the sandbox's address the socket opens, as the stream's HTTP/1.1 request names it.
export interface StreamRequest {
    readonly host: string;
    readonly path: string;
    readonly query: string;
}

const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 3;

// RFC 6455's codes for a close that named no code, one that never arrived, a protocol error and a message too big.
const NO_CODE = 1005;
const ABNORMAL = 1006;
const PROTOCOL_ERROR = 1002;
const TOO_BIG = 1009;

// A response head past this is no answer the front gives; a message past this is no paste.
const HEAD_MAX = 16 * 1024;
const MESSAGE_MAX = 16 * 1024 * 1024;

const ACCEPT_GUID = `258EAFA5-E914-47DA-95CA-C5AB0DC85B11`;

const utf8 = new TextEncoder();
const text = new TextDecoder();

const base64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));

// Where a response head ends, or -1 while it has not.
const headEnd = (bytes: Uint8Array): number => {
    for (let at = 0; at + 3 < bytes.length; at += 1) {
        if (bytes[at] === 13 && bytes[at + 1] === 10 && bytes[at + 2] === 13 && bytes[at + 3] === 10) {
            return at;
        }
    }
    return -1;
};

const joined = (first: Uint8Array, second: Uint8Array): Uint8Array => {
    const both = new Uint8Array(first.length + second.length);
    both.set(first);
    both.set(second, first.length);
    return both;
};

// A client frame: always final, always masked.
export const clientFrame = (opcode: number, payload: Uint8Array): Uint8Array => {
    const extended = payload.length < 126 ? 0 : payload.length < 0x1_00_00 ? 2 : 8;
    const frame = new Uint8Array(2 + extended + 4 + payload.length);
    const view = new DataView(frame.buffer);
    frame[0] = 0x80 | opcode;
    frame[1] = 0x80 | (extended === 0 ? payload.length : extended === 2 ? 126 : 127);
    if (extended === 2) {
        view.setUint16(2, payload.length);
    } else if (extended === 8) {
        view.setBigUint64(2, BigInt(payload.length));
    }
    const mask = crypto.getRandomValues(new Uint8Array(4));
    frame.set(mask, 2 + extended);
    const at = 6 + extended;
    for (let index = 0; index < payload.length; index += 1) {
        frame[at + index] = (payload[index] ?? 0) ^ (mask[index & 3] ?? 0);
    }
    return frame;
};

// A stream torn down already rejects its writes, closes and cancels; the socket's end is reported once, by its close event.
const settled = (step: Promise<unknown> | undefined): void => {
    // silent-catch: see above; the end is reported by the close event, never by one stream step.
    void step?.catch(() => undefined);
};

export class StreamSocket extends EventTarget implements SocketLike {
    binaryType: BinaryType = `blob`;
    readyState = CONNECTING;
    private writer: WritableStreamDefaultWriter<Uint8Array> | undefined;
    private reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    // What has arrived and not yet made a whole frame, and the fragments of a message still being continued.
    private pending: Uint8Array = new Uint8Array(0);
    private message: { binary: boolean; parts: Uint8Array[]; size: number } | undefined;

    constructor(opening: Promise<WebTransportBidirectionalStream>, request: StreamRequest) {
        super();
        void this.run(opening, request).catch(() => this.finish(ABNORMAL, ``));
    }

    send(data: string): void {
        if (this.readyState === OPEN) {
            this.write(1, utf8.encode(data));
        }
    }

    // The front needs no answer to a close, and a half-open stream would never give one: the socket is closed here and now.
    close(): void {
        if (this.readyState === OPEN) {
            this.write(8, new Uint8Array(0));
        }
        this.finish(NO_CODE, ``);
    }

    private write(opcode: number, payload: Uint8Array): void {
        settled(this.writer?.write(clientFrame(opcode, payload)));
    }

    // Exactly one close event, delivered as a task of its own, so a holder replacing this socket has done so first.
    private finish(code: number, reason: string): void {
        if (this.readyState === CLOSED) {
            return;
        }
        this.readyState = CLOSED;
        settled(this.writer?.close());
        settled(this.reader?.cancel());
        queueMicrotask(() => this.dispatchEvent(Object.assign(new Event(`close`), { code, reason, wasClean: code !== ABNORMAL })));
    }

    private async run(opening: Promise<WebTransportBidirectionalStream>, request: StreamRequest): Promise<void> {
        const stream = await opening;
        this.writer = stream.writable.getWriter();
        this.reader = stream.readable.getReader();
        if (this.readyState === CLOSED) {
            settled(this.writer.close());
            settled(this.reader.cancel());
            return;
        }
        const key = base64(crypto.getRandomValues(new Uint8Array(16)));
        settled(
            this.writer.write(
                utf8.encode(
                    `GET ${request.path}?${request.query} HTTP/1.1\r\nhost: ${request.host}\r\nconnection: Upgrade\r\nupgrade: websocket\r\n` +
                        `sec-websocket-version: 13\r\nsec-websocket-key: ${key}\r\n\r\n`,
                ),
            ),
        );
        const accept = base64(new Uint8Array(await crypto.subtle.digest(`SHA-1`, utf8.encode(`${key}${ACCEPT_GUID}`))));
        let head: Uint8Array = new Uint8Array(0);
        for (;;) {
            // oxlint-disable-next-line eslint/no-await-in-loop -- a stream is read in order by definition
            const { value, done } = await this.reader.read();
            if (done || this.readyState === CLOSED) {
                return this.finish(ABNORMAL, ``);
            }
            if (this.readyState === OPEN) {
                this.receive(value);
                continue;
            }
            head = joined(head, value);
            const end = headEnd(head);
            if (end === -1) {
                if (head.length > HEAD_MAX) {
                    return this.finish(ABNORMAL, ``);
                }
                continue;
            }
            const lines = text.decode(head.subarray(0, end)).split(`\r\n`);
            const status = Number(lines[0]?.split(` `)[1]);
            if (status !== 101) {
                return this.finish(ABNORMAL, `HTTP ${Number.isNaN(status) ? 0 : status}`);
            }
            if (!lines.some((line) => line.toLowerCase() === `sec-websocket-accept: ${accept.toLowerCase()}`)) {
                return this.finish(ABNORMAL, `not a WebSocket`);
            }
            this.readyState = OPEN;
            this.dispatchEvent(new Event(`open`));
            this.receive(head.subarray(end + 4));
        }
    }

    // Every whole frame `chunk` completes, in order; the socket closes at the first a front never sends.
    private receive(chunk: Uint8Array): void {
        this.pending = joined(this.pending, chunk);
        while (this.readyState === OPEN) {
            const bytes = this.pending;
            if (bytes.length < 2) {
                return;
            }
            const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
            const [first = 0, second = 0] = bytes;
            if ((second & 0x80) !== 0) {
                return this.finish(PROTOCOL_ERROR, `a server frame is never masked`);
            }
            const short = second & 0x7f;
            const extended = short === 126 ? 2 : short === 127 ? 8 : 0;
            if (bytes.length < 2 + extended) {
                return;
            }
            const length = extended === 2 ? view.getUint16(2) : extended === 8 ? Number(view.getBigUint64(2)) : short;
            if (length + (this.message?.size ?? 0) > MESSAGE_MAX) {
                return this.finish(TOO_BIG, ``);
            }
            if (bytes.length < 2 + extended + length) {
                return;
            }
            const payload = bytes.slice(2 + extended, 2 + extended + length);
            this.pending = bytes.subarray(2 + extended + length);
            this.frame((first & 0x80) !== 0, first & 0x0f, payload);
        }
    }

    private frame(final: boolean, opcode: number, payload: Uint8Array): void {
        switch (opcode) {
            case 0:
            case 1:
            case 2: {
                // A continuation continues the message begun; a new message begins only once the last one ended.
                if ((opcode === 0) === (this.message === undefined)) {
                    return this.finish(PROTOCOL_ERROR, `a fragment out of order`);
                }
                const message = this.message ?? { binary: opcode === 2, parts: [], size: 0 };
                message.parts.push(payload);
                message.size += payload.length;
                this.message = final ? undefined : message;
                if (final) {
                    const whole = message.parts.length === 1 ? payload : message.parts.reduce(joined, new Uint8Array(0));
                    this.dispatchEvent(new MessageEvent(`message`, { data: message.binary ? whole.buffer : text.decode(whole) }));
                }
                return;
            }
            case 8: {
                const code = payload.length >= 2 ? new DataView(payload.buffer).getUint16(0) : NO_CODE;
                this.write(8, payload.subarray(0, 2));
                return this.finish(code, text.decode(payload.subarray(2)));
            }
            case 9:
                return this.write(10, payload);
            case 10:
                return;
            default:
                return this.finish(PROTOCOL_ERROR, `no frame is of opcode ${opcode}`);
        }
    }
}
