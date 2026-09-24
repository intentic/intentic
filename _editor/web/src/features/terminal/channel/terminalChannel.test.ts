import { type TerminalFrame, encodeTerminalFrame, terminalFrameReader } from "@intentic/sandbox-contract/terminal-frames";
import { resetTransports, transportFor } from "./webTransport";
import { type ChannelEvents, streamChannel } from "./terminalChannel";

// The front's end of one stream: what the channel wrote, and where the front's answer goes.
interface FarEnd {
    readonly heard: ReadableStreamDefaultReader<Uint8Array>;
    readonly answer: WritableStreamDefaultWriter<Uint8Array>;
}

interface Fake {
    readonly transport: WebTransport;
    readonly nextStream: () => Promise<FarEnd>;
}

// A browser's WebTransport stand-in: each stream the channel opens hands its far end to the test.
const fakeTransport = (ready: Promise<void> = Promise.resolve()): Fake => {
    const waiting: ((far: FarEnd) => void)[] = [];
    const opened: FarEnd[] = [];
    const transport = {
        ready,
        closed: new Promise<WebTransportCloseInfo>(() => undefined),
        close: () => undefined,
        createBidirectionalStream: async () => {
            const toFront = new TransformStream<Uint8Array, Uint8Array>();
            const toBrowser = new TransformStream<Uint8Array, Uint8Array>();
            const far = { heard: toFront.readable.getReader(), answer: toBrowser.writable.getWriter() };
            const wake = waiting.shift();
            if (wake === undefined) {
                opened.push(far);
            } else {
                wake(far);
            }
            return { readable: toBrowser.readable, writable: toFront.writable };
        },
    } as unknown as WebTransport;
    const nextStream = (): Promise<FarEnd> => {
        const far = opened.shift();
        return far === undefined ? new Promise((resolve) => waiting.push(resolve)) : Promise.resolve(far);
    };
    return { transport, nextStream };
};

const utf8 = new TextEncoder();

const joined = (...parts: Uint8Array[]): Uint8Array => {
    const out = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
    let at = 0;
    for (const part of parts) {
        out.set(part, at);
        at += part.length;
    }
    return out;
};

// The request head the channel wrote, then a reader of the frames after it.
const upgradeOf = async (far: FarEnd): Promise<{ head: string; frames: () => Promise<TerminalFrame | undefined> }> => {
    let bytes: Uint8Array = new Uint8Array(0);
    let text = ``;
    while (!text.includes(`\r\n\r\n`)) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- a stream is read in order by definition
        const { value, done } = await far.heard.read();
        if (done) {
            throw new Error(`the stream ended before its head: ${text}`);
        }
        bytes = joined(bytes, value);
        text = new TextDecoder().decode(bytes);
    }
    const end = text.indexOf(`\r\n\r\n`) + 4;
    const read = terminalFrameReader(1024 * 1024);
    const pending = [...read(bytes.subarray(end))];
    const frames = async (): Promise<TerminalFrame | undefined> => {
        while (pending.length === 0) {
            // oxlint-disable-next-line eslint/no-await-in-loop -- a stream is read in order by definition
            const { value, done } = await far.heard.read();
            if (done) {
                return undefined;
            }
            pending.push(...read(value));
        }
        return pending.shift();
    };
    return { head: text.slice(0, end), frames };
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
        pane: (bytes) => log.push(`pane ${new TextDecoder().decode(bytes)}`),
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

const BASE = `https://sandbox-abcdef012345.sbx.test`;
const REQUEST = { origin: BASE, host: `sandbox-abcdef012345.sbx.test`, path: `/system/terminal`, query: `ticket=t&session=main` };
const SWITCHING = utf8.encode(`HTTP/1.1 101 Switching Protocols\r\nupgrade: intentic-terminal\r\nconnection: Upgrade\r\n\r\n`);

describe(`streamChannel`, () => {
    it(`opens as an intentic-terminal upgrade, then carries frames both ways until the front closes it`, async () => {
        const fake = fakeTransport();
        const { log, events, closed } = recorded();
        const channel = streamChannel(fake.transport, REQUEST, events);
        const far = await fake.nextStream();
        const { head, frames } = await upgradeOf(far);
        expect(head).toBe(
            `GET /system/terminal?ticket=t&session=main HTTP/1.1\r\nhost: sandbox-abcdef012345.sbx.test\r\nconnection: Upgrade\r\nupgrade: intentic-terminal\r\n\r\n`,
        );

        // The 101 and the first frames in one chunk, as a packet may carry them.
        await far.answer.write(
            joined(
                SWITCHING,
                encodeTerminalFrame({ kind: `pane`, bytes: utf8.encode(`hi`) }),
                encodeTerminalFrame({ kind: `message`, text: `{"type":"pong"}` }),
            ),
        );
        await until(() => log.length === 3);
        expect(log).toEqual([`open`, `pane hi`, `message pong`]);

        channel.send({ type: `resize`, cols: 80, rows: 24 });
        expect(await frames()).toEqual({ kind: `message`, text: `{"type":"resize","cols":80,"rows":24}` });
        await far.answer.write(encodeTerminalFrame({ kind: `ping`, bytes: Uint8Array.of(7) }));
        expect(await frames()).toEqual({ kind: `pong`, bytes: Uint8Array.of(7) });

        await far.answer.write(encodeTerminalFrame({ kind: `close`, code: 1008, reason: `unauthorized` }));
        await closed;
        expect(log.at(-1)).toBe(`closed 1008 unauthorized`);
        channel.close();
        await until(() => true);
        expect(log.filter((line) => line.startsWith(`closed`))).toHaveLength(1);
    });

    it(`is heard closing only after close() returns, and says so on the stream`, async () => {
        const fake = fakeTransport();
        const { log, events, closed } = recorded();
        const channel = streamChannel(fake.transport, REQUEST, events);
        const far = await fake.nextStream();
        const { frames } = await upgradeOf(far);
        await far.answer.write(SWITCHING);
        await until(() => log.length === 1);

        channel.close();
        expect(log).toEqual([`open`]);
        await closed;
        expect(log).toEqual([`open`, `closed 1005 `]);
        expect(await frames()).toEqual({ kind: `close`, reason: `` });
        expect(await frames()).toBeUndefined();
    });
});

describe(`a refused stream`, () => {
    const original = globalThis.WebTransport;
    let fake: Fake;

    beforeEach(() => {
        resetTransports();
        localStorage.clear();
        fake = fakeTransport();
        // A constructor, as `new WebTransport(url)` needs, handing out the test's stand-in.
        globalThis.WebTransport = function WebTransport() {
            return fake.transport;
        } as unknown as typeof globalThis.WebTransport;
    });

    afterEach(() => {
        resetTransports();
        globalThis.WebTransport = original;
    });

    // The origin's session tried and opened, as a page holds it once a terminal has asked there.
    const proven = async (): Promise<WebTransport | undefined> => {
        await transportFor(BASE);
        await new Promise((resolve) => setTimeout(resolve, 0));
        return transportFor(BASE);
    };

    it(`sends its origin to WebSockets when what answered is not a terminal`, async () => {
        expect(await proven()).toBe(fake.transport);
        const { log, events, closed } = recorded();
        streamChannel(fake.transport, REQUEST, events);
        const far = await fake.nextStream();
        await upgradeOf(far);
        await far.answer.write(utf8.encode(`HTTP/1.1 426 Upgrade Required\r\ncontent-length: 0\r\n\r\n`));
        await closed;
        expect(log).toEqual([`closed 1006 HTTP 426`]);
        expect(await transportFor(BASE)).toBeUndefined();
    });

    it(`keeps the session when the edge says the sandbox is away`, async () => {
        expect(await proven()).toBe(fake.transport);
        const { events, closed } = recorded();
        streamChannel(fake.transport, REQUEST, events);
        const far = await fake.nextStream();
        await upgradeOf(far);
        await far.answer.write(utf8.encode(`HTTP/1.1 502 Bad Gateway\r\nx-intentic-edge: no-tunnel\r\ncontent-length: 0\r\n\r\n`));
        await closed;
        expect(await transportFor(BASE)).toBe(fake.transport);
    });
});
