import type { PostHog } from "posthog-js";
import { watch } from "vue";
import { desktopApp } from "./environments/desktop";
import { environment } from "./environments/environment";
import { useAuth } from "../features/auth/useAuth";
import { addressRedactor, eventPrivacy, type RoutePatternOf } from "./eventPrivacy";
import { replayPrivacy } from "./replayPrivacy";

// PostHog instrumentation: autocapture, session replay, SPA pageviews, plus funnel milestones via `track()`.
// `api_host` proxies through this origin's /wire (nginx.conf) since privacy blockers match PostHog's own hostnames;
// `sessionStorage` scopes the session id to the tab so a reload doesn't fragment one visit into unrelated
// recordings.
//
// What this captures is what the privacy policy and sub-processor list (_site/site-content/src/legal.ts) say it
// captures; a change here that alters what leaves the browser must move LEGAL_VERSION and both documents together.
//
// Neither the replay nor an event carries the workspace: replayPrivacy.ts masks every piece of text that is not the
// interface's own wording and blocks the editor, terminals and media, and eventPrivacy.ts gives the same treatment to
// the addresses and clicked text of the events. Widen either there, not here, and only together with the policy.
//
// LOADED WHEN THE PAGE IS FIRST IDLE, not with the app: posthog-js is ~290 KB of JS that a phone downloaded and ran
// before its first screen, and its recorder then started serialising a page still being built. Milestones tracked before
// it arrives wait in `early` and go out once it has.
let enabled = false;
let client: PostHog | undefined;
// What a milestone carries, in PostHog's own terms.
type Milestone = Parameters<PostHog[`capture`]>[1];
const early: [event: string, properties: Milestone][] = [];

// After the page's first idle moment, or at once where there is no idle callback to ask (a test's window).
const firstIdle = (): Promise<void> =>
    new Promise((resolve) => {
        if (`requestIdleCallback` in globalThis) {
            globalThis.requestIdleCallback(() => resolve(), { timeout: 4_000 });
            return;
        }
        resolve();
    });

// A touch-first screen (a phone, a tablet), asked once at init: its replay leaves the conversation out whole
// (replayPrivacy.ts), since recording a transcript's DOM as it mounts and streams cost a phone about a third more main
// thread to open a chat.
const touchScreen = (): boolean => `matchMedia` in globalThis && globalThis.matchMedia(`(hover: none) and (pointer: coarse)`).matches;

// `routePatternOf` is the router's table as a question, so an address is reported as its route (`/workspace/:path*`).
export const initAnalytics = async (routePatternOf: RoutePatternOf): Promise<void> => {
    const { posthogKey, posthogHost } = environment.analytics;
    // Empty in dev; a literal `$POSTHOG_KEY` when the deploy container's envsubst had no key to substitute.
    if (posthogKey === `` || posthogKey.startsWith(`$`)) {
        return;
    }
    enabled = true;
    const redactAddress = addressRedactor(routePatternOf);
    await firstIdle();
    const { posthog } = await import(`posthog-js`);
    posthog.init(posthogKey, {
        api_host: posthogHost,
        // Proxying makes `api_host` a host posthog-js can't map to a cloud region, so `ui_host` must be named outright
        // or
        // replay deep-links won't resolve.
        ui_host: `https://us.posthog.com`,
        defaults: `2026-06-25`,
        persistence: `sessionStorage`,
        ...replayPrivacy(redactAddress, { touch: touchScreen() }),
        before_send: eventPrivacy(redactAddress),
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

    client = posthog;
    registerClient(posthog);
    for (const [event, properties] of early.splice(0)) {
        posthog.capture(event, properties);
    }

    const { user } = useAuth();
    // Session resolves (sign-in or reload) → stable identity; sign-out / account deletion → drop it. Immediate, since a
    // session that resolved while the SDK was still loading has no change left to announce it.
    watch(
        user,
        (current, previous) => {
            if (current) {
                posthog.identify(current.id, { email: current.email, name: current.name });
                return;
            }
            if (previous) {
                posthog.reset();
                // `reset()` clears super properties too, so the client tag must be re-registered or later events report
                // from nowhere in particular.
                registerClient(posthog);
            }
        },
        { immediate: true },
    );
};

// Which client sent this event, as a super property (not a per-call field) so it also tags autocapture and
// pageviews. The install id joins this to what the app's own screens report (desktop.ts).
const registerClient = (posthog: PostHog): void => {
    const app = desktopApp();
    posthog.register(
        app === undefined ? { client: `browser` } : { client: `desktop`, desktop_version: app.version, desktop_install_id: app.installId },
    );
};

// Funnel milestone events from call sites. No-op until `initAnalytics` has run (no key in dev); otherwise
// uninitialized `posthog.capture` logs a console error per call.
export const track = (event: string, properties?: Milestone): void => {
    if (!enabled) {
        return;
    }
    if (client === undefined) {
        early.push([event, properties]);
        return;
    }
    client.capture(event, properties);
};
