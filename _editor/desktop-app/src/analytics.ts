import type { DesktopInfo } from "./desktop";

/* WHAT THE APP ITSELF REPORTS, WHICH THE SPA CANNOT.
 *
 * The workspace face is the hosted SPA and carries its own instrumentation. This face is the part that touches
 * the machine, the install, the update, the environment rebuild, and it used to report nothing at all, which
 * left every desktop funnel ending at "clicked the button" with the outcome invisible.
 *
 * A POST per event rather than posthog-js, and that is the design rather than a shortcut. Everything the SDK
 * is worth carrying for is something this screen must NOT do: autocapture and pageviews on a window that is
 * one log and three buttons, session replay of a machine's install output, a storage layer for an id this app
 * already keeps on disk. What is left is a handful of named events, and sending them by hand is what makes the
 * promise below checkable by reading thirty lines instead of trusting a bundle's config.
 *
 * Addressed DIRECTLY, unlike the SPA, which routes through its own origin because content blockers match
 * PostHog's hostnames. There are none inside this webview, and local content has no origin to proxy through.
 *
 * The distinct id is the INSTALL ID (state.rs): the same value the workspace window is marked with, so what
 * the app did to the machine and what the user then did in the SPA read as one story rather than two
 * strangers. It is random per installation, never a hostname, a username or anything about the machine.
 *
 * The key is baked in at build time (vite.config.ts). An unset one leaves this off, which is what every dev
 * run and every local `tauri build` get. */
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

/* An event from this screen. A no-op until initAnalytics has run, which a build with no key never does.
 *
 * WHAT MAY BE SENT: outcomes, durations, and the step labels the scripts print about themselves. Never a
 * sandbox name, a setup code, a folder path, a Cloudflare token, or a line of script output, this app runs
 * with the user's machine in its hands and the log on screen is full of all five.
 *
 * Fire-and-forget, and silent on failure in both directions: a machine that is offline (which, during a setup
 * that installs Docker, is a real state) must not turn a working install into an error on screen, and a
 * rejected promise here must not surface as an unhandled one. `keepalive` so an event sent as the window is
 * handed back to the workspace still leaves. */
export const track = (event: string, properties?: Record<string, unknown>): void => {
    void send(event, properties);
};

/* The POST itself, kept apart from `track` for the one caller below that has to hold on to it. Undefined when
 * analytics is off, so that caller can tell "nothing was sent" from "sent, still in flight". */
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

/* THE ONE EVENT THAT CANNOT FIRE AND FORGET. The Windows leg of a setup ends by restarting the machine, and
 * `restart_for_setup` parks the work and reboots in the same breath, so the request above was still on the
 * wire when the machine went down, and the step that costs a setup the most people was the one step that
 * reported nothing. `keepalive` covers a webview being torn down; it does not cover an operating system
 * switching off underneath it.
 *
 * Awaited, and CAPPED: a machine on a bad network, which, mid-Docker-install, is a real state, delays the
 * restart by a second and a half rather than parking the user on a promise that may never settle. */
export const trackBeforeExit = async (event: string, properties?: Record<string, unknown>): Promise<void> => {
    const sent = send(event, properties);
    if (sent === undefined) {
        return;
    }
    await Promise.race([sent, new Promise<void>((resolve) => setTimeout(resolve, EXIT_FLUSH_MS))]);
};
