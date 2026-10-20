<script setup lang="ts">
import { HOSTED_PLAN_MAX_SLOTS } from "@intentic/api-contract";
import { Await, Button, formatElapsed, Notice, RowGroup, RowNote } from "@intentic/ui";
import { type NoticeModel, usePoll } from "@intentic/ui/async";
import { timeAgo } from "@intentic/ui/format";
import { computed, onMounted } from "vue";
import { RouterLink, useRoute } from "vue-router";
import { useQueryClient } from "@tanstack/vue-query";
import HostedHoursMeter from "./hosted-plan/HostedHoursMeter.vue";
import { machineWords } from "./hosted-plan/machineWords";
import HostedPlanOffer from "./hosted-plan/HostedPlanOffer.vue";
import { formatDay, hoursMeter, machineHours, RECOVERABLE } from "../../models/hosted-plan/hostedHours";
import { dropStripeErrand, planMark, POLL_EVERY_MS, RETURN_WAIT_MS, waitForStripe } from "./hosted-plan/stripeErrand";
import { hasReturned, subscribeLabel, useHostedPlan } from "../../models/hosted-plan/useHostedPlan";
import { HOSTED_PLAN } from "../../lib/queryKeys";
import { apiClient } from "../../lib/useApi";
import { desktopVersion } from "../../app/environments/desktop";
import { dismissOperation, useOperation, useOperations } from "../../workbench/operations/operations";
import { onScreen } from "../../workbench/window/onScreen";
import type { HostedMigration, HostedPlanState } from "@intentic/api-contract";
import { useT } from "@intentic/ui/i18n";
import WaitProgress from "../../components/WaitProgress.vue";
import { useWaitClock } from "../../components/useWaitClock";

// The one page about money: what plan this account is on and the one action to take, the hosted sandboxes and the hours
// each one spends, the machines a slot buys, and the door to Stripe. Managed on Stripe, but consequences are said here
// (what cancelling does, why "ends" not "renews", a plan with no machine).
//
// HOURS ARE SAID PER HOSTED SANDBOX, NEVER AS THE ACCOUNT'S "THIS MONTH". A limit shown on its own at account level reads
// as a limit on everything, sandboxes on the reader's own computers included, which are never metered at all; so the
// hours sit on the machines that spend them, the free hours are named only where a machine spends them or a new one
// would start on what is left of them, and the list says in so many words that nothing else is counted.

const t = useT();

const { state: plan, loaded, refetch, setSlots, changeTier, tiers } = useHostedPlan();

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

// The app has no browser of its own: a navigation to Stripe is intercepted and handed to the reader's real browser
// (desktop-app `windows.rs`), so this window stays on this page. Nothing else would ever clear the press or re-read
// the plan, which is why the errand is waited out here (stripeErrand.ts) rather than ending in a redirect.
const inApp = desktopVersion() !== undefined;

type Door = `checkout` | `portal`;
// Every press of a door to Stripe, one run each, its progress naming the door once that stands open in the reader's
// browser: in the ledger, so a reader who looks elsewhere while paying comes back to the same wait. A press while one
// waits is a new errand that ends the old, hence a run per press rather than one refused while another waits.
const errands = useOperations<boolean, NoticeModel, Door>(`account/billing/stripe`);
const errand = computed(() => errands.all.value.at(-1));
const errandRunning = computed(() => errand.value?.state === `running`);
// The door standing open in the reader's browser, while it is.
const away = computed(() => (errandRunning.value ? errand.value?.progress : undefined));
// Asking Stripe for the page, before anything stands open.
const working = computed(() => errandRunning.value && errand.value?.progress === undefined);
const errandFailure = computed(() => errand.value?.failure);

// The plan read for the errand's wait straight from the platform, since the wait outlives this page's own query, and
// put in the cache every page draws from.
const client = useQueryClient();
const readPlan = async (): Promise<HostedPlanState> => {
    const state = await apiClient.hostedPlan.state();
    client.setQueryData(HOSTED_PLAN.every, state);
    return state;
};

const open = async (door: Door): Promise<void> => {
    if (working.value) {
        return;
    }
    for (const ended of errands.all.value.filter((run) => run.state !== `running`)) {
        dismissOperation(ended.key);
    }
    await errands.run(String(Date.now()), {
        what: door === `checkout` ? t(`settings.settingsBilling.checkoutOpenInBrowser`) : t(`settings.settingsBilling.stripeOpenInBrowser`),
        failed: t(`settings.settingsBilling.couldntOpenPayment`),
        // A browser leaves this page for Stripe's, so there is nobody left to tell.
        quiet: !inApp,
        done: (landed) => (landed ? t(`settings.settingsBilling.planChangedOnStripe`) : t(`settings.settingsBilling.stoppedWaitingForStripe`)),
        task: async (report) => {
            // Checkout buys the cheapest rung on sale; the ladder below is where another one is added.
            const { url } = await (door === `checkout` ? apiClient.hostedPlan.checkout({}) : apiClient.hostedPlan.portal());
            const left = planMark(plan.value);
            window.location.href = url;
            // A browser has left this page by now; in the app the line above became a browser window somewhere else, and
            // this one is still standing here, waiting for the answer to move.
            if (!inApp) {
                return false;
            }
            report.progress(door);
            return waitForStripe(left, readPlan);
        },
    });
};

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
const dateWord = computed(() => (cancelling.value ? t(`settings.settingsBilling.dateEnds`) : onTrial.value ? t(`settings.settingsBilling.dateTrialEnds`) : t(`settings.settingsBilling.dateRenews`)));

const buyLabel = computed(() => subscribeLabel(plan.value, returning.value));

// The reader saying the errand is over when it produced nothing: closed the tab, changed their mind. Nothing to
// undo — no session was ever charged — so this only stops the wait for it.
const dropAway = (): void => dropStripeErrand();

// The hosted lane as it applies to this account; present only where the platform runs machines.
const hosted = computed(() => plan.value?.hosted);
const machines = computed(() => hosted.value?.machines ?? []);
const slots = computed(() => hosted.value?.slots ?? 0);
// The slots a subscription bought, the free one aside: what "on the plan" counts.
const paidSlots = computed(() =>
    Object.entries(hosted.value?.slotsByTier ?? {}).reduce((sum, [tier, count]) => (tier === hosted.value?.freeTier.id ? sum : sum + count), 0),
);

// When every kind of hours comes back; one date, since the months are all calendar months (UTC).
const resetsOn = computed(() => (hosted.value === undefined ? undefined : formatDay(hosted.value.freeHours.resetsAt)));

// Each machine's hours as its row draws them: the account's free ones, or its own month on its slot.
const hoursOf = (machine: (typeof machines.value)[number]) => machineHours(plan.value, machine);

// What an empty list says about the free hours, and only once some are gone: a released machine's minutes stay in them,
// so a new machine starts on what is left rather than a fresh forty. Nothing at all while the month is untouched.
const freeHoursNote = computed(() => {
    const meter = hoursMeter(hosted.value?.freeHours);
    if (meter === undefined || meter.usedMinutes === 0) {
        return undefined;
    }
    return meter.remainingMinutes === 0
        ? t(`settings.settingsBilling.freeHoursSpentEmpty`, { resetsOn: formatDay(meter.resetsAt) })
        : t(`settings.settingsBilling.freeHoursLeftEmpty`, { left: formatElapsed(meter.remainingMinutes * 60, { largest: `hours` }), allowance: formatElapsed(meter.allowanceMinutes * 60, { largest: `hours` }) });
});

// A machine's standing this minute, off the row's own stamp: no provider call, honest about what it knows.
const machineState = (wokeAt: string | null): string => wokeAt === null ? t(`settings.settingsBilling.machineAsleep`) : t(`settings.settingsBilling.machineAwakeSince`, { ago: timeAgo(new Date(wokeAt).getTime()) });

// Slots are a subscriber's only (not comped); bounded up by the plan's cap, down by machines still standing.
const paying = computed(() => plan.value?.onPlan === true && !comped.value);
// A slot bought or given back, one at a time so racing presses can't overwrite each other, kept past this page.
const slotChange = useOperation(`account/billing/slots`);
const slotsWorking = slotChange.busy;
const slotsError = computed(() => slotChange.failure.value?.detail ?? slotChange.failure.value?.title);

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
            shape: machineWords(tier.id === free?.id ? free.shape : tier),
            hours: tier.id === free?.id ? (free?.monthlyHours ?? tier.monthlyHours) : tier.monthlyHours,
            held,
            standing: machines.value.filter((machine) => machine.tier === tier.id).length,
        };
    }),
);

const changeSlots = async (tier: string, quantity: number): Promise<void> => {
    await slotChange.run({
        what: t(`settings.settingsBilling.changingSlots`),
        failed: t(`settings.settingsBilling.couldntChangePlan`),
        task: () => setSlots(tier, quantity),
    });
};

// One move at a time, on any machine: the request answers only once the platform has snapshotted, moved and checked it
// (minutes), so it is the ledger's to keep, tagged with the sandbox it moves. A move that ended anywhere but `done`
// fails here, saying whether the machine was put back.
const move = useOperation<HostedMigration>(`account/billing/tier`);
const moving = computed(() => (move.busy.value ? move.operation.value?.tag : undefined));
const moveError = computed(() => move.failure.value?.detail ?? move.failure.value?.title);
// How long the move has run, under the machine it moves: minutes with the sandbox unreachable read as a fault without it.
const moveWait = useWaitClock(() => (move.busy.value ? move.operation.value?.startedAt : undefined));

// Whether this machine could move to that rung right now: a slot there, not already there, nothing in flight.
const canMoveTo = (machine: { sandboxId: string; tier: string }, rung: { id: string; held: number; standing: number }): boolean =>
    machine.tier !== rung.id && !move.busy.value && rung.standing < (rung.id === hosted.value?.freeTier.id ? slots.value : rung.held);

const moveTo = async (sandboxId: string, tier: string): Promise<void> => {
    const name = tiers.find((rung) => rung.id === tier)?.name ?? tier;
    await move.run({
        what: t(`settings.settingsBilling.movingToRung`, { name }),
        tag: sandboxId,
        failed: t(`settings.settingsBilling.couldntMoveSandbox`),
        done: () => t(`settings.settingsBilling.movedToRung`, { name }),
        task: async () => {
            const migration = await changeTier(sandboxId, tier);
            if (migration.state !== `done`) {
                throw new Error(migration.error ?? t(`settings.settingsBilling.machinePutBack`));
            }
            return migration;
        },
    });
};

// A plan with nothing under it: the one state in which cancelling is the advice rather than the door.
const planWithoutMachine = computed(() => paying.value && hosted.value !== undefined && machines.value.length === 0);

// Every door out of this page wants the platform's machine, never this computer's: without the rung named, setup in
// the app installs one here instead (setupArrival.ts), which is the opposite of what a page about hosting offers.
const HOSTED_SETUP = { name: `setup`, query: { machine: `hosted` } } as const;
</script>

<template>
    <div class="@container flex flex-col gap-6">
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

        <!-- The page as it last looked here while the plan is read, else the outline of one. -->
        <Await :of="loaded" imprint="settings.billing" :label="t(`settings.settingsBilling.readingPlan`)">
            <template #failed="{ error: failure }">
                <Notice :of="{ tone: `danger`, title: t(`settings.settingsBilling.couldntLoadYourPlan`), detail: failure }" />
            </template>
            <template #fallback>
                <RowGroup role="status" aria-busy="true" :aria-label="t(`settings.settingsBilling.readingPlan`)">
                    <template #label><span class="skeleton block h-2.5 w-28" aria-hidden="true" /></template>
                    <RowNote variant="block">
                        <div class="flex flex-col gap-2" aria-hidden="true">
                            <span class="skeleton block h-8 w-56" />
                            <span class="skeleton block h-2.5 w-full max-w-md" />
                            <span class="skeleton block h-2.5 w-2/3 max-w-sm" />
                        </div>
                    </RowNote>
                </RowGroup>
            </template>
            <template #default="{ data: plan, refreshError }">
                <Notice v-if="refreshError" :of="{ tone: `danger`, title: t(`settings.settingsBilling.couldntLoadYourPlan`), detail: refreshError }" />

                <RowGroup v-if="!plan.enabled" :label="t(`settings.settingsBilling.billing`)">
                    <RowNote variant="block">
                        <p class="text-xs text-muted">{{ t(`settings.settingsBilling.platformDoesntSellHosted`) }}</p>
                    </RowNote>
                </RowGroup>

                <div v-else class="flex flex-col gap-6">
                    <!-- The plan: one line for where things stand, one door. -->

                    <!-- Complimentary: the operator's comp list; nothing to manage or buy. -->
                    <RowGroup v-if="plan.onPlan && comped" :label="t(`settings.settingsBilling.hostedPlan`)">
                        <RowNote variant="block">
                            <p class="text-sm font-medium text-content">{{ t(`settings.settingsBilling.complimentary`) }}</p>
                            <p class="mt-1 text-xs text-muted">{{ t(`settings.settingsBilling.compedOnTheHouse`) }}</p>
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
                                        {{ t(`settings.settingsBilling.afterThatFreeHours`, { count: machines.length }, machines.length) }}
                                    </p>
                                </template>
                                <template v-else>
                                    <p class="text-sm font-medium text-content">
                                        {{ onTrial ? t(`settings.settingsBilling.youreOnTrial`) : t(`settings.settingsBilling.onHostedPlan`) }}
                                    </p>
                                    <p class="text-xs text-muted">
                                        {{ t(`settings.settingsBilling.slotsOnPlan`, { count: paidSlots }, paidSlots) }}
                                    </p>
                                </template>
                                <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
                                    <Button
                                        :label="cancelling ? t(`settings.settingsBilling.resumeOnStripe`) : t(`settings.settingsBilling.manageOnStripe`)"
                                        size="small"
                                        tier="loud"
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
                                <p class="text-xs text-muted">{{ t(`settings.settingsBilling.paymentFailedFreeHours`) }}</p>
                                <div class="flex flex-wrap items-center gap-x-4 gap-y-2">
                                    <Button
                                        :label="t(`settings.settingsBilling.updatePaymentOnStripe`)"
                                        :loading="working"
                                        tier="loud"
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
                                    <p class="flex items-center gap-2 text-xs text-muted">
                                        <Icon name="spinner" spin class="text-info" />
                                        {{ t(`settings.settingsBilling.waitingForStripe`) }}
                                    </p>
                                    <Button :label="t(`settings.settingsBilling.didntPayAfterAll`)" size="small" tier="quiet" @click="dropAway" />
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
                                title: t(`settings.settingsBilling.paymentWentThrough`),
                                detail: t(`settings.settingsBilling.paymentWentThroughDetail`),
                            }"
                        />
                        <Notice
                            v-if="returning"
                            :of="{
                                tone: `info`,
                                title: t(`settings.settingsBilling.previousPlanEnded`),
                                detail: t(`settings.settingsBilling.previousPlanEndedDetail`),
                            }"
                        />
                        <HostedPlanOffer :subscribe-label="buyLabel" :working="working" @checkout="open(`checkout`)" />
                    </template>

                    <!-- The hosted sandboxes, how many there is room for, and the hours each one spends: the only place on this page
                         hours are stated, beside the machines that spend them. -->
                    <RowGroup
                        v-if="hosted"
                        :label="t(`settings.settingsBilling.hostedSandboxes`)"
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
                                        tier="loud"
                                    />
                                    <Button
                                        :label="t(`settings.settingsBilling.cancelOnStripe`)"
                                        size="small"
                                        tier="boring"
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
                                <template v-if="freeHoursNote">{{ freeHoursNote }}</template>
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
                                            {{ machineWords(machine.shape) }} · {{ machine.region }} · {{ machineState(machine.wokeAt) }}
                                        </span>
                                        <!-- Whose hours this machine spends and what is left of them: its own month on a slot, or
                                             the account's free hours, shared when another machine spends them too. -->
                                        <HostedHoursMeter :hours="hoursOf(machine)" grow class="max-w-sm py-0.5" />
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
                                                tier="quiet"
                                                :disabled="!canMoveTo(machine, rung)"
                                                :loading="moving === machine.sandboxId"
                                                @click="moveTo(machine.sandboxId, rung.id)"
                                            />
                                        </span>
                                        <WaitProgress
                                            v-if="moving === machine.sandboxId && moveWait"
                                            :wait="moveWait"
                                            :what="t(`settings.settingsBilling.movingNote`)"
                                            :details="move.lines.value"
                                            class="max-w-sm"
                                        />
                                    </div>
                                </li>
                            </ul>
                        </RowNote>
                        <!-- Said once, as the list's last line, because it is the question a limit shown anywhere raises first:
                             what is counted, and that a sandbox on the reader's own computer never is. -->
                        <RowNote v-if="resetsOn" variant="block">
                            <p class="text-2xs text-subtle">{{ t(`settings.settingsBilling.hoursFootnote`, { resetsOn }) }}</p>
                        </RowNote>
                        <p v-if="moveError" class="mt-2 text-2xs text-danger">{{ moveError }}</p>
                    </RowGroup>

                    <!-- The ladder: every machine there is, what it costs, and how many of each this account holds. -->
                    <RowGroup v-if="hosted" :label="t(`settings.settingsBilling.theMachines`)">
                        <RowNote v-for="rung in ladder" :key="rung.id" variant="block">
                            <div class="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                                <span class="text-sm font-medium text-content">{{ rung.name }}</span>
                                <span class="text-2xs text-subtle">
                                    {{ rung.priceUsd === 0 ? t(`settings.settingsBilling.noCard`) : t(`settings.settingsBilling.pricePerMonth`, { price: rung.priceUsd }) }}
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
                                    tier="boring"
                                    :disabled="rung.held >= HOSTED_PLAN_MAX_SLOTS"
                                    :loading="slotsWorking"
                                    @click="changeSlots(rung.id, rung.held + 1)"
                                />
                                <Button
                                    v-if="rung.held > 0"
                                    :label="t(`settings.settingsBilling.removeSlot`)"
                                    size="small"
                                    tier="quiet"
                                    :disabled="rung.standing >= rung.held"
                                    :loading="slotsWorking"
                                    v-tooltip.top="
                                        rung.standing < rung.held
                                            ? undefined
                                            : { title: t(`settings.settingsBilling.slotsInUse`), note: t(`settings.settingsBilling.removeSandboxFirst`) }
                                    "
                                    @click="changeSlots(rung.id, rung.held - 1)"
                                />
                            </div>
                        </RowNote>
                        <RowNote variant="block">
                            <p class="text-2xs text-subtle">{{ t(`settings.settingsBilling.chargedRestMonthStripe`) }}</p>
                            <p v-if="slotsError" class="mt-2 text-2xs text-danger">{{ slotsError }}</p>
                        </RowNote>
                    </RowGroup>

                    <!-- How hosting works: what the free machine and a slot each come with, what an hour is, and what is never
                         counted at all. -->
                    <RowGroup v-if="hosted" :label="t(`settings.settingsBilling.howHostingWorks`)">
                        <RowNote variant="block">
                            <dl class="grid grid-cols-1 gap-x-6 gap-y-2 text-xs @lg:grid-cols-[auto_1fr]">
                                <dt class="text-subtle">{{ t(`settings.settingsBilling.freePlan`) }}</dt>
                                <dd class="text-muted">{{ t(`settings.settingsBilling.freePlanTerms`, { hours: hosted.freeTier.monthlyHours }) }}</dd>
                                <dt class="text-subtle">{{ t(`settings.settingsBilling.onPlan`) }}</dt>
                                <dd class="text-muted">{{ t(`settings.settingsBilling.slotTerms`) }}</dd>
                                <dt class="text-subtle">{{ t(`settings.settingsBilling.awakeHours`) }}</dt>
                                <dd class="text-muted">{{ t(`settings.settingsBilling.awakeHoursTerms`) }}</dd>
                                <dt class="text-subtle">{{ t(`settings.settingsBilling.ownComputer`) }}</dt>
                                <dd class="text-muted">{{ t(`settings.settingsBilling.ownComputerTerms`) }}</dd>
                                <dt class="text-subtle">{{ t(`settings.settingsBilling.teams`) }}</dt>
                                <dd class="text-muted">{{ t(`settings.settingsBilling.sharedSandboxSpendsOwners`) }}</dd>
                            </dl>
                        </RowNote>
                    </RowGroup>
                </div>
            </template>
        </Await>

        <Notice v-if="errandFailure" :of="errandFailure" />
    </div>
</template>
