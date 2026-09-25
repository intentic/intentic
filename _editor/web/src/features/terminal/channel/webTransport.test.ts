import { resetTransports, transportFor } from "./webTransport";

const BASE = `https://sandbox-abcdef012345.sbx.test`;

// Every session the code under test asked for, by URL, and what it was handed; each opening or failing as the test says.
const opened: string[] = [];
const made: WebTransport[] = [];
let outcome: () => { ready: Promise<void>; closed: Promise<WebTransportCloseInfo> } = () => ({
    ready: Promise.resolve(),
    closed: new Promise(() => undefined),
});

const original = globalThis.WebTransport;

// A session's outcome is settled off its caller's path; one task later it has been.
const settled = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
    resetTransports();
    opened.length = 0;
    made.length = 0;
    outcome = () => ({ ready: Promise.resolve(), closed: new Promise(() => undefined) });
    globalThis.WebTransport = function WebTransport(url: string) {
        opened.push(url);
        const session = { ...outcome(), close: () => undefined };
        made.push(session as unknown as WebTransport);
        return session;
    } as unknown as typeof globalThis.WebTransport;
});

afterEach(() => {
    resetTransports();
    globalThis.WebTransport = original;
});

describe(`transportFor`, () => {
    it(`never asks where the edge declared no WebTransport, the browser has none, or the address is no edge's https`, () => {
        expect(transportFor(BASE, false)).toBeUndefined();
        expect(transportFor(`http://127.0.0.1:7443`, true)).toBeUndefined();
        globalThis.WebTransport = undefined as unknown as typeof globalThis.WebTransport;
        expect(transportFor(BASE, true)).toBeUndefined();
        expect(opened).toEqual([]);
    });

    it(`answers a WebSocket until the declared session is ready, then holds that one session`, async () => {
        expect(transportFor(`${BASE}/`, true)).toBeUndefined();
        expect(opened).toEqual([`${BASE}/system/transport`]);
        await settled();
        expect(transportFor(BASE, true)).toBe(made[0]);
        expect(transportFor(BASE, true)).toBe(made[0]);
        expect(opened).toHaveLength(1);
    });

    it(`waits on no handshake: a session still opening leaves every terminal on its WebSocket`, async () => {
        let connect: () => void = () => undefined;
        outcome = () => ({ ready: new Promise((resolve) => (connect = resolve)), closed: new Promise(() => undefined) });
        expect(transportFor(BASE, true)).toBeUndefined();
        expect(transportFor(BASE, true)).toBeUndefined();
        expect(made).toHaveLength(1);
        connect();
        await settled();
        expect(transportFor(BASE, true)).toBe(made[0]);
    });

    it(`remembers nothing about a session that failed: the next connect simply asks again`, async () => {
        outcome = () => ({ ready: Promise.reject(new Error(`no UDP here`)), closed: Promise.reject(new Error(`no UDP here`)) });
        expect(transportFor(BASE, true)).toBeUndefined();
        await settled();
        outcome = () => ({ ready: Promise.resolve(), closed: new Promise(() => undefined) });
        expect(transportFor(BASE, true)).toBeUndefined();
        await settled();
        expect(transportFor(BASE, true)).toBe(made[1]);
        expect(opened).toHaveLength(2);
        expect(localStorage.length).toBe(0);
    });

    it(`forgets a session that closed, so a terminal after it never rides a dead one`, async () => {
        let close: () => void = () => undefined;
        outcome = () => ({ ready: Promise.resolve(), closed: new Promise((resolve) => (close = () => resolve({ closeCode: 0, reason: `` }))) });
        transportFor(BASE, true);
        await settled();
        expect(transportFor(BASE, true)).toBe(made[0]);
        close();
        await settled();
        expect(transportFor(BASE, true)).toBeUndefined();
        expect(made).toHaveLength(2);
    });
});
