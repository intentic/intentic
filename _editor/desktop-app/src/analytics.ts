import type { DesktopInfo } from "./desktop";

// Reports desktop-only events (install, update, environment) via hand-rolled POST rather than the PostHog SDK.
// Distinct id is the install id (state.rs), shared with the SPA's own window. The build-time key is unset in
// dev/local builds, which disables this.
declare const __POSTHOG_KEY__: string;

const CAPTURE_URL = `https://us.i.posthog.com/i/v0/e/`;

let context: { installId: string; shared: Record<string, unknown> } | undefined;

export const initAnalytics = (info: DesktopInfo): void => {
    if (__POSTHOG_KEY__ === ``) {
        return;
    }
    context = {
        installId: info.installId,
        shared: {
            client: `desktop`,
            desktop_surface: `launcher`,
            desktop_version: info.version,
            desktop_os: info.os,
            desktop_install_id: info.installId,
        },
    };
};

// Fire-and-forget event, silent on failure, no-op until initAnalytics has run. Only outcomes, durations and step
// labels — never a sandbox name, setup code, path, token or line of script output.
export const track = (event: string, properties?: Record<string, unknown>): void => {
    void send(event, properties);
};

// Split from `track` so trackBeforeExit can await it. Returns undefined when analytics is off, distinguishing
// "nothing sent" from "sent, in flight".
const send = (event: string, properties?: Record<string, unknown>): Promise<void> | undefined => {
    if (context === undefined) {
        return undefined;
    }
    const body = JSON.stringify({
        api_key: __POSTHOG_KEY__,
        event,
        distinct_id: context.installId,
        properties: { ...context.shared, ...properties },
        timestamp: new Date().toISOString(),
    });
    return fetch(CAPTURE_URL, { method: `POST`, headers: { "content-type": `application/json` }, body, keepalive: true }).then(
        () => undefined,
        () => undefined,
    );
};

/* How long an event that precedes a shutdown is allowed to hold it up. */
const EXIT_FLUSH_MS = 1500;

// Awaited and capped, unlike `track`: keepalive survives a webview teardown but not an OS restart, so this blocks
// briefly rather than losing the event or hanging indefinitely.
export const trackBeforeExit = async (event: string, properties?: Record<string, unknown>): Promise<void> => {
    const sent = send(event, properties);
    if (sent === undefined) {
        return;
    }
    await Promise.race([sent, new Promise<void>((resolve) => setTimeout(resolve, EXIT_FLUSH_MS))]);
};
