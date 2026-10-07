// A credential Google handed back and this module refused (unreadable, or already near expiry by this machine's
// clock). On a page that shows Google's own button the refusal used to end the mint: the page took the undefined for a
// dismissal and said nothing, and every later press of the same button was dropped, since no mint was waiting on it.
import "@intentic/testing/dom";
import { freshImport } from "@intentic/testing/bun";

// Configured client id, overriding bun.setup.ts's empty default. Assigned, not `??=`, since the setup file already ran.
(() => {
    globalThis.window.env = {
        production: false,
        api: { url: `http://localhost` },
        auth: { googleClientId: `client-id` },
        analytics: { posthogKey: ``, posthogHost: `` },
        afterSignOut: ``,
    };
})();

// An ordinary browser: the desktop webview's own posture is useGoogleIdentity.desktop.test.ts's subject.
jest.mock(`../../app/environments/desktop`, () => ({ desktopVersion: () => undefined }));
// The gate's funnel event, recorded rather than sent.
const track = jest.fn();
jest.mock(`../../app/analytics`, () => ({ track }));

// One module instance per test: a mint nothing settled is still in flight, and GIS still initialized for it.
type Identity = ReturnType<(typeof import("./useGoogleIdentity"))[`useGoogleIdentity`]>;
const fresh = async (): Promise<Identity> => {
    const { useGoogleIdentity } = await freshImport<typeof import("./useGoogleIdentity")>("./useGoogleIdentity", import.meta.url);
    return useGoogleIdentity();
};

const credential = (email: string, livesForMs: number): string => {
    const payload = { email, exp: Math.floor((Date.now() + livesForMs) / 1000) };
    const body = btoa(JSON.stringify(payload)).replace(/\+/g, `-`).replace(/\//g, `_`).replace(/=+$/, ``);
    return `header.${body}.signature`;
};

// What a clock set an hour ahead makes of a token Google just minted: already inside the near-expiry guard.
const STALE = credential(`owner@example.com`, 30_000);
const GOOD = credential(`owner@example.com`, 3_600_000);

const initialize = jest.fn();

// A press on Google's button that came back with this credential: GIS calls the callback it was initialized with.
const answer = (given: string): void => {
    const config = initialize.mock.calls.at(-1)?.[0] as { callback: (response: { credential: string }) => void };
    config.callback({ credential: given });
};

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve));

// Settled or not, without waiting on it: a pending mint is the whole point of some of these.
const state = async (minted: Promise<string | undefined>): Promise<string | undefined | `pending`> =>
    Promise.race([minted, flush().then(() => `pending` as const)]);

beforeEach(() => {
    localStorage.clear();
    initialize.mockReset();
    track.mockReset();
    // A silent attempt that never answers: the page's own button is the only road, as for a first-time visitor.
    window.google = { accounts: { id: { initialize, renderButton: jest.fn(), prompt: jest.fn(), cancel: jest.fn(), disableAutoSelect: jest.fn() } } };
});

afterEach(() => {
    delete window.google;
});

describe(`on a page that shows Google's own button`, () => {
    it(`keeps waiting after a refused credential, so the next press still signs in`, async () => {
        const { getIdToken } = await fresh();

        const minted = getIdToken({ gate: false });
        await flush();
        answer(STALE);

        expect(await state(minted)).toBe(`pending`);

        answer(GOOD);

        expect(await minted).toBe(GOOD);
    });

    it(`counts the refusal where the page can see it, and reports it`, async () => {
        const { getIdToken, refusedCredentials } = await fresh();

        void getIdToken({ gate: false });
        await flush();
        answer(STALE);
        await flush();

        expect(refusedCredentials.value).toBe(1);
        expect(track).toHaveBeenCalledWith(`sandbox_signin_gate`, { reason: `refused`, mode: `button` });
    });

    it(`caches nothing it refused`, async () => {
        const { getIdToken } = await fresh();

        void getIdToken({ gate: false });
        await flush();
        answer(STALE);

        expect(localStorage.getItem(`intentic.gid.client-id`)).toBeNull();
    });
});

// The shared overlay closes on any answer and the next call raises it afresh, so its button is never left dead; a
// warm-up has no reader waiting at all. Both still end on a refusal, as before.
it(`still ends a gate's mint on a refusal`, async () => {
    const { getIdToken, refusedCredentials } = await fresh();

    const minted = getIdToken();
    await flush();
    answer(STALE);

    expect(await minted).toBeUndefined();
    expect(refusedCredentials.value).toBe(1);
});
