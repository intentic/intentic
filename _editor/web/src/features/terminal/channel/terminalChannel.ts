import { EDGE_VERDICT_HEADER } from "@intentic/sandbox-contract";
import type { TerminalClientMessage, TerminalServerMessage } from "@intentic/sandbox-contract/front-wire";
import { TERMINAL_UPGRADE, type TerminalFrame, encodeTerminalFrame, terminalFrameReader } from "@intentic/sandbox-contract/terminal-frames";
import { forgetTransport, refuseTransport } from "./webTransport";

// A terminal's socket whichever way it rides: frames on a WebTransport stream the edge relays as an `intentic-terminal`
// upgrade, or a WebSocket. Either delivers the pane's bytes, the server's messages and exactly one close, which arrives
// after `close()` returns, as a WebSocket's close event does.

export interface ChannelEvents {
    readonly open: () => void;
    // Anything at all from the server, which is what proves the channel alive.
    readonly heard: () => void;
    readonly pane: (bytes: Uint8Array) => void;
    readonly message: (message: TerminalServerMessage) => void;
    readonly closed: (code: number, reason: string) => void;
}

export interface TerminalChannel {
    readonly send: (message: TerminalClientMessage) => void;
    readonly close: () => void;
}

// RFC 6455's codes for a close that named no code, and for one that never arrived.
const NO_CODE = 1005;
const ABNORMAL = 1006;

// A request head past this is no answer the front gives.
const HEAD_MAX = 16 * 1024;

// A paste's worth, as the front caps a message.
const FRAME_MAX = 16 * 1024 * 1024;

const parse = (text: string): TerminalServerMessage | undefined => {
    try {
        return JSON.parse(text) as TerminalServerMessage;
    } catch {
        // silent-catch: a message that is not JSON is no message; the channel reads on.
        return undefined;
    }
};

export const webSocketChannel = (url: string, events: ChannelEvents): TerminalChannel => {
    const ws = new WebSocket(url);
    // Binary frames arrive as ArrayBuffers, straight to xterm with no Blob copy.
    ws.binaryType = `arraybuffer`;
    ws.addEventListener(`open`, () => events.open());
    ws.addEventListener(`message`, (event) => {
        events.heard();
        if (event.data instanceof ArrayBuffer) {
            events.pane(new Uint8Array(event.data));
            return;
        }
        const message = parse(String(event.data));
        if (message !== undefined) {
            events.message(message);
        }
    });
    ws.addEventListener(`close`, (event) => events.closed(event.code, event.reason));
    return {
        send: (message) => {
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify(message));
            }
        },
        close: () => ws.close(),
    };
};

export interface StreamRequest {
    readonly origin: string;
    readonly host: string;
    readonly path: string;
    readonly query: string;
}

const utf8 = new TextEncoder();

// Where a response head ends, or -1 while it has not.
const headEnd = (bytes: Uint8Array): number => {
    for (let at = 0; at + 3 < bytes.length; at += 1) {
        if (bytes[at] === 13 && bytes[at + 1] === 10 && bytes[at + 2] === 13 && bytes[at + 3] === 10) {
            return at;
        }
    }
    return -1;
};

interface Head {
    readonly status: number;
    readonly verdict: boolean;
}

const headOf = (bytes: Uint8Array): Head => {
    const lines = new TextDecoder().decode(bytes).split(`\r\n`);
    const status = Number(lines[0]?.split(` `)[1]);
    const verdict = lines.slice(1).some((line) => line.toLowerCase().startsWith(`${EDGE_VERDICT_HEADER}:`));
    return { status: Number.isNaN(status) ? 0 : status, verdict };
};

const joined = (first: Uint8Array, second: Uint8Array): Uint8Array => {
    const both = new Uint8Array(first.length + second.length);
    both.set(first);
    both.set(second, first.length);
    return both;
};

// A stream torn down already rejects its writes, closes and cancels; the channel's end reaches its owner once, through
// `closed`, so a step's own rejection says nothing more.
const settled = (step: Promise<unknown> | undefined): void => {
    // silent-catch: see above; the end is reported by `closed`, never by one stream step.
    void step?.catch(() => undefined);
};

export const streamChannel = (transport: WebTransport, request: StreamRequest, events: ChannelEvents): TerminalChannel => {
    let writer: WritableStreamDefaultWriter<Uint8Array> | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let upgraded = false;
    let ended = false;
    // Delivered as a task of its own, so a caller replacing this channel has done so before its close is heard.
    const end = (code: number, reason: string): void => {
        if (ended) {
            return;
        }
        ended = true;
        queueMicrotask(() => events.closed(code, reason));
        settled(reader?.cancel());
    };
    const write = (frame: TerminalFrame): void => {
        settled(writer?.write(encodeTerminalFrame(frame)));
    };
    const serve = async (): Promise<void> => {
        let stream: WebTransportBidirectionalStream;
        try {
            stream = await transport.createBidirectionalStream();
        } catch {
            forgetTransport(request.origin, transport);
            return end(ABNORMAL, ``);
        }
        writer = stream.writable.getWriter();
        reader = stream.readable.getReader();
        if (ended) {
            settled(writer.close());
            settled(reader.cancel());
            return;
        }
        settled(
            writer.write(
                    utf8.encode(
                        `GET ${request.path}?${request.query} HTTP/1.1\r\nhost: ${request.host}\r\nconnection: Upgrade\r\nupgrade: ${TERMINAL_UPGRADE}\r\n\r\n`,
                    ),
            ),
        );
        const frames = terminalFrameReader(FRAME_MAX);
        let head: Uint8Array = new Uint8Array(0);
        for (;;) {
            // oxlint-disable-next-line eslint/no-await-in-loop -- a stream is read in order by definition
            const { value, done } = await reader.read();
            if (done || ended) {
                return end(ABNORMAL, ``);
            }
            let chunk: Uint8Array = value;
            if (!upgraded) {
                head = joined(head, chunk);
                const at = headEnd(head);
                if (at === -1) {
                    if (head.length > HEAD_MAX) {
                        return end(ABNORMAL, ``);
                    }
                    continue;
                }
                const answered = headOf(head.subarray(0, at));
                if (answered.status !== 101) {
                    // The edge's verdict is the sandbox's absence; any other refusal says terminals do not ride streams here.
                    if (!answered.verdict) {
                        refuseTransport(request.origin, transport);
                    }
                    return end(ABNORMAL, `HTTP ${answered.status}`);
                }
                upgraded = true;
                events.open();
                chunk = head.subarray(at + 4);
            }
            for (const frame of frames(chunk)) {
                events.heard();
                switch (frame.kind) {
                    case `pane`:
                        events.pane(frame.bytes);
                        break;
                    case `message`: {
                        const message = parse(frame.text);
                        if (message !== undefined) {
                            events.message(message);
                        }
                        break;
                    }
                    case `ping`:
                        write({ kind: `pong`, bytes: frame.bytes });
                        break;
                    case `pong`:
                        break;
                    case `close`:
                        return end(frame.code ?? NO_CODE, frame.reason);
                }
            }
        }
    };
    void serve().catch(() => end(ABNORMAL, ``));
    return {
        send: (message) => {
            if (upgraded && !ended) {
                write({ kind: `message`, text: JSON.stringify(message) });
            }
        },
        close: () => {
            if (ended) {
                return;
            }
            write({ kind: `close`, reason: `` });
            settled(writer?.close());
            end(NO_CODE, ``);
        },
    };
};
