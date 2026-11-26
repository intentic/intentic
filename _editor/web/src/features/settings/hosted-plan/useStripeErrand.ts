import type { HostedPlanState } from "@intentic/api-contract";
import type { NoticeModel } from "@intentic/ui/async";
import { useT } from "@intentic/ui/i18n";
import { useQueryClient } from "@tanstack/vue-query";
import { computed } from "vue";
import { desktopVersion } from "../../../app/environments/desktop";
import { HOSTED_PLAN } from "../../../lib/queryKeys";
import { apiClient } from "../../../lib/useApi";
import { dismissOperation, useOperations } from "../../../workbench/operations/operations";
import { dropStripeErrand, planMark, waitForStripe } from "./stripeErrand";

/** The two pages of Stripe's the app sends a reader to: a first purchase, and payment and invoices. */
export type StripeDoor = `checkout` | `portal`;

/* A PRESS THAT GOES TO STRIPE, from wherever it is made: Billing's payment and invoices, the change dialog's first
 * purchase, the new sandbox's paid plan. The app has no browser of its own: a navigation to Stripe is intercepted and
 * handed to the reader's real browser (desktop-app `windows.rs`), so the window that asked stays where it is and nothing
 * else would ever clear the press or read the plan again; the wait is the app's (stripeErrand.ts). Every press is one run
 * in the ledger under one account scope, its progress naming the door once that stands open in the reader's browser, so a
 * reader who looks elsewhere while paying comes back to the same wait from any of those places, and a press while one
 * waits is a new errand that ends the old. A browser simply leaves for Stripe's page, and nobody is left to tell. */
export const useStripeErrand = () => {
    const t = useT();
    const inApp = desktopVersion() !== undefined;
    const errands = useOperations<boolean, NoticeModel, StripeDoor>(`account/billing/stripe`);
    const errand = computed(() => errands.all.value.at(-1));
    const running = computed(() => errand.value?.state === `running`);
    // The door standing open in the reader's browser, while it is.
    const away = computed(() => (running.value ? errand.value?.progress : undefined));
    // Asking Stripe for the page, before anything stands open.
    const working = computed(() => running.value && errand.value?.progress === undefined);
    const failure = computed(() => errand.value?.failure);

    // The plan read for the errand's wait straight from the platform, since the wait outlives the page's own query, and
    // put in the cache every page draws from.
    const client = useQueryClient();
    const readPlan = async (): Promise<HostedPlanState> => {
        const state = await apiClient.hostedPlan.state();
        client.setQueryData(HOSTED_PLAN.every, state);
        return state;
    };

    /** Opens `door` with the page `ask` names; true once the plan moved behind it (the app only), false otherwise. */
    const open = async (door: StripeDoor, ask: () => Promise<{ url: string }>): Promise<boolean> => {
        if (working.value) {
            return false;
        }
        for (const ended of errands.all.value.filter((run) => run.state !== `running`)) {
            dismissOperation(ended.key);
        }
        const run = await errands.run(String(Date.now()), {
            what: door === `checkout` ? t(`settings.settingsBilling.checkoutOpenInBrowser`) : t(`settings.settingsBilling.stripeOpenInBrowser`),
            failed: t(`settings.settingsBilling.couldntOpenPayment`),
            // A browser leaves this page for Stripe's, so there is nobody left to tell.
            quiet: !inApp,
            done: (landed) => (landed ? t(`settings.settingsBilling.planChangedOnStripe`) : t(`settings.settingsBilling.stoppedWaitingForStripe`)),
            task: async (report) => {
                const { url } = await ask();
                const left = planMark(client.getQueryData<HostedPlanState>(HOSTED_PLAN.every));
                window.location.href = url;
                // A browser has left this page by now; in the app the line above became a browser window somewhere else,
                // and this one is still standing here, waiting for the answer to move.
                if (!inApp) {
                    return false;
                }
                report.progress(door);
                return waitForStripe(left, readPlan);
            },
        });
        return run?.value === true;
    };

    return {
        inApp,
        away,
        working,
        failure,
        open,
        // The reader saying the errand is over when it produced nothing: closed the tab, changed their mind. Nothing to
        // undo, since no session was ever charged, so this only stops the wait for it.
        drop: (): void => dropStripeErrand(),
    };
};
