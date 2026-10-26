<script setup lang="ts">
import { HOSTED_PLAN_MAX_SLOTS } from "@intentic/api-contract";
import { Await, Button, Icon, Notice } from "@intentic/ui";
import { type NoticeModel, usePoll } from "@intentic/ui/async";
import { computed, onMounted, ref } from "vue";
import { RouterLink, useRoute } from "vue-router";
import { useQueryClient } from "@tanstack/vue-query";
import BillingStatusCard from "./hosted-plan/BillingStatusCard.vue";
import HostedMachineRow from "./hosted-plan/HostedMachineRow.vue";
import HostedPlanFaq from "./hosted-plan/HostedPlanFaq.vue";
import HostedPlanOffer from "./hosted-plan/HostedPlanOffer.vue";
import HostedTierCard from "./hosted-plan/HostedTierCard.vue";
import { monthlyTotalUsd, planLadder, type Rung } from "./hosted-plan/planLadder";
import { formatDay, machineHours, RECOVERABLE } from "../../models/hosted-plan/hostedHours";
import { dropStripeErrand, planMark, POLL_EVERY_MS, RETURN_WAIT_MS, waitForStripe } from "./hosted-plan/stripeErrand";
import { hasReturned, useHostedPlan } from "../../models/hosted-plan/useHostedPlan";
import { HOSTED_PLAN } from "../../lib/queryKeys";
import { apiClient } from "../../lib/useApi";
import { desktopVersion } from "../../app/environments/desktop";
import { dismissOperation, useOperation, useOperations } from "../../workbench/operations/operations";
import { onScreen } from "../../workbench/window/onScreen";
import type { HostedMigration, HostedPlanState } from "@intentic/api-contract";
import { useT } from "@intentic/ui/i18n";

// The one page about money, laid out in the order a person asks: where do I stand (one status card, one door), what
// am I running (each hosted sandbox with its hours), what could I have (every machine as a card to compare, each with
// its own button), and the fine print as questions folded until asked. Managed on Stripe, but consequences are said
// here (what cancelling does, why "ends" not "renews", a plan with no machine).
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

// The rung whose checkout was pressed, so only that card's button waits.
const openingTier = ref<string>();
const opening = computed(() => (working.value && errand.value?.state === `running` ? openingTier.value : undefined));

const open = async (door: Door, tier?: string): Promise<void> => {
    if (working.value) {
        return;
    }
    openingTier.value = tier;
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
            // Checkout buys the rung the reader picked; unnamed, the platform sells its cheapest.
            const { url } = await (door === `checkout` ? apiClient.hostedPlan.checkout(tier === undefined ? {} : { tier }) : apiClient.hostedPlan.portal());
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

// The reader saying the errand is over when it produced nothing: closed the tab, changed their mind. Nothing to
// undo — no session was ever charged — so this only stops the wait for it.
const dropAway = (): void => dropStripeErrand();

// The hosted lane as it applies to this account; present only where the platform runs machines.
const hosted = computed(() => plan.value?.hosted);
const machines = computed(() => hosted.value?.machines ?? []);
const slots = computed(() => hosted.value?.slots ?? 0);
// When every kind of hours comes back; one date, since the months are all calendar months (UTC).
const resetsOn = computed(() => (hosted.value === undefined ? undefined : formatDay(hosted.value.freeHours.resetsAt)));

// Each machine's hours as its row draws them: the account's free ones, or its own month on its slot.
const hoursOf = (machine: (typeof machines.value)[number]) => machineHours(plan.value, machine);

// Slots are a subscriber's only (not comped); bounded up by the plan's cap, down by machines still standing.
const paying = computed(() => plan.value?.onPlan === true && !comped.value);
// A slot bought or given back, one at a time so racing presses can't overwrite each other, kept past this page.
const slotChange = useOperation(`account/billing/slots`);
const slotsWorking = slotChange.busy;
const slotsError = computed(() => slotChange.failure.value?.detail ?? slotChange.failure.value?.title);

// Every rung as a card: what it is, what it costs, whether it is on sale here, how many slots are held at it.
const ladder = computed(() => planLadder(plan.value, tiers));
// A subscriber's own cards: the rungs a slot can be bought or held at, drawn on the whole ladder's scale.
const paidRungs = computed(() => ladder.value.filter((rung) => !rung.free && (rung.onSale || rung.held > 0)));
const maxHours = computed(() => Math.max(...ladder.value.map((rung) => rung.hours)));
const rungName = (id: string): string => ladder.value.find((rung) => rung.id === id)?.name ?? id;
// The rung the account's free machine stands on, for the offer's "current" mark.
const currentTier = computed(() => machines.value.find((machine) => machine.tier === hosted.value?.freeTier.id)?.tier);

// "1 Standard slot, 1 Max slot · $70/month": what the subscription is, in one line.
const planSummary = computed(() => {
    const held = ladder.value.filter((rung) => !rung.free && rung.held > 0);
    const slotsWords = held.map((rung) => t(`settings.settingsBilling.slotsAt`, { count: rung.held, name: rung.name }, rung.held)).join(`, `);
    const total = monthlyTotalUsd(ladder.value);
    return held.length === 0 ? undefined : t(`settings.settingsBilling.planSummary`, { slots: slotsWords, total });
});

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
const moveWait = move.meter;

// Whether this machine could move to that rung right now: a slot there, not already there, nothing in flight.
const canMoveTo = (machine: { tier: string }, rung: Rung): boolean =>
    machine.tier !== rung.id && rung.standing < (rung.free ? slots.value : rung.held);
// The rungs a row offers: only moves that would work, and none while another move runs.
const targetsOf = (machine: { tier: string }): Rung[] => (move.busy.value ? [] : ladder.value.filter((rung) => canMoveTo(machine, rung)));

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

// Every door out of this page wants the platform's machine, never this computer's: Home's new sandbox, with a machine
// of ours picked, which is what a page about hosting offers.
const HOSTED_SETUP = { path: `/home`, query: { add: `sandbox`, machine: `hosted` } } as const;
</script>

<template>
    <div class="@container flex flex-col gap-10">
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
                <div class="flex flex-col gap-6" role="status" aria-busy="true" :aria-label="t(`settings.settingsBilling.readingPlan`)">
                    <div class="flex flex-col gap-2" aria-hidden="true">
                        <span class="skeleton block h-2.5 w-28" />
                        <span class="skeleton block h-7 w-80 max-w-full" />
                        <span class="skeleton block h-2.5 w-full max-w-md" />
                    </div>
                    <div class="grid grid-cols-1 gap-4 @2xl:grid-cols-3" aria-hidden="true">
                        <span v-for="n in 3" :key="n" class="skeleton block h-80 rounded-xl" />
                    </div>
                </div>
            </template>
            <template #default="{ data: plan, refreshError }">
                <Notice v-if="refreshError" :of="{ tone: `danger`, title: t(`settings.settingsBilling.couldntLoadYourPlan`), detail: refreshError }" />

                <BillingStatusCard
                    v-if="!plan.enabled"
                    tone="neutral"
                    icon="credit-card"
                    :title="t(`settings.settingsBilling.billing`)"
                    :detail="t(`settings.settingsBilling.platformDoesntSellHosted`)"
                />

                <div v-else class="flex flex-col gap-10">
                    <!-- 1. WHERE THINGS STAND: one card, one door. -->

                    <!-- Complimentary: the operator's comp list; nothing to manage or buy. -->
                    <BillingStatusCard
                        v-if="plan.onPlan && comped"
                        tone="success"
                        icon="gift"
                        :title="t(`settings.settingsBilling.complimentary`)"
                        :detail="t(`settings.settingsBilling.compedOnTheHouse`)"
                    />

                    <!-- On the plan: what it is, the date, the consequence if ending, and the one door. -->
                    <BillingStatusCard
                        v-else-if="plan.onPlan"
                        :tone="cancelling ? `warning` : `success`"
                        :icon="cancelling ? `clock` : `check-circle`"
                        :title="
                            cancelling
                                ? t(`settings.settingsBilling.planEnds`, { periodEnd })
                                : onTrial
                                  ? t(`settings.settingsBilling.youreOnTrial`)
                                  : t(`settings.settingsBilling.onHostedPlan`)
                        "
                        :detail="cancelling ? t(`settings.settingsBilling.afterThatFreeHours`, { count: machines.length }, machines.length) : planSummary"
                    >
                        <template v-if="periodEnd" #aside>
                            <span class="text-2xs font-medium" :class="cancelling ? `text-warning` : `text-subtle`">{{ dateWord }} {{ periodEnd }}</span>
                        </template>
                        <template #actions>
                            <Button
                                :label="cancelling ? t(`settings.settingsBilling.resumeOnStripe`) : t(`settings.settingsBilling.manageOnStripe`)"
                                :tier="cancelling ? `loud` : `boring`"
                                :loading="working"
                                @click="open(`portal`)"
                            />
                        </template>
                    </BillingStatusCard>

                    <!-- Lapsed: a subscriber whose card stopped working; one thing to do, no sales pitch. -->
                    <BillingStatusCard
                        v-else-if="lapsed"
                        tone="warning"
                        icon="credit-card"
                        :title="t(`settings.settingsBilling.planNeedsWorkingCard`)"
                        :detail="t(`settings.settingsBilling.paymentFailedFreeHours`)"
                    >
                        <p class="mt-1 text-2xs text-subtle">{{ t(`settings.settingsBilling.stripeReportsPlan`, { lapsed }) }}</p>
                        <template #actions>
                            <Button :label="t(`settings.settingsBilling.updatePaymentOnStripe`)" :loading="working" tier="loud" @click="open(`portal`)" />
                        </template>
                    </BillingStatusCard>

                    <!-- Activating: the webhook's few seconds, owned by the app instead of handed back to the payer. -->
                    <BillingStatusCard
                        v-else-if="justJoined && waiting"
                        tone="info"
                        icon="spinner"
                        spin
                        :title="t(`settings.settingsBilling.paymentReceivedActivatingPlan`)"
                        :detail="t(`settings.settingsBilling.activating`)"
                    />

                    <!-- Checkout, open in the reader's browser: this replaces the offer rather than sitting beside it, since a
                         second press here would be a second subscription on one account. -->
                    <BillingStatusCard
                        v-else-if="away === `checkout`"
                        tone="info"
                        icon="external-link"
                        :title="t(`settings.settingsBilling.checkoutOpenInBrowser`)"
                        :detail="t(`settings.settingsBilling.finishPayingThereNothing`)"
                    >
                        <!-- Says the page is watching, rather than offering a press that would only start the read already
                             running. Coming back to this window re-arms it either way. -->
                        <p class="mt-2 flex items-center gap-2 text-2xs text-muted">
                            <Icon name="spinner" spin class="text-info" />
                            {{ t(`settings.settingsBilling.waitingForStripe`) }}
                        </p>
                        <template #actions>
                            <Button :label="t(`settings.settingsBilling.didntPayAfterAll`)" tier="quiet" @click="dropAway" />
                        </template>
                    </BillingStatusCard>

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
                        <HostedPlanOffer :ladder="ladder" :current-tier="currentTier" :opening="opening" @checkout="(tier) => open(`checkout`, tier)" />
                    </template>

                    <!-- The one state where cancelling is the advice, not the door. -->
                    <BillingStatusCard
                        v-if="planWithoutMachine"
                        tone="warning"
                        icon="exclamation-circle"
                        :title="t(`settings.settingsBilling.planCoversHostedSandbox`)"
                        :detail="t(`settings.settingsBilling.payingMachineIsntStart`)"
                    >
                        <template #actions>
                            <Button :as="RouterLink" :to="HOSTED_SETUP" :label="t(`settings.settingsBilling.startHostedSandbox`)" tier="loud" />
                            <Button :label="t(`settings.settingsBilling.cancelOnStripe`)" tier="quiet" :loading="working" @click="open(`portal`)" />
                        </template>
                    </BillingStatusCard>

                    <!-- 2. WHAT IS RUNNING: each hosted sandbox beside the hours it spends, the only place hours are stated. -->
                    <section v-if="hosted && (machines.length > 0 || (plan.onPlan && !planWithoutMachine))" class="flex flex-col gap-3">
                        <div class="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                            <h2 class="flex items-center gap-2 text-sm font-semibold text-content">
                                <Icon name="cloud" class="text-base text-subtle" />
                                {{ t(`settings.settingsBilling.hostedSandboxes`) }}
                            </h2>
                            <!-- Said once, beside the list, because it is the question a limit raises first: what is counted,
                                 and that a sandbox on the reader's own computer never is. -->
                            <p v-if="resetsOn" class="text-2xs text-subtle">{{ t(`settings.settingsBilling.hoursReset`, { resetsOn }) }}</p>
                        </div>
                        <ul v-if="machines.length > 0" class="divide-y divide-line overflow-hidden rounded-xl border border-line bg-card">
                            <HostedMachineRow
                                v-for="machine in machines"
                                :key="machine.sandboxId"
                                :machine="machine"
                                :hours="hoursOf(machine)"
                                :rung-name="rungName(machine.tier)"
                                :targets="targetsOf(machine)"
                                :moving="moving === machine.sandboxId"
                                :move-progress="moving === machine.sandboxId ? moveWait : undefined"
                                :move-lines="move.lines.value"
                                @move="(tier) => moveTo(machine.sandboxId, tier)"
                            />
                        </ul>
                        <div v-else class="flex flex-col items-start gap-3 rounded-xl border border-dashed border-line p-5 @lg:flex-row @lg:items-center">
                            <span class="flex size-9 shrink-0 items-center justify-center rounded-lg bg-content/[0.07] text-accent"><Icon name="server" /></span>
                            <p class="min-w-0 flex-1 text-xs text-muted">{{ t(`settings.settingsBilling.noneYet`) }}</p>
                            <Button :as="RouterLink" :to="HOSTED_SETUP" :label="t(`settings.settingsBilling.startHostedSandbox`)" size="small" tier="boring" />
                        </div>
                        <p v-if="moveError" class="text-2xs text-danger">{{ moveError }}</p>
                    </section>

                    <!-- 3. WHAT A SUBSCRIBER CAN ADD: the same cards as the offer, with slots in place of a checkout. -->
                    <section v-if="hosted && paying && paidRungs.length > 0" class="flex flex-col gap-3">
                        <div class="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                            <h2 class="flex items-center gap-2 text-sm font-semibold text-content">
                                <Icon name="boxes" class="text-base text-subtle" />
                                {{ t(`settings.settingsBilling.theMachines`) }}
                            </h2>
                            <p class="text-2xs text-subtle">{{ t(`settings.settingsBilling.chargedRestMonthStripe`) }}</p>
                        </div>
                        <div class="grid grid-cols-1 items-stretch gap-4 @xl:grid-cols-2">
                            <HostedTierCard v-for="rung in paidRungs" :key="rung.id" :rung="{ ...rung, recommended: false }" :max-hours="maxHours">
                                <template #action>
                                    <p class="text-center text-2xs text-subtle">
                                        {{ rung.held === 0 ? t(`settings.settingsBilling.noSlotsYet`) : t(`settings.settingsBilling.slotsHeld`, { held: rung.held, standing: rung.standing }) }}
                                    </p>
                                    <div class="flex gap-2">
                                        <Button
                                            v-if="rung.onSale"
                                            :label="t(`settings.settingsBilling.addSlotAt`, { price: rung.priceUsd })"
                                            size="small"
                                            tier="boring"
                                            class="flex-1"
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
                                </template>
                            </HostedTierCard>
                        </div>
                        <p v-if="slotsError" class="text-2xs text-danger">{{ slotsError }}</p>
                    </section>

                    <!-- 4. THE FINE PRINT, as the questions people ask, folded until asked. -->
                    <HostedPlanFaq :free-hours="hosted?.freeTier.monthlyHours ?? ladder.find((rung) => rung.free)?.hours ?? 0" />
                </div>
            </template>
        </Await>

        <Notice v-if="errandFailure" :of="errandFailure" />
    </div>
</template>
