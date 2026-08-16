// @vitest-environment jsdom
//
// THE HALF OF THE RULE THAT LIVES IN THE MECHANISM. signInSurfaces.test.ts holds every screen to offering the
// browser hand-off inside the desktop app; this holds the layer beneath it to making that the ONLY thing a
// screen can offer, so a surface added later inherits the answer instead of re-deriving it wrongly.
//
// Google refuses OAuth from an embedded webview and Identity Services is FedCM-based, which that webview does
// not implement. Two consequences, and both used to be discovered the slow way by whoever was sitting in front
// of the app: the button renders and does nothing, and the silent attempt behind it waits out a five-second
// timer before admitting a failure that was certain from the first frame.
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.hoisted(() => {
    globalThis.window.env ??= {
        production: false,
        api: { url: `http://localhost` },
        auth: { googleClientId: `client-id` },
        analytics: { posthogKey: ``, posthogHost: `` },
        afterSignOut: ``,
    };
});

const desktopVersion = vi.fn<() => string | undefined>();
vi.mock(`../environments/desktop`, () => ({ desktopVersion: () => desktopVersion() }));

const { useGoogleIdentity } = await import("./useGoogleIdentity");

// Google's script, as far as this module can tell — present and working, so a refusal here is the posture
// rule talking and never a missing dependency.
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
    // Not merely "returned false" — it never asked. A button drawn into that window takes clicks and does
    // nothing, which is worse than no button at all.
    expect(gisRenderButton).not.toHaveBeenCalled();
});

it(`renders it in an ordinary browser`, async () => {
    desktopVersion.mockReturnValue(undefined);
    const { renderButton } = useGoogleIdentity();

    const rendered = await renderButton(document.createElement(`div`), true);

    expect(rendered).toBe(true);
    expect(gisRenderButton).toHaveBeenCalled();
});

it(`raises the sign-in gate at once inside the desktop app rather than waiting out the silent timer`, async () => {
    vi.useFakeTimers();
    try {
        desktopVersion.mockReturnValue(`1.2.3`);
        const { getIdToken, needsSignIn } = useGoogleIdentity();

        void getIdToken();
        // Only the microtasks the mint's own awaits need; no clock is advanced, which is the assertion.
        await vi.advanceTimersByTimeAsync(0);

        expect(needsSignIn.value).toBe(true);
        // There is no prompt to make: asking Google in this window is the thing that cannot work.
        expect(prompt).not.toHaveBeenCalled();
    } finally {
        vi.useRealTimers();
    }
});
