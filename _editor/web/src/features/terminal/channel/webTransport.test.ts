import { resetTransports, transportFor } from "./webTransport";

const BASE = `https://sandbox-abcdef012345.sbx.test`;

// Every session the code under test asked for, by URL, and what it was handed; each ready or refused as the test says.
const opened: string[] = [];
const made: WebTransport[] = [];
let ready: () => Promise<void> = () => Promise.resolve();

const original = globalThis.WebTransport;

// A session's outcome is settled off its caller's path; one task later it has been.
const settled = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
    resetTransports();
    localStorage.clear();
    opened.length = 0;
    made.length = 0;
    ready = () => Promise.resolve();
    globalThis.WebTransport = function WebTransport(url: string) {
        opened.push(url);
        const session = { ready: ready(), closed: new Promise(() => undefined), close: () => undefined };
        made.push(session as unknown as WebTransport);
        return session;
    } as unknown as typeof globalThis.WebTransport;
});

afterEach(() => {
    resetTransports();
    globalThis.WebTransport = original;
});

describe(`transportFor`, () => {
    it(`asks only where WebTransport exists and the address is the edge's https`, async () => {
        expect(await transportFor(`http://127.0.0.1:7443`)).toBeUndefined();
        globalThis.WebTransport = undefined as unknown as typeof globalThis.WebTransport;
        expect(await transportFor(BASE)).toBeUndefined();
        expect(opened).toEqual([]);
    });

    it(`answers a WebSocket at once where no session has opened, and holds the one it tries there`, async () => {
        expect(await transportFor(`${BASE}/`)).toBeUndefined();
        expect(opened).toEqual([`${BASE}/system/transport`]);
        await settled();
        expect(await transportFor(BASE)).toBe(made[0]);
        expect(await transportFor(BASE)).toBe(made[0]);
        expect(opened).toHaveLength(1);
    });

    it(`opens a WebSocket immediately after a reload, even where WebTransport worked before`, async () => {
        await transportFor(BASE);
        await settled();
        resetTransports();
        let connect: () => void = () => undefined;
        ready = () => new Promise((resolve) => { connect = resolve; });
        // The handshake cannot finish until after this call returns: awaiting it here would hang the test.
        expect(await transportFor(BASE)).toBeUndefined();
        expect(await transportFor(BASE)).toBeUndefined();
        expect(made).toHaveLength(2);
        connect();
        await settled();
        expect(await transportFor(BASE)).toBe(made[1]);
    });

    it(`sends an origin whose session never opened to WebSockets for a while, across reloads`, async () => {
        ready = () => Promise.reject(new Error(`no UDP here`));
        expect(await transportFor(BASE)).toBeUndefined();
        await settled();
        ready = () => Promise.resolve();
        expect(await transportFor(BASE)).toBeUndefined();
        resetTransports();
        expect(await transportFor(BASE)).toBeUndefined();
        expect(opened).toHaveLength(1);
        expect(await transportFor(BASE, Date.now() + 11 * 60_000)).toBeUndefined();
        await settled();
        expect(made).toHaveLength(2);
        expect(await transportFor(BASE)).toBe(made[1]);
    });

    it(`stops waiting where a proven origin's session fails on this network`, async () => {
        await transportFor(BASE);
        await settled();
        resetTransports();
        ready = () => Promise.reject(new Error(`this network carries no UDP`));
        expect(await transportFor(BASE)).toBeUndefined();
        expect(await transportFor(BASE)).toBeUndefined();
        expect(opened).toHaveLength(2);
    });
});
