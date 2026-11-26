<script setup lang="ts">
import { Await, Notice, RowGroup, RowNote } from "@intentic/ui";
import { usePoll } from "@intentic/ui/async";
import { useT } from "@intentic/ui/i18n";
import { computed, onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import BillHeader from "./hosted-plan/BillHeader.vue";
import BillSandboxes from "./hosted-plan/BillSandboxes.vue";
import HostedPlanFaq from "./hosted-plan/HostedPlanFaq.vue";
import PlanCompare from "./hosted-plan/PlanCompare.vue";
import { billOf } from "./hosted-plan/planChange";
import { planLadder } from "./hosted-plan/planLadder";
import { POLL_EVERY_MS, RETURN_WAIT_MS } from "./hosted-plan/stripeErrand";
import { useStripeErrand } from "./hosted-plan/useStripeErrand";
import { RECOVERABLE } from "../../models/hosted-plan/hostedHours";
import { hasReturned, useHostedPlan } from "../../models/hosted-plan/useHostedPlan";
import { newSandboxLink } from "../../models/sandbox/addSandbox";
import { apiClient } from "../../lib/useApi";
import { onScreen } from "../../workbench/window/onScreen";

// THE BILL, NOT A SHOP (2026-11-26). Every cloud sandbox is on a plan of its own (Free, Standard or Max), and every paid
// one is on one monthly bill, one card, one date; this page is that bill, in the order a person asks of it: what do I pay
// and when (the header, with the one door to Stripe for the card and the invoices), what is it for (each cloud sandbox,
// its plan, hours and price, changed from its row through the one dialog, and a plan paid for that no sandbox is on), what
// could each plan be (one table), and the fine print as questions folded until asked. An account with nothing to change
// yet (no cloud sandbox, nothing paid) meets the table first, with the ways in under it.
//
// HOURS ARE SAID PER CLOUD SANDBOX, NEVER AS THE ACCOUNT'S "THIS MONTH". A limit shown on its own at account level reads
// as a limit on everything, sandboxes on the reader's own computers included, which are never metered at all; so the
// hours sit on the rows of the sandboxes that spend them, and the list says in so many words that nothing else is counted.
//
// (2026-11-26) Replaced a status card, a list of machines with "Move to <rung>" buttons, and a card per rung whose loudest
// press was "Add slot": a reader who paid $20 got "1 Standard slot" while their sandbox still said Free, and the real
// upgrade, with its minutes of downtime, was a quiet text button.

const t = useT();
const router = useRouter();
const { state: plan, loaded, refetch } = useHostedPlan();

// Stripe's webhook can land seconds after redirect, so the first read after checkout may still say not-on-plan. Polls
// instead of asking for a reload, and gives up after a bounded wait.
const route = useRoute();
const justJoined = computed(() => route.query[`plan`] === `welcome`);
const { polling: waiting, start: waitForPlan } = usePoll({
    everyMs: POLL_EVERY_MS,
    visible: onScreen,
    check: async () => {
        await refetch();
        return plan.value?.onPlan === true;
    },
});
onMounted(() => {
    if (justJoined.value && plan.value?.onPlan !== true) {
        waitForPlan(RETURN_WAIT_MS);
    }
});

const errand = useStripeErrand();
const ladder = computed(() => planLadder(plan.value));
const bill = computed(() => billOf(plan.value, ladder.value, Date.now()));
const machines = computed(() => plan.value?.hosted?.machines ?? []);

// past_due/unpaid/incomplete mean Stripe is retrying a live subscription, not that it ended (hostedHours.ts).
const lapsed = computed(() => plan.value?.onPlan === false && plan.value.status !== undefined && RECOVERABLE.has(plan.value.status));
const returning = computed(() => hasReturned(plan.value) && !lapsed.value);
// Nothing to change yet: no cloud sandbox and nothing paid. The plans lead, with the ways in under them.
const firstVisit = computed(() => plan.value?.onPlan !== true && !lapsed.value && machines.value.length === 0);

const portal = async (): Promise<void> => {
    await errand.open(`portal`, () => apiClient.hostedPlan.portal());
};
// A first plan bought for a sandbox not made yet: Stripe sends the browser back to the cloud entry, which opens the new
// sandbox on that plan; the app, which stays here, opens it itself once the payment has landed.
const opening = ref<string>();
const checkout = async (tier: string): Promise<void> => {
    opening.value = tier;
    try {
        // allow(route-literal): the contract takes this one return address as a literal, not any path a builder makes.
        if (await errand.open(`checkout`, () => apiClient.hostedPlan.checkout({ tier, returnTo: `/start/hosted` }))) {
            await router.push(newSandboxLink(`hosted`, tier));
        }
    } finally {
        opening.value = undefined;
    }
};
</script>

<template>
    <div class="@container flex flex-col gap-8">
        <!-- The page as it last looked here while the plan is read, else the outline of one. -->
        <Await :of="loaded" imprint="settings.billing" :label="t(`settings.settingsBilling.readingPlan`)">
            <template #failed="{ error: failure }">
                <Notice :of="{ tone: `danger`, title: t(`settings.settingsBilling.couldntLoadYourPlan`), detail: failure }" />
            </template>
            <template #fallback>
                <div class="flex flex-col gap-8" role="status" aria-busy="true" :aria-label="t(`settings.settingsBilling.readingPlan`)">
                    <div class="flex flex-col gap-2" aria-hidden="true">
                        <span class="flex h-[1lh] items-center text-2xl"><span class="skeleton block h-7 w-40" /></span>
                        <span class="flex h-[1lh] items-center text-xs"><span class="skeleton block h-3 w-64 max-w-full" /></span>
                    </div>
                    <div class="flex flex-col gap-3" aria-hidden="true">
                        <span v-for="n in 3" :key="n" class="skeleton block h-10 w-full rounded-lg" />
                    </div>
                </div>
            </template>
            <template #default="{ data: shown, refreshError }">
                <Notice v-if="refreshError" :of="{ tone: `danger`, title: t(`settings.settingsBilling.couldntLoadYourPlan`), detail: refreshError }" />

                <p v-if="!shown.enabled" class="text-sm text-muted">{{ t(`settings.settingsBilling.platformDoesntSellHosted`) }}</p>

                <div v-else class="flex flex-col gap-8">
                    <Notice
                        v-if="justJoined && !waiting && !shown.onPlan"
                        :of="{ tone: `info`, title: t(`settings.settingsBilling.paymentWentThrough`), detail: t(`settings.settingsBilling.paymentWentThroughDetail`) }"
                    />
                    <Notice
                        v-if="returning"
                        :of="{ tone: `info`, title: t(`settings.settingsBilling.previousPlanEnded`), detail: t(`settings.settingsBilling.previousPlanEndedDetail`) }"
                    />

                    <BillHeader
                        v-if="!firstVisit || errand.away.value"
                        :state="shown"
                        :bill="bill"
                        :away="errand.away.value"
                        :working="errand.working.value"
                        :activating="justJoined && waiting"
                        @portal="portal"
                        @drop="errand.drop"
                    />

                    <!-- A first visit meets the plans before anything else, with the ways in under them. -->
                    <RowGroup v-if="firstVisit" :label="t(`settings.plans.compare.title`)">
                        <RowNote variant="block"><PlanCompare :ladder="ladder" ways :opening="opening" @get="checkout" /></RowNote>
                    </RowGroup>

                    <BillSandboxes v-if="shown.hosted" :state="shown" :ladder="ladder" />

                    <RowGroup v-if="!firstVisit" :label="t(`settings.plans.compare.title`)">
                        <RowNote variant="block"><PlanCompare :ladder="ladder" /></RowNote>
                    </RowGroup>

                    <HostedPlanFaq :free-hours="shown.hosted?.freeTier.monthlyHours ?? ladder.find((rung) => rung.free)?.hours ?? 0" />
                </div>
            </template>
        </Await>

        <Notice v-if="errand.failure.value" :of="errand.failure.value" />
    </div>
</template>
