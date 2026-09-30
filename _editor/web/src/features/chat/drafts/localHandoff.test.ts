// jsdom: the handoff is kept in this tab's session storage.
import "@intentic/testing/dom";
import { freshImport } from "@intentic/testing/bun";

// The arrival is a chunk of its own (localHandoffArrival.ts); what the router half owes it is only the call.
const arrivals: string[] = [];
jest.mock("./localHandoffArrival", () => ({ startLocalHandoff: () => arrivals.push(`arrive`) }));

const { HANDOFF_KEY, HANDOFF_STALE_MS, handoffWaiting, keepHandoff, parseHandoff, receiveHandoff, takeHandoff } = await import("./localHandoff");

// Someone is signed in: the arrival's to wait on, not this half's.
const signedIn = (): boolean => true;

// What the desktop app puts on the link: base64url of the JSON.
const encode = (value: unknown): string => Buffer.from(JSON.stringify(value), `utf8`).toString(`base64url`);

const TOKEN = `aB3_-`.repeat(8);

// The arrival is imported when it is started; its import settles on a later turn.
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const handoff = { url: `http://127.0.0.1:47123/workspace/raw?path=Reports%2FQ3.docx`, token: TOKEN, name: `Q3.docx` };

beforeEach(() => {
    sessionStorage.clear();
    arrivals.length = 0;
    window.__INTENTIC_LOCAL__ = undefined;
});

describe(`reading a handoff off the link`, () => {
    it(`reads the file, its bearer and its name`, () => {
        expect(parseHandoff(encode(handoff))).toEqual(handoff);
        // A name in any script, and the padding a plain base64 encoder leaves on.
        const named = { ...handoff, url: `http://127.0.0.1:9/workspace/raw?path=a`, name: `Zażółć gęślą.xlsx` };
        const padded = Buffer.from(JSON.stringify(named), `utf8`).toString(`base64`).replaceAll(`+`, `-`).replaceAll(`/`, `_`);
        expect(padded.endsWith(`=`)).toBe(true);
        expect(parseHandoff(padded)).toEqual(named);
    });

    it(`takes a bearer of 32 to 128 url-safe characters, and nothing else`, () => {
        expect(parseHandoff(encode({ ...handoff, token: `a`.repeat(32) }))?.token).toBe(`a`.repeat(32));
        expect(parseHandoff(encode({ ...handoff, token: `a`.repeat(128) }))?.token).toBe(`a`.repeat(128));
        for (const token of [`a`.repeat(31), `a`.repeat(129), `${`a`.repeat(40)}+`, `${`a`.repeat(40)}=`, ``]) {
            expect(parseHandoff(encode({ ...handoff, token }))).toBeUndefined();
        }
    });

    it(`takes a file only from the app's own loopback server's raw route over plain http`, () => {
        for (const url of [
            `http://localhost:47123/workspace/raw?path=a`,
            `http://127.0.0.1:47123/workspace/tree`,
            `http://127.0.0.1:47123/?path=a`,
            `https://127.0.0.1:47123/workspace/raw?path=a`,
            `http://example.com/workspace/raw?path=a`,
            `http://127.0.0.2:47123/workspace/raw?path=a`,
            `http://[::1]:47123/workspace/raw?path=a`,
            `http://user:secret@127.0.0.1:47123/workspace/raw?path=a`,
            `file:///etc/passwd`,
            `not a url`,
        ]) {
            expect(parseHandoff(encode({ ...handoff, url }))).toBeUndefined();
        }
    });

    it(`takes only a plain file name`, () => {
        for (const name of [``, `.`, `..`, `../Q3.docx`, `Reports/Q3.docx`, `Reports\\Q3.docx`, `Q3\u0000.docx`, `Q3\n.docx`, `a`.repeat(256)]) {
            expect(parseHandoff(encode({ ...handoff, name }))).toBeUndefined();
        }
        expect(parseHandoff(encode({ ...handoff, name: `a`.repeat(255) }))?.name).toBe(`a`.repeat(255));
    });

    it(`reads nothing out of a link that isn't one`, () => {
        expect(parseHandoff(`!!!`)).toBeUndefined();
        expect(parseHandoff(Buffer.from(`not json`).toString(`base64url`))).toBeUndefined();
        expect(parseHandoff(encode([handoff]))).toBeUndefined();
        expect(parseHandoff(encode({ url: handoff.url, token: handoff.token }))).toBeUndefined();
        expect(parseHandoff(``)).toBeUndefined();
    });
});

describe(`keeping it until a chat can take it`, () => {
    it(`hands it over once, fresh to the last millisecond of a quarter of an hour`, () => {
        keepHandoff(handoff, 1_000);
        expect(handoffWaiting(1_000 + HANDOFF_STALE_MS)).toBe(true);
        expect(takeHandoff(1_000 + HANDOFF_STALE_MS)).toEqual(handoff);
        expect(takeHandoff(1_000 + HANDOFF_STALE_MS)).toBeUndefined();
        expect(sessionStorage.getItem(HANDOFF_KEY)).toBeNull();
    });

    it(`drops a stale one unread`, () => {
        keepHandoff(handoff, 1_000);
        expect(handoffWaiting(1_001 + HANDOFF_STALE_MS)).toBe(false);
        expect(takeHandoff(1_001 + HANDOFF_STALE_MS)).toBeUndefined();
        expect(sessionStorage.getItem(HANDOFF_KEY)).toBeNull();
    });

    it(`drops one that no longer reads as a handoff`, () => {
        sessionStorage.setItem(HANDOFF_KEY, JSON.stringify({ ...handoff, url: `https://example.com/x`, at: 1_000 }));
        expect(takeHandoff(1_000)).toBeUndefined();
        sessionStorage.setItem(HANDOFF_KEY, `{`);
        expect(takeHandoff(1_000)).toBeUndefined();
        expect(sessionStorage.getItem(HANDOFF_KEY)).toBeNull();
    });
});

describe(`the router's half`, () => {
    it(`keeps a handoff and replays the navigation without it, every other key riding along`, async () => {
        const to = { path: `/workspace`, query: { handoff: encode(handoff), sandbox: `box-2` }, hash: `#top` };
        expect(receiveHandoff(to, signedIn)).toEqual({ path: `/workspace`, query: { sandbox: `box-2` }, hash: `#top`, replace: true });
        expect(takeHandoff()).toEqual(handoff);
        await settle();
        expect(arrivals).toEqual([`arrive`]);
    });

    it(`takes a handoff that doesn't validate out of the address too, and keeps nothing`, async () => {
        expect(receiveHandoff({ path: `/`, query: { handoff: `!!!` }, hash: `` }, signedIn)).toEqual({
            path: `/`,
            query: {},
            hash: ``,
            replace: true,
        });
        expect(handoffWaiting()).toBe(false);
        await settle();
        expect(arrivals).toEqual([]);
    });

    it(`is inert without the query`, async () => {
        expect(receiveHandoff({ path: `/workspace`, query: { sandbox: `box-2` }, hash: `` }, signedIn)).toBe(true);
        await settle();
        expect(arrivals).toEqual([]);
    });

    it(`does nothing in a local window, which is never where the app hands a file`, async () => {
        window.__INTENTIC_LOCAL__ = { daemonUrl: `http://127.0.0.1:4100`, token: `t`, id: `f`, name: `notes`, path: `/home/me/notes` };
        expect(receiveHandoff({ path: `/local`, query: { handoff: encode(handoff) }, hash: `` }, signedIn)).toBe(true);
        expect(handoffWaiting()).toBe(false);
        await settle();
        expect(arrivals).toEqual([]);
    });

    /* THE REGRESSION: the desktop sign-in's own `handoff` was taken off its landing, and no desktop sign-in could finish. */
    it(`leaves the desktop sign-in's landing alone, whose handoff is the parked sign-in rather than a file`, async () => {
        const to = { path: `/desktop-auth/complete`, query: { handoff: `cm1row0id`, verifier: `v`.repeat(64), profile: `desk` }, hash: `` };
        expect(receiveHandoff(to, signedIn)).toBe(true);
        expect(handoffWaiting()).toBe(false);
        await settle();
        expect(arrivals).toEqual([]);
    });

    it(`brings a file handed over before the sign-in in on the navigation after its landing`, async () => {
        const reloaded = await freshImport<typeof import("./localHandoff")>(`./localHandoff`, import.meta.url);
        reloaded.keepHandoff(handoff);
        const landing = { path: `/desktop-auth/complete`, query: { handoff: `cm1row0id`, verifier: `v` }, hash: `` };
        expect(reloaded.receiveHandoff(landing, signedIn)).toBe(true);
        await settle();
        expect(arrivals).toEqual([]);
        expect(reloaded.receiveHandoff({ path: `/`, query: {}, hash: `` }, signedIn)).toBe(true);
        await settle();
        expect(arrivals).toEqual([`arrive`]);
    });

    it(`looks once, on a page's first navigation, for a handoff kept before a reload`, async () => {
        const reloaded = await freshImport<typeof import("./localHandoff")>(`./localHandoff`, import.meta.url);
        reloaded.keepHandoff(handoff);
        expect(reloaded.receiveHandoff({ path: `/workspace`, query: {}, hash: `` }, signedIn)).toBe(true);
        expect(reloaded.receiveHandoff({ path: `/chat`, query: {}, hash: `` }, signedIn)).toBe(true);
        await settle();
        expect(arrivals).toEqual([`arrive`]);
    });
});
