import posthog from "posthog-js";
import { watch } from "vue";
import { environment } from "../environments/environment";
import { useAuth } from "./useAuth";

/* PostHog Cloud EU launch instrumentation: autocapture, session replay, SPA pageviews (History API, via the
 * config defaults snapshot), plus the few funnel milestones autocapture can't see — those call track() at their
 * source. persistence: "memory" keeps cookies/localStorage untouched (no consent banner); identify() below gives
 * signed-in users a stable identity anyway, and anonymous cross-visit continuity doesn't matter behind auth. */
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
        defaults: `2026-06-25`,
        persistence: `memory`,
        session_recording: { maskAllInputs: true },
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
