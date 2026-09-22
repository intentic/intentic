// "Switch Google account" as it reaches Google. Google answers with the account already approved for this client
// unless it is told not to, and this module holds a credential of its own besides — so a switch that asks the
// ordinary way is handed back the very account the reader just rejected, which is what made the app's switch press
// land on the same refusal every time.
import "@intentic/testing/dom";
import { it, expect, beforeEach, afterEach, mock } from "bun:test";
import { freshImport, hoisted } from "@intentic/testing/bun";

// Configured client id, overriding bun.setup.ts's empty default, so the storage key below is the real one.
// Assigned, not `??=`, since the setup file already ran.
hoisted(() => {
    globalThis.window.env = {
        production: false,
        api: { url: `http://localhost` },
        auth: { googleClientId: `client-id` },
        analytics: { posthogKey: ``, posthogHost: `` },
        afterSignOut: ``,
    };
});

// An ordinary browser: the desktop webview's own posture is useGoogleIdentity.desktop.test.ts's subject.
mock.module(`../../app/environments/desktop`, () => ({ desktopVersion: () => undefined }));

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

const initialize = mock();
const prompt = mock();
const cancel = mock();
const disableAutoSelect = mock();

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
    window.google = { accounts: { id: { initialize, renderButton: mock(), prompt, cancel, disableAutoSelect } } };
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
