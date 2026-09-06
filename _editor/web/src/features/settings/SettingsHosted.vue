<script setup lang="ts">
import { Button, Notice, RowGroup, RowNote, useLoadingReveal } from "@intentic/ui";
import { errorMessage } from "@intentic/ui/async";
import { computed, onMounted, onUnmounted, ref } from "vue";
import { useRoute } from "vue-router";
import HostedPlanOffer from "./hosted-plan/HostedPlanOffer.vue";
import { hasReturned, subscribeLabel, useHostedPlan } from "./hosted-plan/useHostedPlan";
import { apiClient } from "../../lib/useApi";

/* THE HOSTED PLAN: the one paid thing on the platform, bought and managed on Stripe's pages. The card only
 * ever states where things stand and opens the right door, but WHICH card is a different question before and
 * after the money. A subscriber arrives to check a date; a non-subscriber arrives to decide, and the decision
 * is the whole event: nothing else in the app asks anyone for twenty dollars a month. */

const { state: plan, error, refetch } = useHostedPlan();

const working = ref(false);
const actionError = ref<string | undefined>(undefined);

const loadError = computed(() => (error.value === null ? undefined : errorMessage(error.value, `Couldn't load the plan state.`)));

const outline = useLoadingReveal(
    computed(() => plan.value === undefined && error.value === null),
    computed(() => `hosted-plan`),
);

/* THE POST-CHECKOUT GAP. Stripe sends the browser back with ?plan=welcome, but the webhook that makes the plan
 * real can land seconds later, so the first read after a completed payment often still says "not on the
 * plan". It polls instead of asking the reader to reload, and gives up after a bounded wait rather than
 * spinning forever: a webhook that has not arrived in half a minute is a problem a refresh will not fix. */
const route = useRoute();
const justJoined = computed(() => route.query[`plan`] === `welcome`);
const activating = ref(false);

const POLL_EVERY_MS = 2_000;
const POLL_FOR_MS = 40_000;
let poll: ReturnType<typeof setInterval> | undefined;

const stopPolling = (): void => {
    if (poll !== undefined) {
        clearInterval(poll);
        poll = undefined;
    }
    activating.value = false;
};

onUnmounted(stopPolling);

onMounted(() => {
    if (!justJoined.value || plan.value?.onPlan === true) {
        return;
    }
    activating.value = true;
    const until = Date.now() + POLL_FOR_MS;
    poll = setInterval(() => {
        void refetch().then(() => {
            if (plan.value?.onPlan === true || Date.now() > until) {
                stopPolling();
            }
        });
    }, POLL_EVERY_MS);
});

const renewsOn = computed(() => {
    const stamp = plan.value?.renewsAt;
    return stamp === undefined ? undefined : new Date(stamp).toLocaleDateString(undefined, { year: `numeric`, month: `long`, day: `numeric` });
});

/* LAPSED IS NOT THE SAME AS NEVER. The platform's rule (hosted-plan.ts) counts `active` and `trialing` and
 * nothing else, so a subscriber whose card was declined arrives here with `onPlan: false`, the same answer as
 * somebody who has never paid. `past_due`, `unpaid` and `incomplete` are Stripe retrying a live subscription:
 * they want the card fixed, not the product sold. Anything else that is not on the plan really is over, and
 * its reader is a prospect again, greeted rather than lectured. */
const RECOVERABLE = new Set([`past_due`, `unpaid`, `incomplete`]);

const lapsed = computed(() => {
    const status = plan.value?.status;
    return plan.value?.onPlan === false && status !== undefined && RECOVERABLE.has(status) ? status : undefined;
});

const returning = computed(() => hasReturned(plan.value) && lapsed.value === undefined);

// A trial is a plan with an end date rather than a renewal date, and calling it "renews" would be the one
// word that costs somebody money they didn't expect to spend.
const onTrial = computed(() => plan.value?.status === `trialing`);

const buyLabel = computed(() => subscribeLabel(plan.value, returning.value));

const open = async (door: `checkout` | `portal`): Promise<void> => {
    if (working.value) {
        return;
    }
    working.value = true;
    actionError.value = undefined;
    try {
        const { url } = await (door === `checkout` ? apiClient.hostedPlan.checkout() : apiClient.hostedPlan.portal());
        window.location.href = url;
    } catch (err) {
        actionError.value = errorMessage(err, `Couldn't open the payment page.`);
        working.value = false;
    }
};
</script>

<template>
    <div class="@container flex flex-col gap-4">
        <Notice v-if="loadError" :of="{ tone: `danger`, title: `Couldn't load your plan.`, detail: loadError }" />

        <RowGroup v-else-if="plan && !plan.enabled" label="Hosted">
            <RowNote variant="block">
                <p class="text-xs text-muted">This platform doesn't sell a hosted plan.</p>
            </RowNote>
        </RowGroup>

        <!-- ON THE PLAN: the date, and the one door. Everything the offer argues is settled. -->
        <RowGroup v-else-if="plan && plan.onPlan" label="Hosted">
            <template v-if="renewsOn" #actions>
                <span class="text-2xs text-subtle">{{ onTrial ? `trial ends` : `renews` }} {{ renewsOn }}</span>
            </template>
            <RowNote variant="block">
                <div class="flex flex-col gap-3">
                    <p class="text-sm font-medium text-content">{{ onTrial ? `You're on trial` : `Your hosted sandbox is always on` }}</p>
                    <p class="text-xs text-muted">No awake-hour ceiling, and the machine is never collected. Nothing else about the product changes.</p>
                    <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
                        <Button label="Manage on Stripe" size="small" class="ui-button-loud" :loading="working" @click="open(`portal`)" />
                    </div>
                </div>
            </RowNote>
        </RowGroup>

        <!-- LAPSED: a subscriber whose card stopped working. One thing to do, said without a sales pitch. -->
        <RowGroup v-else-if="plan && lapsed" label="Hosted">
            <RowNote variant="block">
                <div class="flex flex-col gap-3">
                    <p class="text-sm font-medium text-warning">Your plan needs a working card</p>
                    <p class="text-xs text-muted">Payment failed. Until it goes through, the free lane's hour ceiling applies to your hosted sandbox.</p>
                    <div class="flex flex-wrap items-center gap-x-4 gap-y-2">
                        <Button label="Update payment on Stripe" :loading="working" class="ui-button-loud" @click="open(`portal`)" />
                        <p class="text-2xs text-subtle">Stripe reports this plan as "{{ lapsed }}".</p>
                    </div>
                </div>
            </RowNote>
        </RowGroup>

        <!-- ACTIVATING: the webhook's few seconds, owned by the app rather than handed back to the person who just paid. -->
        <RowGroup v-else-if="plan && justJoined && activating" label="Hosted">
            <RowNote variant="block">
                <div class="flex flex-col gap-2">
                    <p class="text-sm font-medium text-content">Payment received, activating your plan</p>
                    <p class="text-xs text-muted">Activating…</p>
                </div>
            </RowNote>
        </RowGroup>

        <!-- THE OFFER: the one buying surface in the product. -->
        <template v-else-if="plan">
            <Notice
                v-if="justJoined && !activating"
                :of="{
                    tone: `info`,
                    title: `Your payment went through, but the plan hasn't come back from Stripe yet.`,
                    detail: `This is unusual. Reload in a minute. If it still isn't here, get in touch and nothing will be charged twice.`,
                }"
            />
            <Notice
                v-if="returning"
                :of="{
                    tone: `info`,
                    title: `Your previous plan has ended.`,
                    detail: `Subscribing again starts a fresh month. Nothing was carried over, and nothing is owed.`,
                }"
            />
            <HostedPlanOffer :subscribe-label="buyLabel" :working="working" @checkout="open(`checkout`)" />
        </template>

        <RowGroup v-else-if="outline" role="status" aria-busy="true">
            <span class="sr-only">Reading your plan…</span>
            <template #label><span class="skeleton block h-2.5 w-28" aria-hidden="true" /></template>
            <RowNote variant="block">
                <div class="flex flex-col gap-2" aria-hidden="true">
                    <span class="skeleton block h-8 w-56" />
                    <span class="skeleton block h-2.5 w-full max-w-md" />
                    <span class="skeleton block h-2.5 w-2/3 max-w-sm" />
                </div>
            </RowNote>
        </RowGroup>

        <Notice v-if="actionError" :of="{ tone: `danger`, title: `Couldn't open the payment page.`, detail: actionError }" />
    </div>
</template>
