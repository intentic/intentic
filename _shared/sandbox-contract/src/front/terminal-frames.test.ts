import { readFileSync } from "node:fs";
import { TERMINAL_UPGRADE, type TerminalFrame, WEBTRANSPORT_PATH, encodeTerminalFrame, terminalFrameReader } from "./terminal-frames.js";

interface FixtureFrame {
    readonly kind: TerminalFrame["kind"];
    readonly bytes?: string;
    readonly text?: string;
    readonly code?: number;
    readonly reason?: string;
}

const FIXTURE = JSON.parse(readFileSync(new URL("./terminal-frames.fixture.json", import.meta.url), "utf8")) as {
    session: string;
    upgrade: string;
    frames: { encoded: string; frame: FixtureFrame }[];
    unreadable: string[];
};

const hex = (value: string): Uint8Array => Uint8Array.from(value.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));

const frameOf = ({ kind, bytes, text, code, reason }: FixtureFrame): TerminalFrame => {
    if (kind === "message") {
        return { kind, text: text ?? "" };
    }
    if (kind === "close") {
        return code === undefined ? { kind, reason: reason ?? "" } : { kind, code, reason: reason ?? "" };
    }
    return { kind, bytes: hex(bytes ?? "") };
};

const MAX = 16 * 1024 * 1024;

test("the session's path and the upgrade are the ones the edge and the front answer", () => {
    expect(FIXTURE.session).toBe(WEBTRANSPORT_PATH);
    expect(FIXTURE.upgrade).toBe(TERMINAL_UPGRADE);
});

test("every frame the shared fixture names encodes to its bytes and reads back", () => {
    expect(FIXTURE.frames.length).toBeGreaterThan(5);
    for (const { encoded, frame } of FIXTURE.frames) {
        expect(encodeTerminalFrame(frameOf(frame))).toEqual(hex(encoded));
        expect(terminalFrameReader(MAX)(hex(encoded))).toEqual([frameOf(frame)]);
    }
});

test("frames read the same however the stream's chunks cut them", () => {
    const whole = hex(FIXTURE.frames.map(({ encoded }) => encoded).join(""));
    const expected = FIXTURE.frames.map(({ frame }) => frameOf(frame));
    for (const size of [1, 2, 3, 7, whole.length]) {
        const read = terminalFrameReader(MAX);
        const frames: TerminalFrame[] = [];
        for (let at = 0; at < whole.length; at += size) {
            frames.push(...read(whole.slice(at, at + size)));
        }
        expect(frames).toEqual(expected);
    }
});

test("a frame no front sends ends the stream", () => {
    for (const encoded of FIXTURE.unreadable) {
        expect(() => terminalFrameReader(MAX)(hex(encoded))).toThrow();
    }
});
