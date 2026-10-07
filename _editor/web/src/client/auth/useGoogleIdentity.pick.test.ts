// "Switch Google account" as it reaches Google. Google answers with the account already approved for this client
// unless it is told not to, and this module holds a credential of its own besides — so a switch that asks the
// ordinary way is handed back the very account the reader just rejected, which is what made the app's switch press
// land on the same refusal every time.
import "@intentic/testing/dom";
import { within } from "@intentic/base/async";
import { advanceTimersByTimeAsync, freshImport } from "@intentic/testing/bun";

// Configured client id, overriding bun.setup.ts's empty default, so the storage key below is the real one.
// Assigned, not `??=`, since the setup file already ran.
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

// The module is one instance holding one credential and one mint, so each test takes its own copy rather than the
// state the last one left: a mint nothing settled is still in flight, and GIS still initialized for it.
type Identity = ReturnType<(typeof import("./useGoogleIdentity"))[`useGoogleIdentity`]>;
const fresh = async (): Promise<Identity> => {
    const { useGoogleIdentity } = await freshImport<typeof import("./useGoogleIdentity")>("./useGoogleIdentity", import.meta.url);
    return useGoogleIdentity();
};

// Where the module keeps its credential, built the same way it builds it rather than transcribed.
const STORAGE_KEY = `intentic.gid.${window.env.auth.googleClientId}`;

const credential = (email: string): string => {
    const payload = { email, exp: Math.floor(Date.now() / 1000) + 3600 };
    const body = btoa(JSON.stringify(payload)).replace(/\+/g, `-`).replace(/\//g, `_`).replace(/=+$/, ``);
    return `header.${body}.signature`;
};

const HELD = credential(`first@example.com`);
const PICKED = credential(`second@example.com`);

const initialize = jest.fn();
const prompt = jest.fn();
const cancel = jest.fn();
const disableAutoSelect = jest.fn();

// The credential callback GIS was last initialized with; calling it is what a click on Google's chooser does.
const choose = (response: { credential: string }): void => {
    const config = initialize.mock.calls.at(-1)?.[0] as { callback: (response: { credential: string }) => void };
    config.callback(response);
};

// The mint runs several awaits deep (script wait, initialize, prompt); a macrotask flush avoids counting ticks.
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve));

beforeEach(() => {
    localStorage.clear();
    initialize.mockReset();
    prompt.mockReset();
    cancel.mockReset();
    disableAutoSelect.mockReset();
    track.mockReset();
    window.google = { accounts: { id: { initialize, renderButton: jest.fn(), prompt, cancel, disableAutoSelect } } };
});

afterEach(() => {
    delete window.google;
});

it(`asks Google with auto-select off and makes no silent attempt at all`, async () => {
    const { getIdToken } = await fresh();

    void getIdToken({ pick: true });
    await flush();

    expect(initialize).toHaveBeenCalledWith(expect.objectContaining({ auto_select: false }));
    expect(disableAutoSelect).toHaveBeenCalledTimes(1);
    // The silent road is not taken, not merely ignored: One Tap answering would settle the mint with the old account.
    expect(prompt).not.toHaveBeenCalled();
});

it(`answers with the account the reader picked, never the credential already held`, async () => {
    localStorage.setItem(STORAGE_KEY, HELD);
    const { getIdToken, signedInEmail } = await fresh();

    // The ordinary road takes what is held, which is the whole reason a switch has to refuse it.
    expect(await getIdToken()).toBe(HELD);

    const switched = getIdToken({ pick: true });
    await flush();
    choose({ credential: PICKED });

    expect(await switched).toBe(PICKED);
    expect(signedInEmail.value).toBe(`second@example.com`);
    expect(localStorage.getItem(STORAGE_KEY)).toBe(PICKED);
});

// What One Tap says when it closes, as GIS hands it to the prompt's listener.
const moment = (closed: { readonly skipped?: boolean; readonly dismissed?: string }) => ({
    isSkippedMoment: () => closed.skipped === true,
    isDismissedMoment: () => closed.dismissed !== undefined,
    getDismissedReason: () => closed.dismissed ?? ``,
});

// Pressing Google's own button on a page that shows one (sign-in, the desktop hand-off) restarts Google's flow, which
// closes the silent attempt: the gate's funnel counted each of those presses, sign-ins included, as an abandonment.
describe(`the sign-in gate's funnel`, () => {
    it(`does not report a dismissal when the reader took Google's own button`, async () => {
        prompt.mockImplementation((listener: (closed: ReturnType<typeof moment>) => void) => listener(moment({ dismissed: `flow_restarted` })));
        const { getIdToken } = await fresh();

        const minted = getIdToken({ gate: false });
        await flush();
        choose({ credential: PICKED });

        expect(await minted).toBe(PICKED);
        await flush();
        expect(track).not.toHaveBeenCalled();
    });

    // A warm-up has no button of its own to wait on: left waiting on Google's, which may be closed unanswered, it held
    // every later mint that joined it.
    it(`lets a warm-up go with nothing, unreported, when the reader took Google's own button`, async () => {
        prompt.mockImplementation((listener: (closed: ReturnType<typeof moment>) => void) => listener(moment({ dismissed: `flow_restarted` })));
        const { getIdToken } = await fresh();

        expect(await getIdToken({ silent: true })).toBeUndefined();
        await flush();
        expect(track).not.toHaveBeenCalled();
    });

    it(`still reports a silent attempt the reader waved away`, async () => {
        prompt.mockImplementation((listener: (closed: ReturnType<typeof moment>) => void) => listener(moment({ skipped: true })));
        const { getIdToken } = await fresh();

        void getIdToken({ gate: false });
        await flush();
        await flush();

        expect(track).toHaveBeenCalledWith(`sandbox_signin_gate`, { reason: `skipped`, mode: `button` });
    });
});

// A mint ended before it finished (a sign-out, a switch) used to be told only by a counter its epilogue read: what it
// had started went on, and spoke for whichever mint came after it.
describe(`a retired mint`, () => {
    // Google's script as a page that has not fetched it yet holds it: absent until its tag reports the load.
    const loadGisLater = (): (() => void) => {
        const gis = window.google;
        delete window.google;
        return () => {
            window.google = gis;
            document.querySelector(`script[src^="https://accounts.google.com/gsi/client"]`)?.dispatchEvent(new Event(`load`));
        };
    };

    it(`asks Google nothing once the script loads after a sign-out, and its caller gets nothing`, async () => {
        const load = loadGisLater();
        const { getIdToken, clearCredential, needsSignIn } = await fresh();

        const minted = getIdToken();
        await flush();
        clearCredential();
        load();
        await flush();

        expect(await within(minted, 1_000, `still waiting`)).toBeUndefined();
        expect(prompt).not.toHaveBeenCalled();
        expect(needsSignIn.value).toBe(false);
    });

    it(`hands its callers nothing when a switch replaces it before the script loads, and makes no silent attempt`, async () => {
        const load = loadGisLater();
        const { getIdToken } = await fresh();

        const first = getIdToken();
        await flush();
        const switched = getIdToken({ pick: true });
        load();
        await flush();

        expect(await within(first, 1_000, `still waiting`)).toBeUndefined();
        expect(prompt).not.toHaveBeenCalled();
        choose({ credential: PICKED });
        expect(await switched).toBe(PICKED);
    });

    it(`leaves no silent guard behind to report against the switch that replaced it`, async () => {
        jest.useFakeTimers();
        try {
            const { getIdToken } = await fresh();
            void getIdToken();
            await advanceTimersByTimeAsync(0);
            expect(prompt).toHaveBeenCalledTimes(1);

            void getIdToken({ pick: true });
            await advanceTimersByTimeAsync(10_000);
            jest.useRealTimers();
            await flush();

            expect(track).not.toHaveBeenCalled();
        } finally {
            jest.useRealTimers();
        }
    });
});
