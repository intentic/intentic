import posthog from "posthog-js";
import { watch } from "vue";
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

    const { user, plan, upgradeOpen } = useAuth();
    // Session resolves (sign-in or reload) → stable identity; sign-out / account deletion → drop it.
    watch(user, (current, previous) => {
        if (current) {
            posthog.identify(current.id, { email: current.email, name: current.name });
            return;
        }
        if (previous) {
            posthog.reset();
        }
    });
    // Billing tier as a person property, so funnels/replays can split free vs pro.
    watch(plan, (current) => {
        if (user.value && current) {
            posthog.setPersonProperties({ plan: current });
        }
    });
    // The app's single Upgrade dialog (App.vue) opens through this shared ref from every plan gate — one watch
    // sees every upsell impression; checkout completion shows up as the $pageview with ?billing=success.
    watch(upgradeOpen, (open) => {
        if (open) {
            posthog.capture(`upgrade_dialog_shown`);
        }
    });
};

// Funnel milestone events from action call sites. No-op until initAnalytics has run (dev has no key) —
// uninitialized posthog.capture would log a console error per call otherwise.
export const track = (event: string, properties?: Record<string, unknown>): void => {
    if (!enabled) {
        return;
    }
    posthog.capture(event, properties);
};
