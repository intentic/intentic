import { freshImport, stubGlobal, unstubAllGlobals } from "@intentic/testing/bun";
import { captureUrl } from "./analyticsHost";
import type { DesktopInfo } from "./desktop";

// The consent event's listener is Tauri's; nothing is said on it here.
jest.mock("@tauri-apps/api/event", () => ({ listen: jest.fn(async () => () => undefined) }));

const info = (telemetryInternal: boolean): DesktopInfo => ({
    version: `1.400.0`,
    os: `windows`,
    appUrl: `https://app.intentic.dev`,
    platformUrl: `https://api.intentic.dev`,
    installId: `install-1`,
    analyticsAllowed: true,
    telemetryInternal,
    engineLimitSeconds: 150,
    fixLimitSeconds: 600,
});

// The body of the one event `track` posted, from a fresh module so each case starts with no context.
const trackedFrom = async (desktop: DesktopInfo): Promise<string> => {
    const fetch = jest.fn(async (_url: string, _init: RequestInit) => new Response(null, { status: 200 }));
    stubGlobal(`fetch`, fetch);
    // Defined by the Vite build (vite.config.ts); a released build's key and host.
    stubGlobal(`__POSTHOG_KEY__`, `phc_test`);
    stubGlobal(`__POSTHOG_HOST__`, `https://us.i.posthog.com`);
    const analytics = await freshImport<typeof import("./analytics")>(`./analytics`, import.meta.url);
    analytics.initAnalytics(desktop);
    analytics.track(`desktop_example`, { outcome: `done` });
    expect(fetch).toHaveBeenCalledTimes(1);
    return String(fetch.mock.calls[0]?.[1].body);
};

// What the event says beyond its properties.
const posted = (properties: Record<string, unknown>) => ({
    api_key: `phc_test`,
    event: `desktop_example`,
    distinct_id: `install-1`,
    properties,
    timestamp: expect.any(String),
});

afterEach(() => {
    unstubAllGlobals();
});

describe(`track`, () => {
    it(`says internal on every event of an install the team marked as its own`, async () => {
        expect(JSON.parse(await trackedFrom(info(true)))).toEqual(posted({
            client: `desktop`,
            desktop_surface: `launcher`,
            desktop_version: `1.400.0`,
            desktop_os: `windows`,
            desktop_install_id: `install-1`,
            internal: true,
            outcome: `done`,
        }));
    });

    it(`leaves internal out on anyone else's install rather than sending false`, async () => {
        expect(JSON.parse(await trackedFrom(info(false)))).toEqual(posted({
            client: `desktop`,
            desktop_surface: `launcher`,
            desktop_version: `1.400.0`,
            desktop_os: `windows`,
            desktop_install_id: `install-1`,
            outcome: `done`,
        }));
    });
});

describe(`desktop PostHog capture host`, () => {
    it(`uses the configured region and normalizes a trailing slash`, () => {
        expect(captureUrl(`https://eu.i.posthog.com/`)).toBe(`https://eu.i.posthog.com/i/v0/e/`);
        expect(captureUrl(`https://us.i.posthog.com`)).toBe(`https://us.i.posthog.com/i/v0/e/`);
    });
});
