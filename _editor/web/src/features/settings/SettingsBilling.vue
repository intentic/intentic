<script setup lang="ts">
import { HOSTED_PLAN_MAX_SLOTS } from "@intentic/api-contract";
import { hostedShapeLine } from "@intentic/constants";
import { Button, Notice, RowGroup, RowNote, useLoadingReveal } from "@intentic/ui";
import { errorMessage } from "@intentic/ui/async";
import { timeAgo } from "@intentic/ui/format";
import { computed, onMounted, onUnmounted, ref } from "vue";
import { RouterLink, useRoute } from "vue-router";
import HostedPlanOffer from "./hosted-plan/HostedPlanOffer.vue";
import { formatDay, formatMinutes, hoursLeftLine, RECOVERABLE } from "./hosted-plan/hostedHours";
import { hasReturned, subscribeLabel, useHostedPlan } from "./hosted-plan/useHostedPlan";
import { apiClient } from "../../lib/useApi";
import { desktopVersion } from "../../app/environments/desktop";
import type { HostedPlanState } from "@intentic/api-contract";
import { useT } from "@intentic/ui/i18n";

// The one page about money: what plan this account is on and the one action to take, this month's hours, the hosted
// sandboxes the plan covers, what a slot is, and the door to Stripe. Managed on Stripe, but consequences are said here
// (what cancelling does, why "ends" not "renews", a plan with no machine).

const t = useT();

const { state: plan, error, refetch, meter, setSlots, slotsWorking, changeTier, moving, tiers } = useHostedPlan();

const working = ref(false);
const actionError = ref<string | undefined>(undefined);

const loadError = computed(() => (error.value === null ? undefined : errorMessage(error.value, `Couldn't load the plan state.`)));

const outline = useLoadingReveal(
    computed(() => plan.value === undefined && error.value === null),
    computed(() => `hosted-plan`),
);

// Stripe's webhook can land seconds after redirect, so the first read after checkout may still say not-on-plan. Polls
// instead of asking for a reload, and gives up after a bounded wait.
const route = useRoute();
const justJoined = computed(() => route.query[`plan`] === `welcome`);
const waiting = ref(false);

// The app has no browser of its own: a navigation to Stripe is intercepted and handed to the reader's real browser
// (desktop-app `windows.rs`), so this window stays on this page. Nothing else would ever clear the press or re-read
// the plan, which is why the errand is tracked here rather than ending in a redirect.
const inApp = desktopVersion() !== undefined;
// The door standing open in the reader's browser, while it is.
const away = ref<`checkout` | `portal` | undefined>(undefined);

const POLL_EVERY_MS = 3_000;
// The webhook's few seconds, once Stripe has already sent the browser back here.
const RETURN_WAIT_MS = 40_000;
// Someone typing a card into another window, which is a different order of time.
const BROWSER_WAIT_MS = 10 * 60_000;

// The plan half of the answer, which is all an errand on Stripe can change. The hosted half moves on its own — a
// machine waking, a minute spent — and comparing it would report a change nobody made.
const planMark = (state: HostedPlanState | undefined): string =>
    state === undefined
        ? ``
        : `${state.onPlan}:${state.status ?? ``}:${state.renewsAt ?? ``}:${state.cancelAtPeriodEnd === true}:${state.comped === true}:${state.hosted?.slots ?? 0}`;

// What the plan said when the errand left for the browser; the errand is over when the answer differs.
let leftWith = ``;
let poll: ReturnType<typeof setInterval> | undefined;
let waitUntil = 0;

const stopWaiting = (): void => {
    if (poll !== undefined) {
        clearInterval(poll);
        poll = undefined;
    }
    waiting.value = false;
};

// A redirect back is answered by the plan going live; an errand still out in the browser, by the answer changing at
// all — a cancellation and a new card are the same round trip as a payment, and neither turns `onPlan` on.
const landed = (): boolean => (away.value === undefined ? plan.value?.onPlan === true : planMark(plan.value) !== leftWith);

const waitForPlan = (forMs: number): void => {
    waitUntil = Math.max(waitUntil, Date.now() + forMs);
    if (poll !== undefined) {
        return;
    }
    waiting.value = true;
    const tick = (): void => {
        void refetch().then(() => {
            if (landed()) {
                away.value = undefined;
                stopWaiting();
            } else if (Date.now() > waitUntil) {
                stopWaiting();
            }
        });
    };
    poll = setInterval(tick, POLL_EVERY_MS);
    tick();
};

// Coming back to this window is the only thing the app hears about an errand it handed to the browser, so the return
// re-reads the plan and keeps re-reading for the webhook's few seconds.
const onFocus = (): void => {
    if (away.value !== undefined) {
        waitForPlan(RETURN_WAIT_MS);
    }
};

onUnmounted(() => {
    stopWaiting();
    window.removeEventListener(`focus`, onFocus);
});

onMounted(() => {
    window.addEventListener(`focus`, onFocus);
    if (justJoined.value && plan.value?.onPlan !== true) {
        waitForPlan(RETURN_WAIT_MS);
    }
});

const periodEnd = computed(() => (plan.value?.renewsAt === undefined ? undefined : formatDay(plan.value.renewsAt)));

// past_due/unpaid/incomplete mean Stripe is retrying a live subscription, not that it ended (hostedHours.ts).
const lapsed = computed(() => {
    const status = plan.value?.status;
    return plan.value?.onPlan === false && status !== undefined && RECOVERABLE.has(status) ? status : undefined;
});

const returning = computed(() => hasReturned(plan.value) && lapsed.value === undefined);

// Trial and cancelled plans both end, not renew; the wrong word implies a charge that isn't coming.
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
        // Checkout buys the cheapest rung on sale; the ladder below is where another one is added.
        const { url } = await (door === `checkout` ? apiClient.hostedPlan.checkout({}) : apiClient.hostedPlan.portal());
        window.location.href = url;
        // A browser has left this page by now; in the app the line above became a browser window somewhere else, and
        // this one is still standing here holding a pressed button.
        if (inApp) {
            working.value = false;
            leftWith = planMark(plan.value);
            away.value = door;
            waitForPlan(BROWSER_WAIT_MS);
        }
    } catch (err) {
        actionError.value = errorMessage(err, `Couldn't open the payment page.`);
        working.value = false;
    }
};

// The reader saying the errand is over when it produced nothing: closed the tab, changed their mind. Nothing to
// undo — no session was ever charged — so this only stops the page waiting for it.
const dropAway = (): void => {
    away.value = undefined;
    stopWaiting();
};

// The hosted lane as it applies to this account; present only where the platform runs machines.
const hosted = computed(() => plan.value?.hosted);
const machines = computed(() => hosted.value?.machines ?? []);
const slots = computed(() => hosted.value?.slots ?? 0);
const price = computed(() => plan.value?.priceUsd ?? 0);
// The machine a sandbox lands on with nothing bought, as this deployment sizes it.
const freeShape = computed(() => {
    const free = hosted.value?.freeTier;
    return free === undefined ? undefined : hostedShapeLine(free.shape);
});

const resetsOn = computed(() => (hosted.value === undefined ? undefined : formatDay(hosted.value.usage.resetsAt)));
const awakeThisMonth = computed(() => (hosted.value === undefined ? undefined : formatMinutes(hosted.value.usage.usedMinutes)));

// A machine's standing this minute, off the row's own stamp: no provider call, honest about what it knows.
const machineState = (wokeAt: string | null): string => (wokeAt === null ? `asleep` : `awake since ${timeAgo(new Date(wokeAt).getTime())}`);

// Slots are a subscriber's only (not comped); bounded up by the plan's cap, down by machines still standing.
const paying = computed(() => plan.value?.onPlan === true && !comped.value);
const slotsError = ref<string | undefined>(undefined);

/* THE LADDER AS THIS PAGE SHOWS IT: every rung, what it is, what it costs, how many slots are held at it and how
 * many of those a machine already stands on. Free is on the list because it is a rung like the others; it just is
 * not bought, and its shape is this deployment's rather than the published one's. */
const ladder = computed(() =>
    tiers.map((tier) => {
        const held = hosted.value?.slotsByTier[tier.id] ?? 0;
        const free = hosted.value?.freeTier;
        return {
            id: tier.id,
            name: tier.name,
            priceUsd: tier.priceUsd,
            shape: hostedShapeLine(tier.id === free?.id ? free.shape : tier),
            hours: tier.id === free?.id ? (free?.monthlyHours ?? tier.monthlyHours) : tier.monthlyHours,
            held,
            standing: machines.value.filter((machine) => machine.tier === tier.id).length,
        };
    }),
);

const changeSlots = async (tier: string, quantity: number): Promise<void> => {
    slotsError.value = undefined;
    try {
        await setSlots(tier, quantity);
    } catch (err) {
        slotsError.value = errorMessage(err, `Couldn't change the plan.`);
    }
};

// Whether this machine could move to that rung right now: a slot there, not already there, nothing in flight.
const canMoveTo = (machine: { sandboxId: string; tier: string }, rung: { id: string; held: number; standing: number }): boolean =>
    machine.tier !== rung.id && moving.value === undefined && rung.standing < (rung.id === hosted.value?.freeTier.id ? slots.value : rung.held);

const moveError = ref<string | undefined>(undefined);
const moveTo = async (sandboxId: string, tier: string): Promise<void> => {
    moveError.value = undefined;
    try {
        const migration = await changeTier(sandboxId, tier);
        if (migration.state !== `done`) {
            moveError.value = migration.error ?? `The machine was put back as it was.`;
        }
    } catch (err) {
        moveError.value = errorMessage(err, `Couldn't move this sandbox.`);
    }
};

// A plan with nothing under it: the one state in which cancelling is the advice rather than the door.
const planWithoutMachine = computed(() => paying.value && hosted.value !== undefined && machines.value.length === 0);

// Every door out of this page wants the platform's machine, never this computer's: without the rung named, setup in
// the app installs one here instead (setupArrival.ts), which is the opposite of what a page about hosting offers.
const HOSTED_SETUP = { name: `setup`, query: { machine: `hosted` } } as const;
</script>

<template>
    <div class="@container flex flex-col gap-4">
        <!-- Stripe's own page, standing open in the reader's browser because this window has none of its own to put it
             in. Checkout has a card of its own below, since that one must not be startable twice. -->
        <Notice
            v-if="away === `portal`"
            :of="{
                tone: `info`,
                title: t(`settings.settingsBilling.stripeOpenInBrowser`),
                detail: t(`settings.settingsBilling.whateverChangeThereShows`),
            }"
        />

        <Notice v-if="loadError" :of="{ tone: `danger`, title: `Couldn't load your plan.`, detail: loadError }" />

        <RowGroup v-else-if="plan && !plan.enabled" :label="t(`settings.settingsBilling.billing`)">
            <RowNote variant="block">
                <p class="text-xs text-muted">{{ t(`settings.settingsBilling.platformDoesntSellHosted`) }}</p>
            </RowNote>
        </RowGroup>

        <template v-else-if="plan">
            <!-- The plan: one line for where things stand, one door. -->

            <!-- Complimentary: the operator's comp list; nothing to manage or buy. -->
            <RowGroup v-if="plan.onPlan && comped" :label="t(`settings.settingsBilling.hostedPlan`)">
                <RowNote variant="block">
                    <p class="text-sm font-medium text-content">{{ t(`settings.settingsBilling.complimentary`) }}</p>
                    <p class="mt-1 text-xs text-muted">{{ t(`settings.settingsBilling.hostedSandboxAlwaysOn`) }}</p>
                </RowNote>
            </RowGroup>

            <!-- On the plan: the date, the consequence if ending, and the one door. -->
            <RowGroup v-else-if="plan.onPlan" :label="t(`settings.settingsBilling.hostedPlan`)">
                <template v-if="periodEnd" #actions>
                    <span class="text-2xs" :class="cancelling ? `text-warning` : `text-subtle`">{{ dateWord }} {{ periodEnd }}</span>
                </template>
                <RowNote variant="block">
                    <div class="flex flex-col gap-3">
                        <template v-if="cancelling">
                            <p class="text-sm font-medium text-content">{{ t(`settings.settingsBilling.planEnds`, { periodEnd }) }}</p>
                            <p class="text-xs text-muted">
                                {{ t(`settings.settingsBilling.afterThatFreeLane`, { count: machines.length }, machines.length) }}
                            </p>
                        </template>
                        <template v-else>
                            <p class="text-sm font-medium text-content">
                                {{
                                    onTrial
                                        ? t(`settings.settingsBilling.youreOnTrial`)
                                        : t(`settings.settingsBilling.alwaysOn`, { count: machines.length }, machines.length)
                                }}
                            </p>
                            <p class="text-xs text-muted">
                                {{ t(`settings.settingsBilling.perMonthPerSandbox`, { price, count: slots }, slots) }}
                            </p>
                        </template>
                        <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
                            <Button
                                :label="cancelling ? t(`settings.settingsBilling.resumeOnStripe`) : t(`settings.settingsBilling.manageOnStripe`)"
                                size="small"
                                class="ui-button-loud"
                                :loading="working"
                                @click="open(`portal`)"
                            />
                            <span v-if="!cancelling" class="text-2xs text-subtle">{{ t(`settings.settingsBilling.cardInvoicesCancellingOn`) }}</span>
                        </div>
                    </div>
                </RowNote>
            </RowGroup>

            <!-- Lapsed: a subscriber whose card stopped working; one thing to do, no sales pitch. -->
            <RowGroup v-else-if="lapsed" :label="t(`settings.settingsBilling.hostedPlan`)">
                <RowNote variant="block">
                    <div class="flex flex-col gap-3">
                        <p class="text-sm font-medium text-warning">{{ t(`settings.settingsBilling.planNeedsWorkingCard`) }}</p>
                        <p class="text-xs text-muted">{{ t(`settings.settingsBilling.paymentFailedUntilGoes`) }}</p>
                        <div class="flex flex-wrap items-center gap-x-4 gap-y-2">
                            <Button
                                :label="t(`settings.settingsBilling.updatePaymentOnStripe`)"
                                :loading="working"
                                class="ui-button-loud"
                                @click="open(`portal`)"
                            />
                            <p class="text-2xs text-subtle">{{ t(`settings.settingsBilling.stripeReportsPlan`, { lapsed }) }}</p>
                        </div>
                    </div>
                </RowNote>
            </RowGroup>

            <!-- Activating: the webhook's few seconds, owned by the app instead of handed back to the payer. -->
            <RowGroup v-else-if="justJoined && waiting" :label="t(`settings.settingsBilling.hostedPlan`)">
                <RowNote variant="block">
                    <div class="flex flex-col gap-2">
                        <p class="text-sm font-medium text-content">{{ t(`settings.settingsBilling.paymentReceivedActivatingPlan`) }}</p>
                        <p class="text-xs text-muted">{{ t(`settings.settingsBilling.activating`) }}</p>
                    </div>
                </RowNote>
            </RowGroup>

            <!-- Checkout, open in the reader's browser: this replaces the offer rather than sitting beside it, since a
                 second press here would be a second subscription on one account. -->
            <RowGroup v-else-if="away === `checkout`" :label="t(`settings.settingsBilling.hostedPlan`)">
                <RowNote variant="block">
                    <div class="flex flex-col gap-3">
                        <p class="text-sm font-medium text-content">{{ t(`settings.settingsBilling.checkoutOpenInBrowser`) }}</p>
                        <p class="text-xs text-muted">{{ t(`settings.settingsBilling.finishPayingThereNothing`) }}</p>
                        <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
                            <!-- Says the page is watching, rather than offering a press that would only start the read
                                 already running. Coming back to this window re-arms it either way. -->
                            <p v-if="waiting" class="flex items-center gap-2 text-xs text-muted">
                                <Icon name="spinner" spin class="text-info" />
                                {{ t(`settings.settingsBilling.waitingForStripe`) }}
                            </p>
                            <Button :label="t(`settings.settingsBilling.didntPayAfterAll`)" size="small" severity="secondary" text @click="dropAway" />
                        </div>
                    </div>
                </RowNote>
            </RowGroup>

            <!-- The offer: the one buying surface in the product. -->
            <template v-else>
                <Notice
                    v-if="justJoined && !waiting"
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

            <!-- This month: the free plan's meter, live, or a subscriber's awake hours with nothing beside them. -->
            <RowGroup v-if="hosted" :label="t(`settings.settingsBilling.month`)">
                <template v-if="resetsOn" #actions>
                    <span class="text-2xs text-subtle">{{ t(`settings.settingsBilling.resets`, { resetsOn }) }}</span>
                </template>
                <RowNote variant="block">
                    <div v-if="meter" class="flex flex-col gap-2">
                        <div class="flex items-baseline justify-between gap-3">
                            <p class="text-sm font-medium" :class="meter.remainingMinutes === 0 ? `text-warning` : `text-content`">
                                {{ hoursLeftLine(meter) }}
                            </p>
                            <span class="text-2xs text-subtle">{{
                                t(`settings.settingsBilling.awake`, { usedMinutes: formatMinutes(meter.usedMinutes) })
                            }}</span>
                        </div>
                        <!-- What's left, as a bar: the same number the words state, so colour never carries it alone. -->
                        <div class="h-1.5 w-full overflow-hidden rounded-full bg-content/10" role="presentation">
                            <div
                                class="h-full rounded-full transition-[width]"
                                :class="meter.fraction <= 0.125 ? `bg-warning` : `bg-primary-fill`"
                                :style="{ width: `${Math.round(meter.fraction * 100)}%` }"
                            />
                        </div>
                        <p class="text-2xs text-subtle">{{ t(`settings.settingsBilling.sleepingMachineSpendsNo`) }}</p>
                    </div>
                    <div v-else class="flex items-baseline justify-between gap-3">
                        <p class="text-sm font-medium text-content">{{ t(`settings.settingsBilling.awake2`, { awakeThisMonth }) }}</p>
                        <span class="text-2xs text-subtle">{{ t(`settings.settingsBilling.noCeiling`) }}</span>
                    </div>
                </RowNote>
            </RowGroup>

            <!-- The hosted sandboxes the plan covers, and how many it could. -->
            <RowGroup
                v-if="hosted"
                :label="t(`settings.settingsBilling.hostedSandboxes`)"
                :count="`${machines.length} of ${slots} ${slots === 1 ? `slot` : `slots`}`"
            >
                <!-- The one state where cancelling is the advice, not the door. -->
                <RowNote v-if="planWithoutMachine" variant="block">
                    <div class="flex flex-col gap-3">
                        <p class="text-sm font-medium text-warning">{{ t(`settings.settingsBilling.planCoversHostedSandbox`) }}</p>
                        <p class="text-xs text-muted">{{ t(`settings.settingsBilling.payingMachineIsntStart`) }}</p>
                        <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
                            <Button
                                :as="RouterLink"
                                :to="HOSTED_SETUP"
                                :label="t(`settings.settingsBilling.startHostedSandbox`)"
                                size="small"
                                class="ui-button-loud"
                            />
                            <Button
                                :label="t(`settings.settingsBilling.cancelOnStripe`)"
                                size="small"
                                severity="secondary"
                                :loading="working"
                                @click="open(`portal`)"
                            />
                        </div>
                    </div>
                </RowNote>
                <RowNote v-else-if="machines.length === 0" variant="block">
                    <p class="text-xs text-muted">
                        {{ t(`settings.settingsBilling.noneYet`) }}
                        <RouterLink :to="HOSTED_SETUP" class="text-link hover:underline">{{ t(`settings.settingsBilling.startOne`) }}</RouterLink
                        >{{ t(`settings.settingsBilling.freeInSeconds`) }}
                    </p>
                </RowNote>
                <RowNote v-else variant="block">
                    <ul class="flex flex-col divide-y divide-line">
                        <li
                            v-for="machine in machines"
                            :key="machine.sandboxId"
                            class="flex items-baseline justify-between gap-3 py-1.5 first:pt-0 last:pb-0"
                        >
                            <div class="flex min-w-0 flex-col gap-1">
                                <span class="min-w-0 truncate text-sm text-content">{{ machine.name }}</span>
                                <!-- This machine's own shape and month, from its row: once rungs differ, the account has neither. -->
                                <span class="text-2xs text-subtle">
                                    {{ hostedShapeLine(machine.shape) }} · {{ machine.region }} · {{ machineState(machine.wokeAt) }}
                                    <template v-if="machine.allowanceMinutes !== null">
                                        {{
                                            t(`settings.settingsBilling.hoursOfMonth`, {
                                                used: formatMinutes(machine.usedMinutes),
                                                allowance: formatMinutes(machine.allowanceMinutes),
                                            })
                                        }}
                                    </template>
                                </span>
                                <!-- The one upgrade prompt on this page, and it is a fact the provider reported rather
                                     than a pitch: this machine was killed for memory, this many times, at this size. -->
                                <span v-if="machine.oomsThisWeek > 0" class="text-2xs text-warning">
                                    {{
                                        t(
                                            `settings.settingsBilling.ranOutOfMemory`,
                                            { count: machine.oomsThisWeek, memory: machine.shape.memoryMb / 1024 },
                                            machine.oomsThisWeek,
                                        )
                                    }}
                                </span>
                                <!-- Moving is its own act: the slot is already bought, and this puts the machine on it. -->
                                <span v-if="hosted" class="flex flex-wrap items-center gap-1.5">
                                    <Button
                                        v-for="rung in ladder"
                                        :key="rung.id"
                                        :label="t(`settings.settingsBilling.moveToRung`, { name: rung.name })"
                                        size="small"
                                        severity="secondary"
                                        text
                                        :disabled="!canMoveTo(machine, rung)"
                                        :loading="moving === machine.sandboxId"
                                        @click="moveTo(machine.sandboxId, rung.id)"
                                    />
                                </span>
                            </div>
                        </li>
                    </ul>
                </RowNote>
                <p v-if="moveError" class="mt-2 text-2xs text-danger">{{ moveError }}</p>
            </RowGroup>

            <!-- The ladder: every machine there is, what it costs, and how many of each this account holds. -->
            <RowGroup v-if="hosted" :label="t(`settings.settingsBilling.theMachines`)">
                <RowNote v-for="rung in ladder" :key="rung.id" variant="block">
                    <div class="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                        <span class="text-sm font-medium text-content">{{ rung.name }}</span>
                        <span class="text-2xs text-subtle">
                            {{ rung.priceUsd === 0 ? t(`settings.settingsBilling.noCard`) : `$${rung.priceUsd}/month` }}
                        </span>
                    </div>
                    <p class="mt-1 text-xs text-muted">
                        {{ rung.shape }} · {{ t(`settings.settingsBilling.awakeHoursMonth`, { hours: rung.hours }) }}
                    </p>
                    <div v-if="paying && rung.priceUsd > 0" class="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2">
                        <span class="text-2xs text-subtle">{{ t(`settings.settingsBilling.slotsHeld`, { held: rung.held, standing: rung.standing }) }}</span>
                        <Button
                            :label="t(`settings.settingsBilling.addSlotAt`, { price: rung.priceUsd })"
                            size="small"
                            severity="secondary"
                            :disabled="rung.held >= HOSTED_PLAN_MAX_SLOTS"
                            :loading="slotsWorking"
                            @click="changeSlots(rung.id, rung.held + 1)"
                        />
                        <Button
                            v-if="rung.held > 0"
                            :label="t(`settings.settingsBilling.removeSlot`)"
                            size="small"
                            severity="secondary"
                            text
                            :disabled="rung.standing >= rung.held"
                            :loading="slotsWorking"
                            v-tooltip.top="rung.standing < rung.held ? undefined : t(`settings.settingsBilling.removeHostedSandboxFirst`)"
                            @click="changeSlots(rung.id, rung.held - 1)"
                        />
                    </div>
                </RowNote>
                <RowNote variant="block">
                    <p class="text-2xs text-subtle">{{ t(`settings.settingsBilling.chargedRestMonthStripe`) }}</p>
                    <p v-if="slotsError" class="mt-2 text-2xs text-danger">{{ slotsError }}</p>
                </RowNote>
            </RowGroup>

            <!-- What a slot is: what the money is a machine of. -->
            <RowGroup v-if="hosted && freeShape" :label="t(`settings.settingsBilling.whatSlot`)">
                <RowNote variant="block">
                    <dl class="grid grid-cols-1 gap-x-6 gap-y-2 text-xs @lg:grid-cols-[auto_1fr]">
                        <dt class="text-subtle">{{ t(`settings.settingsBilling.machine`) }}</dt>
                        <dd class="text-muted">{{ t(`settings.settingsBilling.sameOnFreeLane`, { shape: freeShape }) }}</dd>
                        <dt class="text-subtle">{{ t(`settings.settingsBilling.freePlan`) }}</dt>
                        <dd class="text-muted">{{ t(`settings.settingsBilling.oneHostedSandboxAwake`) }}</dd>
                        <dt class="text-subtle">{{ t(`settings.settingsBilling.onPlan`) }}</dt>
                        <dd class="text-muted">{{ t(`settings.settingsBilling.alwaysOnNeverRemoved`, { price }) }}</dd>
                        <dt class="text-subtle">{{ t(`settings.settingsBilling.teams`) }}</dt>
                        <dd class="text-muted">{{ t(`settings.settingsBilling.sharedSandboxRunsOn`) }}</dd>
                    </dl>
                </RowNote>
            </RowGroup>
        </template>

        <RowGroup v-else-if="outline" role="status" aria-busy="true">
            <span class="sr-only">{{ t(`settings.settingsBilling.readingPlan`) }}</span>
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
