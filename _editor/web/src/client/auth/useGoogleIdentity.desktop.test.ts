// The mechanism-level half of the rule signInSurfaces.test.ts holds screens to: inside the desktop webview, the
// browser hand-off must be the only option a screen can offer. Google refuses OAuth there and FedCM isn't
// implemented, so an unguarded button renders and does nothing, and the silent attempt behind it stalls for five
// seconds before failing. The app's silent attempt is the credential the platform holds for a signed-in account.
import "@intentic/testing/dom";
import { advanceTimersByTimeAsync } from "@intentic/testing/bun";
import { ref } from "vue";

// Configured client id, overriding bun.setup.ts's empty default, so a refusal below is the posture rule, not a
// missing client id. Assigned, not `??=`, since the setup file already ran.
(() => {
    globalThis.window.env = {
        production: false,
        api: { url: `http://localhost` },
        auth: { googleClientId: `client-id` },
        analytics: { posthogKey: ``, posthogHost: `` },
        afterSignOut: ``,
    };
})();

const desktopVersion = jest.fn<() => string | undefined>();
jest.mock(`../../app/environments/desktop`, () => ({ desktopVersion: () => desktopVersion() }));

// The platform's half of the desktop app's silent attempt: who is signed in, and the credential it holds for them.
const signedIn = ref<{ email: string } | null>(null);
jest.mock(`./useAuth`, () => ({ useAuth: () => ({ user: signedIn }) }));
const platformToken = jest.fn<() => Promise<{ idToken?: string }>>();
jest.mock(`../../lib/useApi`, () => ({ apiClient: { desktop: { googleIdToken: () => platformToken() } } }));

const { useGoogleIdentity } = await import("./useGoogleIdentity");

const segment = (value: unknown): string => btoa(JSON.stringify(value)).replace(/=/g, ``).replace(/\+/g, `-`).replace(/\//g, `_`);
// A Google ID token as the platform hands one over: an hour of life left, for the signed-in address.
const heldToken = (email: string): string => `${segment({ alg: `RS256` })}.${segment({ exp: Math.floor(Date.now() / 1000) + 3600, email })}.signature`;

// The mint's own microtasks and module loads, with no clock advanced.
const settleMint = async (): Promise<void> => {
    for (let round = 0; round < 10; round += 1) {
        await advanceTimersByTimeAsync(0);
    }
};

// Stands in for a working Google script, so any refusal is the posture rule, not a missing dependency.
const prompt = jest.fn();
const gisRenderButton = jest.fn();

beforeEach(() => {
    useGoogleIdentity().clearCredential();
    signedIn.value = null;
    platformToken.mockReset();
    platformToken.mockResolvedValue({});
    desktopVersion.mockReset();
    prompt.mockReset();
    gisRenderButton.mockReset();
    window.google = { accounts: { id: { initialize: jest.fn(), renderButton: gisRenderButton, prompt } } };
});

afterEach(() => {
    delete window.google;
});

it(`refuses to render Google's button inside the desktop app, even with Google's script right there`, async () => {
    desktopVersion.mockReturnValue(`1.2.3`);
    const { renderButton } = useGoogleIdentity();

    const rendered = await renderButton(document.createElement(`div`), true);

    expect(rendered).toBe(false);
    // Not merely false: it never even asked. A button that draws but does nothing is worse than no button.
    expect(gisRenderButton).not.toHaveBeenCalled();
});

it(`renders it in an ordinary browser`, async () => {
    desktopVersion.mockReturnValue(undefined);
    const { renderButton } = useGoogleIdentity();

    const rendered = await renderButton(document.createElement(`div`), true);

    expect(rendered).toBe(true);
    expect(gisRenderButton).toHaveBeenCalledTimes(1);
});

it(`raises the sign-in gate at once inside the desktop app rather than waiting out the silent timer`, async () => {
    jest.useFakeTimers();
    try {
        desktopVersion.mockReturnValue(`1.2.3`);
        const { getIdToken, needsSignIn } = useGoogleIdentity();

        void getIdToken();
        // Only the mint's own microtasks; no clock is advanced, which is the assertion.
        await settleMint();

        expect(needsSignIn.value).toBe(true);
        // No prompt to make: asking Google here is exactly what can't work.
        expect(prompt).not.toHaveBeenCalled();
        // Nobody is signed in, so the platform is not asked: a sessionless call would tear the signed-in runtime down.
        expect(platformToken).not.toHaveBeenCalled();
    } finally {
        jest.useRealTimers();
    }
});

it(`takes the credential the platform holds inside the desktop app, so a sandbox opens with no trip to the browser`, async () => {
    desktopVersion.mockReturnValue(`1.2.3`);
    signedIn.value = { email: `owner@example.com` };
    const token = heldToken(`owner@example.com`);
    platformToken.mockResolvedValue({ idToken: token });
    const { getIdToken, needsSignIn, signedInEmail } = useGoogleIdentity();

    expect(await getIdToken()).toBe(token);
    expect(needsSignIn.value).toBe(false);
    expect(signedInEmail.value).toBe(`owner@example.com`);
    expect(prompt).not.toHaveBeenCalled();
    // Kept like any other credential: the next ask is answered from it, not from the platform again.
    expect(await getIdToken()).toBe(token);
    expect(platformToken).toHaveBeenCalledTimes(1);
});

it(`raises the hand-off when the platform holds nothing for the account`, async () => {
    jest.useFakeTimers();
    try {
        desktopVersion.mockReturnValue(`1.2.3`);
        signedIn.value = { email: `owner@example.com` };
        const { getIdToken, needsSignIn } = useGoogleIdentity();

        void getIdToken();
        await settleMint();

        expect(platformToken).toHaveBeenCalledTimes(1);
        expect(needsSignIn.value).toBe(true);
    } finally {
        jest.useRealTimers();
    }
});

it(`does not take the platform's credential when the reader is changing accounts`, async () => {
    jest.useFakeTimers();
    try {
        desktopVersion.mockReturnValue(`1.2.3`);
        signedIn.value = { email: `owner@example.com` };
        platformToken.mockResolvedValue({ idToken: heldToken(`owner@example.com`) });
        const { getIdToken, needsSignIn } = useGoogleIdentity();

        void getIdToken({ pick: true });
        await settleMint();

        // The account being left is the one the platform would vouch for.
        expect(platformToken).not.toHaveBeenCalled();
        expect(needsSignIn.value).toBe(true);
    } finally {
        jest.useRealTimers();
    }
});
