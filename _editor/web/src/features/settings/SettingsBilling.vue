<script setup lang="ts">
import { HOSTED_PLAN_MAX_SLOTS } from "@intentic/api-contract";
import { Button, Notice, RowGroup, RowNote, useLoadingReveal } from "@intentic/ui";
import { errorMessage } from "@intentic/ui/async";
import { timeAgo } from "@intentic/ui/format";
import { computed, onMounted, onUnmounted, ref } from "vue";
import { RouterLink, useRoute } from "vue-router";
import HostedPlanOffer from "./hosted-plan/HostedPlanOffer.vue";
import { formatDay, formatMinutes, hoursLeftLine, RECOVERABLE } from "./hosted-plan/hostedHours";
import { hasReturned, subscribeLabel, useHostedPlan } from "./hosted-plan/useHostedPlan";
import { apiClient } from "../../lib/useApi";

/* BILLING: the one page in the product about money (docs/design/billing-view.md). What plan this account is
 * on and the one thing to do about it; this month's hours; the hosted sandboxes the plan covers and how many
 * it could; what a slot is; and the door to Stripe for invoices, the card and cancelling.
 *
 * Bought and managed on Stripe's pages, but the CONSEQUENCES are said here, because Stripe's portal cannot say
 * them: what cancelling does to the machine, why "ends" and not "renews" after a cancel, that a plan with no
 * machine under it is paying for nothing. A subscriber arrives to check a date or add a slot; a non-subscriber
 * arrives to decide, and the decision is the whole event: nothing else in the app asks anyone for twenty
 * dollars a month. */

const { state: plan, error, refetch, meter, setSlots, slotsWorking } = useHostedPlan();

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

const periodEnd = computed(() => (plan.value?.renewsAt === undefined ? undefined : formatDay(plan.value.renewsAt)));

/* LAPSED IS NOT THE SAME AS NEVER (hostedHours.ts). `past_due`, `unpaid` and `incomplete` are Stripe retrying
 * a live subscription: they want the card fixed, not the product sold. Anything else that is not on the plan
 * really is over, and its reader is a prospect again, greeted rather than lectured. */
const lapsed = computed(() => {
    const status = plan.value?.status;
    return plan.value?.onPlan === false && status !== undefined && RECOVERABLE.has(status) ? status : undefined;
});

const returning = computed(() => hasReturned(plan.value) && lapsed.value === undefined);

// A trial is a plan with an end date rather than a renewal date, and calling it "renews" would be the one
// word that costs somebody money they didn't expect to spend. A cancelled plan ENDS; saying "renews" to
// somebody who just cancelled is the other word that costs them, in the other direction.
const onTrial = computed(() => plan.value?.status === `trialing`);
const cancelling = computed(() => plan.value?.cancelAtPeriodEnd === true);
const comped = computed(() => plan.value?.comped === true);
const dateWord = computed(() => (cancelling.value ? `ends` : onTrial.value ? `trial ends` : `renews`));

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

/* THE HOSTED HALF: the lane as it applies to this account, present wherever the platform runs machines. */
const hosted = computed(() => plan.value?.hosted);
const machines = computed(() => hosted.value?.machines ?? []);
const slots = computed(() => hosted.value?.slots ?? 0);
const price = computed(() => plan.value?.priceUsd ?? 0);
const shape = computed(() => {
    const value = hosted.value?.shape;
    return value === undefined ? undefined : `${value.cpus} shared vCPUs · ${value.memoryMb / 1024} GB memory · ${value.volumeGb} GB disk`;
});

const resetsOn = computed(() => (hosted.value === undefined ? undefined : formatDay(hosted.value.usage.resetsAt)));
const awakeThisMonth = computed(() => (hosted.value === undefined ? undefined : formatMinutes(hosted.value.usage.usedMinutes)));

// A machine's standing this minute, off the row's own stamp: no provider call, and honest about what it knows.
const machineState = (wokeAt: string | null): string => (wokeAt === null ? `asleep` : `awake since ${timeAgo(new Date(wokeAt).getTime())}`);

/* SLOTS: a subscriber's (never a comped account's: the comp is "always on", not "any number of machines") and
 * bounded both ways. Up to the contract's cap; down only to what is standing, because a slot that is a machine
 * cannot be sold back while the machine is (the provision gate's rule, read the other way). */
const paying = computed(() => plan.value?.onPlan === true && !comped.value);
const canAddSlot = computed(() => paying.value && slots.value < HOSTED_PLAN_MAX_SLOTS);
const canRemoveSlot = computed(() => paying.value && slots.value > 1 && machines.value.length < slots.value);
const slotsError = ref<string | undefined>(undefined);
const changeSlots = async (delta: 1 | -1): Promise<void> => {
    slotsError.value = undefined;
    try {
        await setSlots(slots.value + delta);
    } catch (err) {
        slotsError.value = errorMessage(err, `Couldn't change the plan.`);
    }
};

// A plan with nothing under it: the one state in which cancelling is the advice rather than the door.
const planWithoutMachine = computed(() => paying.value && hosted.value !== undefined && machines.value.length === 0);
</script>

<template>
    <div class="@container flex flex-col gap-4">
        <Notice v-if="loadError" :of="{ tone: `danger`, title: `Couldn't load your plan.`, detail: loadError }" />

        <RowGroup v-else-if="plan && !plan.enabled" label="Billing">
            <RowNote variant="block">
                <p class="text-xs text-muted">This platform doesn't sell a hosted plan.</p>
            </RowNote>
        </RowGroup>

        <template v-else-if="plan">
            <!-- 1. THE PLAN. One line for where things stand, one door. -->

            <!-- COMPLIMENTARY: the operator's comp list. Nothing to manage, nothing to buy. -->
            <RowGroup v-if="plan.onPlan && comped" label="Hosted plan">
                <RowNote variant="block">
                    <p class="text-sm font-medium text-content">Complimentary</p>
                    <p class="mt-1 text-xs text-muted">Your hosted sandbox is always on and never collected, on the house. There is nothing to pay and nothing to cancel.</p>
                </RowNote>
            </RowGroup>

            <!-- ON THE PLAN: the date, the consequence if it is ending, and the one door. -->
            <RowGroup v-else-if="plan.onPlan" label="Hosted plan">
                <template v-if="periodEnd" #actions>
                    <span class="text-2xs" :class="cancelling ? `text-warning` : `text-subtle`">{{ dateWord }} {{ periodEnd }}</span>
                </template>
                <RowNote variant="block">
                    <div class="flex flex-col gap-3">
                        <template v-if="cancelling">
                            <p class="text-sm font-medium text-content">Your plan ends {{ periodEnd }}</p>
                            <p class="text-xs text-muted">
                                After that your hosted {{ machines.length === 1 ? `sandbox is` : `sandboxes are` }} on the free lane: the monthly hour ceiling
                                applies, and a machine unopened for a few weeks is removed. Files stay until then. Resuming keeps everything as it is.
                            </p>
                        </template>
                        <template v-else>
                            <p class="text-sm font-medium text-content">
                                {{ onTrial ? `You're on trial` : `Your hosted ${machines.length === 1 ? `sandbox is` : `sandboxes are`} always on` }}
                            </p>
                            <p class="text-xs text-muted">
                                ${{ price }} a month per hosted sandbox, {{ slots }} {{ slots === 1 ? `slot` : `slots` }} on the plan. No awake-hour ceiling, and
                                the machine is never collected. Nothing else about the product changes.
                            </p>
                        </template>
                        <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
                            <Button :label="cancelling ? `Resume on Stripe` : `Manage on Stripe`" size="small" class="ui-button-loud" :loading="working" @click="open(`portal`)" />
                            <span v-if="!cancelling" class="text-2xs text-subtle">Card, invoices and cancelling, on Stripe's own page.</span>
                        </div>
                    </div>
                </RowNote>
            </RowGroup>

            <!-- LAPSED: a subscriber whose card stopped working. One thing to do, said without a sales pitch. -->
            <RowGroup v-else-if="lapsed" label="Hosted plan">
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
            <RowGroup v-else-if="justJoined && activating" label="Hosted plan">
                <RowNote variant="block">
                    <div class="flex flex-col gap-2">
                        <p class="text-sm font-medium text-content">Payment received, activating your plan</p>
                        <p class="text-xs text-muted">Activating…</p>
                    </div>
                </RowNote>
            </RowGroup>

            <!-- THE OFFER: the one buying surface in the product. -->
            <template v-else>
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

            <!-- 2. THIS MONTH. The free lane's meter, live; a subscriber's awake hours with nothing beside them. -->
            <RowGroup v-if="hosted" label="This month">
                <template v-if="resetsOn" #actions>
                    <span class="text-2xs text-subtle">resets {{ resetsOn }}</span>
                </template>
                <RowNote variant="block">
                    <div v-if="meter" class="flex flex-col gap-2">
                        <div class="flex items-baseline justify-between gap-3">
                            <p class="text-sm font-medium" :class="meter.remainingMinutes === 0 ? `text-warning` : `text-content`">{{ hoursLeftLine(meter) }}</p>
                            <span class="text-2xs text-subtle">{{ formatMinutes(meter.usedMinutes) }} awake</span>
                        </div>
                        <!-- What is LEFT, as a bar: the same number the words carry, so colour never carries it alone. -->
                        <div class="h-1.5 w-full overflow-hidden rounded-full bg-content/10" role="presentation">
                            <div
                                class="h-full rounded-full transition-[width]"
                                :class="meter.fraction <= 0.125 ? `bg-warning` : `bg-primary-fill`"
                                :style="{ width: `${Math.round(meter.fraction * 100)}%` }"
                            />
                        </div>
                        <p class="text-2xs text-subtle">A sleeping machine spends no hours. On the plan there is no ceiling.</p>
                    </div>
                    <div v-else class="flex items-baseline justify-between gap-3">
                        <p class="text-sm font-medium text-content">{{ awakeThisMonth }} awake</p>
                        <span class="text-2xs text-subtle">no ceiling</span>
                    </div>
                </RowNote>
            </RowGroup>

            <!-- 3. THE HOSTED SANDBOXES the plan covers, and how many it could. -->
            <RowGroup v-if="hosted" label="Hosted sandboxes" :count="`${machines.length} of ${slots} ${slots === 1 ? `slot` : `slots`}`">
                <!-- A plan with nothing under it: the one state where cancelling is the advice. -->
                <RowNote v-if="planWithoutMachine" variant="block">
                    <div class="flex flex-col gap-3">
                        <p class="text-sm font-medium text-warning">Your plan covers a hosted sandbox, and you don't have one</p>
                        <p class="text-xs text-muted">You are paying for a machine that isn't there. Start one, or cancel the plan; nothing is lost either way.</p>
                        <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
                            <Button :as="RouterLink" :to="{ name: `setup` }" label="Start a hosted sandbox" size="small" class="ui-button-loud" />
                            <Button label="Cancel on Stripe" size="small" severity="secondary" :loading="working" @click="open(`portal`)" />
                        </div>
                    </div>
                </RowNote>
                <RowNote v-else-if="machines.length === 0" variant="block">
                    <p class="text-xs text-muted">
                        None yet. <RouterLink :to="{ name: `setup` }" class="text-link hover:underline">Start one</RouterLink>, free, in seconds.
                    </p>
                </RowNote>
                <RowNote v-else variant="block">
                    <ul class="flex flex-col divide-y divide-line">
                        <li v-for="machine in machines" :key="machine.sandboxId" class="flex items-baseline justify-between gap-3 py-1.5 first:pt-0 last:pb-0">
                            <span class="min-w-0 truncate text-sm text-content">{{ machine.name }}</span>
                            <span class="shrink-0 text-2xs text-subtle">{{ machine.region }} · {{ machineState(machine.wokeAt) }}</span>
                        </li>
                    </ul>
                </RowNote>
                <!-- SLOTS, a subscriber's control. Each is another machine at the same price, so the button says the money. -->
                <RowNote v-if="paying" variant="block">
                    <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
                        <Button
                            :label="`Add a hosted sandbox · +$${price}/month`"
                            size="small"
                            severity="secondary"
                            :disabled="!canAddSlot"
                            :loading="slotsWorking"
                            @click="changeSlots(1)"
                        />
                        <Button
                            v-if="slots > 1"
                            label="Remove a slot"
                            size="small"
                            severity="secondary"
                            text
                            :disabled="!canRemoveSlot"
                            :loading="slotsWorking"
                            v-tooltip.top="canRemoveSlot ? undefined : 'Remove a hosted sandbox first'"
                            @click="changeSlots(-1)"
                        />
                        <span class="text-2xs text-subtle">Charged for the rest of the month; Stripe prorates.</span>
                    </div>
                    <p v-if="slotsError" class="mt-2 text-2xs text-danger">{{ slotsError }}</p>
                </RowNote>
            </RowGroup>

            <!-- 4. WHAT A SLOT IS. The buyer should know what the money is a machine of. -->
            <RowGroup v-if="hosted && shape" label="What a slot is">
                <RowNote variant="block">
                    <dl class="grid grid-cols-1 gap-x-6 gap-y-2 text-xs @lg:grid-cols-[auto_1fr]">
                        <dt class="text-subtle">Machine</dt>
                        <dd class="text-muted">{{ shape }}, the same on the free lane and the plan.</dd>
                        <dt class="text-subtle">Free lane</dt>
                        <dd class="text-muted">One hosted sandbox, an awake-hour ceiling each month, removed after a few weeks unopened.</dd>
                        <dt class="text-subtle">On the plan</dt>
                        <dd class="text-muted">Always on and never removed, ${{ price }} a month per hosted sandbox. The same workspace, every feature.</dd>
                        <dt class="text-subtle">Teams</dt>
                        <dd class="text-muted">A shared sandbox runs on its owner's slot and month; teammates spend nothing of their own.</dd>
                    </dl>
                </RowNote>
            </RowGroup>
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
