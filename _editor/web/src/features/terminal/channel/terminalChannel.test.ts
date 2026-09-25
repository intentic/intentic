import { StreamSocket } from "./streamSocket";
import { type ChannelEvents, socketChannel } from "./terminalChannel";

// The editor's end of a terminal on a WebTransport stream: a WebSocket spoken by hand, read through the same channel a
// browser WebSocket is. The far end here plays the front, which answers such a stream as any WebSocket over TCP.

interface FarEnd {
    readonly heard: ReadableStreamDefaultReader<Uint8Array>;
    readonly answer: WritableStreamDefaultWriter<Uint8Array>;
}

// One stream, as `createBidirectionalStream()` resolves it, and the front's end of it.
const streamPair = (): { opening: Promise<WebTransportBidirectionalStream>; far: FarEnd } => {
    const toFront = new TransformStream<Uint8Array, Uint8Array>();
    const toBrowser = new TransformStream<Uint8Array, Uint8Array>();
    const stream = { readable: toBrowser.readable, writable: toFront.writable } as unknown as WebTransportBidirectionalStream;
    return { opening: Promise.resolve(stream), far: { heard: toFront.readable.getReader(), answer: toBrowser.writable.getWriter() } };
};

const utf8 = new TextEncoder();
const text = new TextDecoder();

const joined = (...parts: Uint8Array[]): Uint8Array => {
    const out = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
    let at = 0;
    for (const part of parts) {
        out.set(part, at);
        at += part.length;
    }
    return out;
};

// A frame as the front writes it: unmasked.
const serverFrame = (opcode: number, payload: Uint8Array, final = true): Uint8Array => {
    const extended = payload.length < 126 ? 0 : 2;
    const head = new Uint8Array(2 + extended);
    head[0] = (final ? 0x80 : 0) | opcode;
    head[1] = extended === 0 ? payload.length : 126;
    if (extended === 2) {
        new DataView(head.buffer).setUint16(2, payload.length);
    }
    return joined(head, payload);
};

const closeFrame = (code: number, reason: string): Uint8Array => {
    const payload = joined(new Uint8Array(2), utf8.encode(reason));
    new DataView(payload.buffer).setUint16(0, code);
    return serverFrame(8, payload);
};

interface ClientFrame {
    readonly opcode: number;
    readonly masked: boolean;
    readonly payload: string;
}

// What the channel wrote: its request head, then a reader of the frames after it, unmasked.
const upgradeOf = async (far: FarEnd): Promise<{ head: string; frames: () => Promise<ClientFrame | undefined> }> => {
    let pending: Uint8Array = new Uint8Array(0);
    const more = async (): Promise<boolean> => {
        const { value, done } = await far.heard.read();
        if (done) {
            return false;
        }
        pending = joined(pending, value);
        return true;
    };
    while (!text.decode(pending).includes(`\r\n\r\n`)) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- a stream is read in order by definition
        if (!(await more())) {
            throw new Error(`the stream ended before its head`);
        }
    }
    const end = text.decode(pending).indexOf(`\r\n\r\n`) + 4;
    const head = text.decode(pending.subarray(0, end));
    pending = pending.subarray(end);
    const frames = async (): Promise<ClientFrame | undefined> => {
        for (;;) {
            if (pending.length >= 2) {
                const length = (pending[1] ?? 0) & 0x7f;
                const masked = ((pending[1] ?? 0) & 0x80) !== 0;
                if (length < 126 && pending.length >= 2 + (masked ? 4 : 0) + length) {
                    const mask = masked ? pending.subarray(2, 6) : new Uint8Array(4);
                    const body = pending.subarray(masked ? 6 : 2, (masked ? 6 : 2) + length).map((byte, at) => byte ^ (mask[at & 3] ?? 0));
                    const frame = { opcode: (pending[0] ?? 0) & 0x0f, masked, payload: text.decode(body) };
                    pending = pending.subarray((masked ? 6 : 2) + length);
                    return frame;
                }
            }
            // oxlint-disable-next-line eslint/no-await-in-loop -- a stream is read in order by definition
            if (!(await more())) {
                return undefined;
            }
        }
    };
    return { head, frames };
};

// The 101 the front answers `head` with, its accept derived from the key as RFC 6455 says.
const switching = async (head: string, accept?: string): Promise<Uint8Array> => {
    const key = /sec-websocket-key: (\S+)/.exec(head)?.[1] ?? ``;
    const digest = await crypto.subtle.digest(`SHA-1`, utf8.encode(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`));
    const derived = btoa(String.fromCharCode(...new Uint8Array(digest)));
    return utf8.encode(`HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-accept: ${accept ?? derived}\r\n\r\n`);
};

const recorded = (): { log: string[]; events: ChannelEvents; closed: Promise<void> } => {
    const log: string[] = [];
    let heardClose: () => void = () => undefined;
    const closed = new Promise<void>((resolve) => {
        heardClose = resolve;
    });
    const events: ChannelEvents = {
        open: () => log.push(`open`),
        heard: () => undefined,
        pane: (bytes) => log.push(`pane ${text.decode(bytes)}`),
        message: (message) => log.push(`message ${message.type}`),
        closed: (code, reason) => {
            log.push(`closed ${code} ${reason}`);
            heardClose();
        },
    };
    return { log, events, closed };
};

const until = async (condition: () => boolean): Promise<void> => {
    for (let tries = 0; !condition(); tries += 1) {
        if (tries > 200) {
            throw new Error(`timed out`);
        }
        // oxlint-disable-next-line eslint/no-await-in-loop -- polling is sequential by definition
        await new Promise((resolve) => setTimeout(resolve, 1));
    }
};

const REQUEST = { host: `sandbox-abcdef012345.sbx.test`, path: `/system/terminal`, query: `ticket=t&session=main` };

describe(`a terminal on a WebTransport stream`, () => {
    it(`opens as a WebSocket, then carries the front's messages and its own, masked, until the front closes it`, async () => {
        const { opening, far } = streamPair();
        const { log, events, closed } = recorded();
        const channel = socketChannel(new StreamSocket(opening, REQUEST), events);
        const { head, frames } = await upgradeOf(far);
        expect(head).toMatch(
            /^GET \/system\/terminal\?ticket=t&session=main HTTP\/1\.1\r\nhost: sandbox-abcdef012345\.sbx\.test\r\nconnection: Upgrade\r\nupgrade: websocket\r\nsec-websocket-version: 13\r\nsec-websocket-key: [A-Za-z0-9+/]{22}==\r\n\r\n$/,
        );

        // The 101 and the first messages in one chunk, as a packet may carry them.
        await far.answer.write(joined(await switching(head), serverFrame(2, utf8.encode(`hi`)), serverFrame(1, utf8.encode(`{"type":"pong"}`))));
        await until(() => log.length === 3);
        expect(log).toEqual([`open`, `pane hi`, `message pong`]);

        channel.send({ type: `resize`, cols: 80, rows: 24 });
        expect(await frames()).toEqual({ opcode: 1, masked: true, payload: `{"type":"resize","cols":80,"rows":24}` });
        await far.answer.write(serverFrame(9, utf8.encode(`7`)));
        expect(await frames()).toEqual({ opcode: 10, masked: true, payload: `7` });

        await far.answer.write(closeFrame(1008, `unauthorized`));
        await closed;
        expect(log.at(-1)).toBe(`closed 1008 unauthorized`);
        channel.close();
        await until(() => true);
        expect(log.filter((line) => line.startsWith(`closed`))).toHaveLength(1);
    });

    it(`joins a message the front sent in fragments, and one past 125 bytes`, async () => {
        const { opening, far } = streamPair();
        const { log, events } = recorded();
        socketChannel(new StreamSocket(opening, REQUEST), events);
        const { head } = await upgradeOf(far);
        const long = `x`.repeat(300);
        await far.answer.write(
            joined(await switching(head), serverFrame(2, utf8.encode(`he`), false), serverFrame(0, utf8.encode(`llo`)), serverFrame(2, utf8.encode(long))),
        );
        await until(() => log.length === 3);
        expect(log).toEqual([`open`, `pane hello`, `pane ${long}`]);
    });

    it(`is heard closing only after close() returns, and says so on the stream`, async () => {
        const { opening, far } = streamPair();
        const { log, events, closed } = recorded();
        const channel = socketChannel(new StreamSocket(opening, REQUEST), events);
        const { head, frames } = await upgradeOf(far);
        await far.answer.write(await switching(head));
        await until(() => log.length === 1);

        channel.close();
        expect(log).toEqual([`open`]);
        await closed;
        expect(log).toEqual([`open`, `closed 1005 `]);
        expect(await frames()).toEqual({ opcode: 8, masked: true, payload: `` });
        expect(await frames()).toBeUndefined();
    });

    it(`closes as a dropped socket on any answer but a WebSocket's, the edge's verdict and a restarting daemon alike`, async () => {
        for (const [answer, reason] of [
            [`HTTP/1.1 502 Bad Gateway\r\nx-intentic-edge: no-tunnel\r\ncontent-length: 0\r\n\r\n`, `HTTP 502`],
            [`HTTP/1.1 503 Service Unavailable\r\nretry-after: 1\r\ncontent-length: 0\r\n\r\n`, `HTTP 503`],
        ] as const) {
            const { opening, far } = streamPair();
            const { log, events, closed } = recorded();
            socketChannel(new StreamSocket(opening, REQUEST), events);
            // oxlint-disable-next-line eslint/no-await-in-loop -- one refusal after another, each on its own stream
            await upgradeOf(far);
            // oxlint-disable-next-line eslint/no-await-in-loop -- as above
            await far.answer.write(utf8.encode(answer));
            // oxlint-disable-next-line eslint/no-await-in-loop -- as above
            await closed;
            expect(log).toEqual([`closed 1006 ${reason}`]);
        }
    });

    it(`refuses a 101 that did not answer its key, and a frame the front never sends`, async () => {
        const unanswered = streamPair();
        const refused = recorded();
        socketChannel(new StreamSocket(unanswered.opening, REQUEST), refused.events);
        await upgradeOf(unanswered.far);
        await unanswered.far.answer.write(await switching(``, `c29tZXRoaW5nIGVsc2U=`));
        await refused.closed;
        expect(refused.log).toEqual([`closed 1006 not a WebSocket`]);

        const masking = streamPair();
        const masked = recorded();
        socketChannel(new StreamSocket(masking.opening, REQUEST), masked.events);
        const { head } = await upgradeOf(masking.far);
        await masking.far.answer.write(joined(await switching(head), Uint8Array.of(0x82, 0x81, 1, 2, 3, 4, 5)));
        await masked.closed;
        expect(masked.log).toEqual([`open`, `closed 1002 a server frame is never masked`]);
    });

    it(`closes as dropped when the stream could not be opened or ends unsaid`, async () => {
        const failed = recorded();
        socketChannel(new StreamSocket(Promise.reject(new Error(`the session is gone`)), REQUEST), failed.events);
        await failed.closed;
        expect(failed.log).toEqual([`closed 1006 `]);

        const { opening, far } = streamPair();
        const ended = recorded();
        socketChannel(new StreamSocket(opening, REQUEST), ended.events);
        const { head } = await upgradeOf(far);
        await far.answer.write(await switching(head));
        await far.answer.close();
        await ended.closed;
        expect(ended.log).toEqual([`open`, `closed 1006 `]);
    });
});
