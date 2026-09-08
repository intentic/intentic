// @vitest-environment jsdom
// The mechanism-level half of the rule signInSurfaces.test.ts holds screens to: inside the desktop webview, the
// browser hand-off must be the only option a screen can offer. Google refuses OAuth there and FedCM isn't
// implemented, so an unguarded button renders and does nothing, and the silent attempt behind it stalls for five
// seconds before failing.
import { afterEach, beforeEach, expect, it, vi } from "vitest";

// Configured client id, overriding vitest.setup.ts's empty default, so a refusal below is the posture rule, not a
// missing client id. Assigned, not `??=`, since the setup file already ran.
vi.hoisted(() => {
    globalThis.window.env = {
        production: false,
        api: { url: `http://localhost` },
        auth: { googleClientId: `client-id` },
        analytics: { posthogKey: ``, posthogHost: `` },
        afterSignOut: ``,
    };
});

const desktopVersion = vi.fn<() => string | undefined>();
vi.mock(`../../app/environments/desktop`, () => ({ desktopVersion: () => desktopVersion() }));

const { useGoogleIdentity } = await import("./useGoogleIdentity");

// Stands in for a working Google script, so any refusal is the posture rule, not a missing dependency.
const prompt = vi.fn();
const gisRenderButton = vi.fn();

beforeEach(() => {
    desktopVersion.mockReset();
    prompt.mockReset();
    gisRenderButton.mockReset();
    window.google = { accounts: { id: { initialize: vi.fn(), renderButton: gisRenderButton, prompt } } };
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
    vi.useFakeTimers();
    try {
        desktopVersion.mockReturnValue(`1.2.3`);
        const { getIdToken, needsSignIn } = useGoogleIdentity();

        void getIdToken();
        // Only the mint's own microtasks; no clock is advanced, which is the assertion.
        await vi.advanceTimersByTimeAsync(0);

        expect(needsSignIn.value).toBe(true);
        // No prompt to make: asking Google here is exactly what can't work.
        expect(prompt).not.toHaveBeenCalled();
    } finally {
        vi.useRealTimers();
    }
});
