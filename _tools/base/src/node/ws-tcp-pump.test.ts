import { EventEmitter } from "node:events";
import { BUFFER_HIGH, BUFFER_LOW, DRAIN_POLL_MS, binaryFrame, type PumpTcp, pumpTcpWebSocket } from "./ws-tcp-pump.js";

// The pump between a fake TCP socket and a fake WebSocket: what each direction writes, and when each side is paused.

class FakeTcp extends EventEmitter implements PumpTcp {
    readonly written: Buffer[] = [];
    paused = true;
    destroyed = false;
    writableLength = 0;
    // Whether the next writes are taken at once; false is a reader that has stopped reading.
    accepting = true;

    write(chunk: Uint8Array): boolean {
        this.written.push(Buffer.from(chunk));
        if (!this.accepting) {
            this.writableLength += chunk.byteLength;
        }
        return this.accepting;
    }
    pause(): this {
        this.paused = true;
        return this;
    }
    resume(): this {
        this.paused = false;
        return this;
    }
    // Test side: the reader caught up.
    drained(): void {
        this.accepting = true;
        this.writableLength = 0;
        this.emit("drain");
    }
}

const fakeWs = (pausable: boolean) => {
    const state = { sent: [] as Uint8Array[], buffered: 0, pauses: 0, resumes: 0 };
    const ws = {
        send: (frame: Uint8Array<ArrayBuffer>) => {
            state.sent.push(frame);
        },
        bufferedAmount: () => state.buffered,
        ...(pausable ? { pause: () => void (state.pauses += 1), resume: () => void (state.resumes += 1) } : {}),
    };
    return { state, ws };
};

const text = (frames: readonly Uint8Array[]): string => Buffer.concat(frames).toString();

/* Reading a frame off the wire is the one thing on this transport that can corrupt an SSH stream silently. */
describe("binaryFrame", () => {
    it("takes a Buffer as it is: what `ws` hands over for a binary frame", () => {
        expect(binaryFrame(Buffer.from("SSH-2.0-OpenSSH_9.6"))?.toString()).toBe("SSH-2.0-OpenSSH_9.6");
    });

    it("takes a whole ArrayBuffer: what a browser-shaped client sends", () => {
        const bytes = new TextEncoder().encode("hello");
        expect(binaryFrame(bytes.buffer)?.toString()).toBe("hello");
    });

    /* The case that matters. */
    it("takes exactly a view's own window, never its backing buffer", () => {
        const backing = new TextEncoder().encode("XXXpayloadXXX");
        const view = new Uint8Array(backing.buffer, 3, 7);

        expect(binaryFrame(view)?.toString()).toBe("payload");
    });

    it("ignores a text frame rather than guessing at an encoding for it", () => {
        expect(binaryFrame("not part of this protocol")).toBeUndefined();
        expect(binaryFrame(undefined)).toBeUndefined();
    });
});

test("queued bytes go first, then TCP's own, each copied out of the chunk it came in", () => {
    const tcp = new FakeTcp();
    const { state, ws } = fakeWs(true);
    pumpTcpWebSocket(tcp, ws, { queued: [Buffer.from("SSH-2.0-a\r\n")], onOverflow: () => {} });
    const chunk = Buffer.from("more");
    tcp.emit("data", chunk);
    chunk.fill(0);
    expect(tcp.paused).toBe(false);
    expect(text(state.sent)).toBe("SSH-2.0-a\r\nmore");
});

// The machine once wrote a text frame into ssh's byte stream while the daemon dropped it: one protocol read two ways.
test("a text frame never reaches TCP; a binary one does", () => {
    const tcp = new FakeTcp();
    const pump = pumpTcpWebSocket(tcp, fakeWs(true).ws, { onOverflow: () => {} });
    expect(pump.inbound("SSH-2.0-sandbox\r\n")).toBe(false);
    expect(pump.inbound(new Uint8Array(Buffer.from("SSH-2.0-sandbox\r\n")).buffer)).toBe(true);
    expect(text(tcp.written)).toBe("SSH-2.0-sandbox\r\n");
});

test("TCP pauses while the WebSocket holds more than BUFFER_HIGH, and resumes under BUFFER_LOW", () => {
    jest.useFakeTimers();
    try {
        const tcp = new FakeTcp();
        const { state, ws } = fakeWs(true);
        pumpTcpWebSocket(tcp, ws, { onOverflow: () => {} });
        state.buffered = BUFFER_HIGH + 1;
        tcp.emit("data", Buffer.from("x"));
        expect(tcp.paused).toBe(true);
        state.buffered = BUFFER_LOW;
        jest.advanceTimersByTime(DRAIN_POLL_MS);
        expect(tcp.paused).toBe(true);
        state.buffered = BUFFER_LOW - 1;
        jest.advanceTimersByTime(DRAIN_POLL_MS);
        expect(tcp.paused).toBe(false);
    } finally {
        jest.useRealTimers();
    }
});

// Neither end once looked at what `socket.write` answered, so a slow reader buffered the far end's whole send.
test("a write TCP cannot take pauses a pausable WebSocket once, until TCP drains", () => {
    const tcp = new FakeTcp();
    const { state, ws } = fakeWs(true);
    const pump = pumpTcpWebSocket(tcp, ws, { onOverflow: () => {} });
    tcp.accepting = false;
    pump.inbound(new Uint8Array(4));
    pump.inbound(new Uint8Array(4));
    expect(state.pauses).toBe(1);
    expect(state.resumes).toBe(0);
    tcp.drained();
    expect(state.resumes).toBe(1);
});

test("a WebSocket that cannot pause has its stream dropped once more than the ceiling waits for TCP", () => {
    const tcp = new FakeTcp();
    let overflowed = 0;
    const pump = pumpTcpWebSocket(tcp, fakeWs(false).ws, { ceiling: 8, onOverflow: () => void (overflowed += 1) });
    tcp.accepting = false;
    pump.inbound(new Uint8Array(8));
    expect(overflowed).toBe(0);
    pump.inbound(new Uint8Array(1));
    expect(overflowed).toBe(1);
});

test("stop lets go of TCP's data", () => {
    const tcp = new FakeTcp();
    const { state, ws } = fakeWs(true);
    pumpTcpWebSocket(tcp, ws, { onOverflow: () => {} }).stop();
    tcp.emit("data", Buffer.from("late"));
    expect(state.sent).toHaveLength(0);
});
