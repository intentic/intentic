// The Google credential as one account's own (useGoogleIdentity.ts): kept in the drawer of the account the page is drawn
// for, never kept at all when it was minted for another account (adding one beside this), and asked of Google by the
// page's own account's address. Storage and the account boundary are the real ones; Google's script is a stand-in.
import "@intentic/testing/dom";
import { freshImport } from "@intentic/testing/bun";

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
jest.mock(`../../app/analytics`, () => ({ track: jest.fn(), replaySessionId: () => undefined }));

const { enterAccount, resetAccountBoundaryForTests } = await import(`../../lib/accounts/accountBoundary`);
const { resetAccountPartitionForTests } = await import(`../../app/storage/browserStorage`);

// The module is one instance holding one credential and one mint, so each test takes its own copy rather than the
// state the last one left.
type Identity = ReturnType<(typeof import("./useGoogleIdentity"))[`useGoogleIdentity`]>;
const fresh = async (): Promise<Identity> => {
    const { useGoogleIdentity } = await freshImport<typeof import("./useGoogleIdentity")>("./useGoogleIdentity", import.meta.url);
    return useGoogleIdentity();
};

const ADA = { id: `acc-a`, email: `ada@example.com` };
// Where Ada's credential is kept: her drawer, under the name every build has used.
const ADA_KEY = `intentic@${ADA.id}/intentic.gid.${window.env.auth.googleClientId}`;

const credential = (email: string): string => {
    const payload = { email, exp: Math.floor(Date.now() / 1000) + 3600 };
    const body = btoa(JSON.stringify(payload)).replace(/\+/g, `-`).replace(/\//g, `_`).replace(/=+$/, ``);
    return `header.${body}.signature`;
};

const ADAS = credential(ADA.email);
const ANOTHERS = credential(`bea@example.com`);

// As much of GIS's initialize options as a case reads.
interface GisConfig {
    readonly auto_select?: boolean;
    readonly login_hint?: string;
    readonly callback: (response: { readonly credential: string }) => void;
}
const initialize = jest.fn<(config: GisConfig) => void>();

// The credential callback GIS was last initialized with; calling it is what a click on Google's chooser does.
const choose = (given: string): void => {
    initialize.mock.calls.at(-1)?.[0].callback({ credential: given });
};

// The mint runs several awaits deep (script wait, initialize, prompt); a macrotask flush avoids counting ticks.
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve));

beforeEach(() => {
    initialize.mockReset();
    window.google = { accounts: { id: { initialize, renderButton: jest.fn(), prompt: jest.fn(), cancel: jest.fn(), disableAutoSelect: jest.fn() } } };
});

afterEach(() => {
    delete window.google;
    localStorage.clear();
    sessionStorage.clear();
    resetAccountPartitionForTests();
    resetAccountBoundaryForTests();
});

it(`keeps the credential it mints in the drawer of the account the page is drawn for`, async () => {
    enterAccount(ADA);
    const { getIdToken } = await fresh();

    const minted = getIdToken({ gate: false });
    await flush();
    choose(ADAS);

    expect(await minted).toBe(ADAS);
    expect(localStorage.getItem(ADA_KEY)).toBe(ADAS);
    expect(localStorage.getItem(`intentic.gid.${window.env.auth.googleClientId}`)).toBeNull();
});

it(`hands a credential minted for another account to its caller alone, and keeps the page's own as it was`, async () => {
    enterAccount(ADA);
    localStorage.setItem(ADA_KEY, ADAS);
    const { getIdToken, signedInEmail } = await fresh();
    expect(await getIdToken()).toBe(ADAS);

    const other = getIdToken({ forAnotherAccount: true });
    await flush();
    choose(ANOTHERS);

    expect(await other).toBe(ANOTHERS);
    // Nothing of the other account's is kept, in this drawer or any other.
    expect(Object.entries(localStorage).filter(([, value]) => value === ANOTHERS)).toEqual([]);
    expect(localStorage.getItem(ADA_KEY)).toBe(ADAS);
    expect(signedInEmail.value).toBe(ADA.email);
    expect(await getIdToken()).toBe(ADAS);
});

it(`asks Google for the account the page is drawn for by its address`, async () => {
    enterAccount(ADA);
    const { getIdToken } = await fresh();

    void getIdToken({ gate: false });
    await flush();

    expect(initialize.mock.calls.at(-1)?.[0]).toMatchObject({ auto_select: true, login_hint: ADA.email });
});

it.each([[`switching Google account`, { pick: true }], [`adding another account`, { forAnotherAccount: true }]])(
    `names no account while the reader picks one (%s)`,
    async (_road, options) => {
        enterAccount(ADA);
        const { getIdToken } = await fresh();
        void getIdToken({ gate: false });
        await flush();

        void getIdToken(options);
        await flush();

        // Asked again rather than left holding the page's account: Google would answer with that one.
        expect(initialize).toHaveBeenCalledTimes(2);
        const picking = initialize.mock.calls.at(-1)?.[0];
        expect([picking?.auto_select, picking?.login_hint]).toEqual([false, undefined]);
    },
);
