import posthog from "posthog-js";
import { watch } from "vue";
import { desktopApp } from "../environments/desktop";
import { environment } from "../environments/environment";
import { useAuth } from "./useAuth";

/* PostHog Cloud US launch instrumentation: autocapture, session replay, SPA pageviews (History API, via the
 * config defaults snapshot), plus the few funnel milestones autocapture can't see — those call track() at their
 * source. In deployment posthogHost is our own origin's /wire, reverse-proxied by nginx.conf, because privacy
 * blockers match PostHog's hostnames and the recorder's filename and would otherwise drop replay entirely.
 * persistence: "sessionStorage" scopes the session id to the browser tab: it survives reloads and in-tab
 * navigation — under "memory" every load minted a new id, so one visit fragmented into unrelated one-page
 * recordings — while still leaving no cookie and nothing that outlives the tab to track a return visit by. */
let enabled = false;

export const initAnalytics = (): void => {
    const { posthogKey, posthogHost } = environment.analytics;
    // Empty in dev; a literal `$POSTHOG_KEY` when the deploy container's envsubst had no key to substitute.
    if (posthogKey === `` || posthogKey.startsWith(`$`)) {
        return;
    }
    enabled = true;
    posthog.init(posthogKey, {
        api_host: posthogHost,
        // Proxying makes api_host a host posthog-js doesn't recognise as a cloud region, and it derives the
        // dashboard origin from that — so the replay deep-links get_session_replay_url() builds only resolve
        // if the real UI host is named outright.
        ui_host: `https://us.posthog.com`,
        defaults: `2026-06-25`,
        persistence: `sessionStorage`,
        session_recording: { maskAllInputs: true },
        // Serving the SDK from our own origin isn't enough on its own: the blocker lists also carry rules
        // that match a bare filename on any host, and two of the bundles posthog-js pulls are on them
        // (`/posthog-recorder.js`, `/dead-clicks-autocapture.js`). Those rules are anchored on the slash that
        // precedes the filename, so a prefix breaks the match; nginx strips it back off. Applied to every SDK
        // script rather than the two known names, so a bundle added in a later posthog-js needs nothing here.
        prepare_external_dependency_script: (script) => {
            const url = new URL(script.src);
            url.pathname = url.pathname.replace(/[^/]+$/, (file) => `sdk.${file}`);
            script.src = url.toString();
            return script;
        },
    });

    registerClient();

    const { user } = useAuth();
    // Session resolves (sign-in or reload) → stable identity; sign-out / account deletion → drop it.
    watch(user, (current, previous) => {
        if (current) {
            posthog.identify(current.id, { email: current.email, name: current.name });
            return;
        }
        if (previous) {
            posthog.reset();
            // reset() empties the whole store, super properties included — so which client this is has to be
            // said again, or every event after a sign-out reports as coming from nowhere in particular.
            registerClient();
        }
    });
};

/* WHICH CLIENT THIS IS, ON EVERY EVENT — the desktop app loads this very SPA, so without it an app user is
 * indistinguishable from a browser one and reports break them down by the webview's user agent instead
 * (Safari on Linux, Edge on Windows). Registered as super properties rather than passed per call, because the
 * question "was this the app" applies to autocapture and pageviews too, not just our own milestones. The
 * install id is what joins these to what the app's own screens report about the same install (desktop.ts). */
const registerClient = (): void => {
    const app = desktopApp();
    posthog.register(
        app === undefined ? { client: `browser` } : { client: `desktop`, desktop_version: app.version, desktop_install_id: app.installId },
    );
};

// Funnel milestone events from action call sites. No-op until initAnalytics has run (dev has no key) —
// uninitialized posthog.capture would log a console error per call otherwise.
export const track = (event: string, properties?: Record<string, unknown>): void => {
    if (!enabled) {
        return;
    }
    posthog.capture(event, properties);
};
