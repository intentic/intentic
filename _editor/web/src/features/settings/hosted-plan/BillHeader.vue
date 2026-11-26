<!-- THE BILL AT A GLANCE, at the top of Billing: what is paid a month now, the next charge date, and next month's total
     when a change waiting makes it differ, with the one door to Stripe for the card, the invoices and the address. Under
     it, whatever is true of the subscription right now, in plain words with its one fix: a payment that failed (Update
     card), plans ending at the period's end (Resume), a checkout open in the reader's browser, a payment being activated.
     A comped account is told it pays nothing, and an account that pays for nothing says so instead of a figure. -->
<script setup lang="ts">
import type { HostedPlanState } from "@intentic/api-contract";
import { Button, toneFill } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { formatDayShort, RECOVERABLE } from "../../../models/hosted-plan/hostedHours";
import type { Bill } from "./planChange";
import type { StripeDoor } from "./useStripeErrand";

const { state, bill, away = undefined, working = false, activating = false } = defineProps<{
    state: HostedPlanState;
    bill: Bill;
    /** The Stripe page standing open in the reader's browser, while it is. */
    away?: StripeDoor | undefined;
    working?: boolean;
    /** Back from checkout, waiting out the webhook's few seconds. */
    activating?: boolean;
}>();
const emit = defineEmits<{ portal: []; drop: [] }>();

const t = useT();
const comped = computed(() => state.onPlan && state.comped === true);
const subscriber = computed(() => state.onPlan && !comped.value);
// past_due/unpaid/incomplete mean Stripe is retrying a live subscription, not that it ended (hostedHours.ts).
const lapsed = computed(() => !state.onPlan && state.status !== undefined && RECOVERABLE.has(state.status));
const cancelling = computed(() => subscriber.value && state.cancelAtPeriodEnd === true);
const trial = computed(() => subscriber.value && state.status === `trialing`);
const date = computed(() => (state.renewsAt === undefined ? undefined : formatDayShort(state.renewsAt)));
// The door to Stripe only where there is (or was) a subscription to show.
const portalShown = computed(() => state.status !== undefined && !comped.value);

const nextLine = computed(() => {
    if (!subscriber.value || date.value === undefined) {
        return undefined;
    }
    if (cancelling.value) {
        return t(`settings.plans.bill.endsOn`, { date: date.value });
    }
    const charge = trial.value ? t(`settings.plans.bill.trialEnds`, { date: date.value }) : t(`settings.plans.bill.nextCharge`, { date: date.value });
    return bill.nextUsd === bill.monthlyUsd ? charge : `${charge} · ${t(`settings.plans.bill.nextTotal`, { total: bill.nextUsd, date: date.value })}`;
});
</script>

<template>
    <section class="flex flex-col gap-3" data-bill-header>
        <div class="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
            <div class="flex min-w-0 flex-col gap-0.5">
                <template v-if="comped">
                    <h2 class="text-2xl font-semibold leading-tight text-content">{{ t(`settings.plans.bill.onTheHouse`) }}</h2>
                    <p class="text-xs text-muted">{{ t(`settings.plans.bill.compedDetail`) }}</p>
                </template>
                <template v-else>
                    <h2 class="text-2xl font-semibold leading-tight text-content tabular-nums">
                        {{ t(`settings.plans.bill.total`, { total: bill.monthlyUsd }) }}
                        <span class="text-sm font-normal text-muted">{{ t(`settings.plans.bill.aMonth`) }}</span>
                    </h2>
                    <p class="text-xs text-muted">{{ nextLine ?? t(`settings.plans.bill.nothingPaid`) }}</p>
                </template>
            </div>
            <Button v-if="portalShown" tier="boring" :label="t(`settings.plans.bill.payment`)" icon-pos="right" :loading="working" data-bill-portal @click="emit(`portal`)">
                <template #icon><Icon name="external-link" /></template>
            </Button>
        </div>

        <!-- What is true of the subscription now, each with its one fix. -->
        <div v-if="lapsed" class="flex flex-wrap items-center justify-between gap-2 rounded-lg px-3 py-2" :class="toneFill(`warning`, `strong`)">
            <p class="text-xs text-content">{{ t(`settings.plans.bill.paymentFailed`) }}</p>
            <Button size="small" tier="accent" :label="t(`settings.plans.bill.updateCard`)" :loading="working" @click="emit(`portal`)" />
        </div>
        <div v-else-if="cancelling" class="flex flex-wrap items-center justify-between gap-2 rounded-lg px-3 py-2" :class="toneFill(`warning`, `strong`)">
            <p class="text-xs text-content">{{ t(`settings.plans.bill.ending`, { date }) }}</p>
            <Button size="small" tier="loud" :label="t(`settings.plans.bill.resume`)" :loading="working" @click="emit(`portal`)" />
        </div>
        <p v-else-if="activating" class="flex items-center gap-2 rounded-lg px-3 py-2 text-xs text-content" :class="toneFill(`info`, `strong`)">
            <Icon name="spinner" spin class="text-info" />
            {{ t(`settings.settingsBilling.paymentReceivedActivatingPlan`) }}
        </p>
        <div v-if="away" class="flex flex-wrap items-center justify-between gap-2 rounded-lg px-3 py-2" :class="toneFill(`info`, `strong`)">
            <p class="flex min-w-0 items-center gap-2 text-xs text-content">
                <Icon name="spinner" spin class="shrink-0 text-info" />
                {{ away === `checkout` ? t(`settings.settingsBilling.checkoutOpenInBrowser`) : t(`settings.settingsBilling.stripeOpenInBrowser`) }} ·
                {{ away === `checkout` ? t(`settings.settingsBilling.finishPayingThereNothing`) : t(`settings.settingsBilling.whateverChangeThereShows`) }}
            </p>
            <Button v-if="away === `checkout`" size="small" tier="quiet" :label="t(`settings.settingsBilling.didntPayAfterAll`)" @click="emit(`drop`)" />
        </div>
    </section>
</template>
