import posthog from "posthog-js";
import { watch } from "vue";
import { desktopApp } from "./environments/desktop";
import { environment } from "./environments/environment";
import { useAuth } from "../features/auth/useAuth";

// PostHog instrumentation: autocapture, session replay, SPA pageviews, plus funnel milestones via `track()`.
// `api_host` proxies through this origin's /wire (nginx.conf) since privacy blockers match PostHog's own hostnames;
// `sessionStorage` scopes the session id to the tab so a reload doesn't fragment one visit into unrelated
// recordings.
//
// What this captures is what the privacy policy and sub-processor list (_site/site-content/src/legal.ts) say it
// captures; a change here that alters what leaves the browser must move LEGAL_VERSION and both documents together.
//
// Replay is unscoped on purpose: `maskAllInputs` covers only typed values, so a recording reconstructs whatever the
// workspace had on screen. Narrow it via `maskTextSelector` or `stopSessionRecording()`, not by changing this
// default quietly.
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
        // Proxying makes `api_host` a host posthog-js can't map to a cloud region, so `ui_host` must be named outright
        // or
        // replay deep-links won't resolve.
        ui_host: `https://us.posthog.com`,
        defaults: `2026-06-25`,
        persistence: `sessionStorage`,
        session_recording: { maskAllInputs: true },
        // Serving the SDK from our own origin isn't enough: blocker lists also match a bare filename on any host
        // (posthog-recorder.js, dead-clicks-autocapture.js). Prefixing every SDK script, not just those two, breaks the
        // match; nginx.conf strips the prefix back off.
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
            // `reset()` clears super properties too, so the client tag must be re-registered or later events report
            // from
            // nowhere in particular.
            registerClient();
        }
    });
};

// Which client sent this event, as a super property (not a per-call field) so it also tags autocapture and
// pageviews. The install id joins this to what the app's own screens report (desktop.ts).
const registerClient = (): void => {
    const app = desktopApp();
    posthog.register(
        app === undefined ? { client: `browser` } : { client: `desktop`, desktop_version: app.version, desktop_install_id: app.installId },
    );
};

// Funnel milestone events from call sites. No-op until `initAnalytics` has run (no key in dev); otherwise
// uninitialized `posthog.capture` logs a console error per call.
export const track = (event: string, properties?: Record<string, unknown>): void => {
    if (!enabled) {
        return;
    }
    posthog.capture(event, properties);
};
