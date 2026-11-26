<!-- A CLOUD SANDBOX'S PLAN, for its owner, on the sandbox's own pages (Overview; Usage, as its hours): what plan it is
     on and what that costs, the machine that buys, its awake hours and when they come back, and whatever is true of the
     plan now. Running out of memory names the plan with more; a downgrade waiting says when, with Keep; a plan that ended
     offers renewing it; an upgrade under way shows its restart step by step; one that did not finish says why, with Try
     again. Its press is "Change plan", quiet, except where Free is pinching (hours nearly gone, or out of memory): then the
     next plan up, bright, with its price. Every change goes through the one dialog (PlanDialog.vue). -->
<script setup lang="ts">
import { Button, Card, Notice, toneFill } from "@intentic/ui";
import { formatCount } from "@intentic/ui/format";
import { useT } from "@intentic/ui/i18n";
import { computed, ref } from "vue";
import { RouterLink } from "vue-router";
import { formatDayShort, machineHours } from "../../../models/hosted-plan/hostedHours";
import { planMove } from "../../../models/hosted-plan/planMoves";
import { useHostedPlan } from "../../../models/hosted-plan/useHostedPlan";
import { here, page } from "../../../lib/routes/links";
import { useOperation } from "../../../workbench/operations/operations";
import HostedHoursMeter from "./HostedHoursMeter.vue";
import { machineWords } from "./machineWords";
import { cardLead, planLapsed } from "./planChange";
import PlanDialog from "./PlanDialog.vue";
import { planLadder, rungOf, sizeOf } from "./planLadder";
import PlanMoveSteps from "./PlanMoveSteps.vue";

const { sandboxId } = defineProps<{ sandboxId: string }>();

const t = useT();
const { state, offered, changePlan } = useHostedPlan();
const ladder = computed(() => planLadder(state.value));
const machine = computed(() => state.value?.hosted?.machines.find((row) => row.sandboxId === sandboxId));
// Read again with every plan state, which the query re-reads every few seconds while a restart runs.
const now = computed(() => (state.value === undefined ? 0 : Date.now()));
const plan = computed(() => (machine.value === undefined ? undefined : rungOf(ladder.value, machine.value.tier)));
const move = computed(() => (machine.value === undefined ? undefined : planMove(machine.value, now.value)));
const lead = computed(() => (machine.value === undefined ? undefined : cardLead({ ladder: ladder.value, machine: machine.value, now: now.value })));
const lapsed = computed(() => machine.value !== undefined && planLapsed(machine.value, ladder.value));
const comped = computed(() => state.value?.comped === true);
const hours = computed(() => (machine.value === undefined ? undefined : machineHours(state.value, machine.value)));
const resetsOn = computed(() => (machine.value === undefined ? undefined : formatDayShort(machine.value.hours.resetsAt)));

// "Standard · $20/month", "Free", "Max · on the house".
const priceWords = computed(() => {
    const rung = plan.value;
    if (rung === undefined || rung.free) {
        return undefined;
    }
    return comped.value ? t(`settings.plans.onTheHouse`) : t(`settings.plans.perMonthLong`, { price: rung.priceUsd });
});
// The plan with more memory than this one, named where the machine ran out of it.
const roomier = computed(() => {
    const box = machine.value;
    return box === undefined ? undefined : ladder.value.find((rung) => rung.onSale && rung.machine.memoryMb > sizeOf(box).memoryMb);
});
const memoryLine = computed(() => {
    const box = machine.value;
    if (box === undefined || box.oomsThisWeek === 0) {
        return undefined;
    }
    const ran = t(`settings.plans.ranOutOfMemory`, { count: box.oomsThisWeek, memory: formatCount(sizeOf(box).memoryMb / 1024) }, box.oomsThisWeek);
    const bigger = roomier.value;
    return bigger === undefined ? ran : `${ran} ${t(`settings.plans.roomier`, { name: bigger.name, memory: formatCount(bigger.machine.memoryMb / 1024) })}`;
});

// The dialog, opened on the plan the press is about.
const dialogOpen = ref(false);
const dialogTier = ref<string>();
const openDialog = (tier?: string): void => {
    dialogTier.value = tier;
    dialogOpen.value = true;
};

// Keep and Try again change nothing on the bill, so they are pressed here rather than in the dialog.
const direct = useOperation<unknown>(() => `account/billing/plan/${sandboxId}`);
const press = async (tier: string): Promise<void> => {
    direct.dismiss();
    await direct.run({ what: t(`settings.plans.changing`, { name: machine.value?.name ?? `` }), failed: t(`settings.plans.couldntChange`), quiet: true, task: () => changePlan(sandboxId, tier) });
};
const failure = computed(() => direct.failure.value);
</script>

<template>
    <Card v-if="machine && plan && move && lead" class="flex flex-col gap-3" data-plan-card>
        <div class="flex items-start justify-between gap-3">
            <div class="flex min-w-0 flex-col">
                <span class="text-xs text-muted">{{ t(`settings.plans.cardLabel`) }}</span>
                <h3 class="text-base font-semibold text-content">
                    <template v-if="move.kind === `moving`">{{ plan.name }} → {{ rungOf(ladder, move.tier).name }}</template>
                    <template v-else>{{ plan.name }}</template>
                    <span v-if="priceWords && move.kind !== `moving`" class="text-sm font-normal text-muted"> · {{ priceWords }}</span>
                </h3>
            </div>
            <RouterLink v-if="offered" :to="here(page.account(`billing`))" class="shrink-0 text-xs text-link hover:underline">{{ t(`settings.plans.billing`) }}</RouterLink>
        </div>

        <!-- The restart onto a new plan, in its steps, in place of everything the plan says while settled. -->
        <PlanMoveSteps v-if="move.kind === `moving`" :move="move" :from="plan.id" :comped="comped" :name="machine.name" />

        <template v-else>
            <p class="text-xs text-muted">
                {{ machineWords(sizeOf(machine)) }}<template v-if="plan.free"> · {{ t(`settings.plans.keptFree`) }}</template>
            </p>
            <div v-if="hours" class="flex flex-col gap-1">
                <HostedHoursMeter :hours="hours" grow />
                <p v-if="resetsOn && hours.meter" class="text-2xs text-subtle">{{ t(`settings.plans.hoursBack`, { day: resetsOn }) }}</p>
            </div>

            <p v-if="memoryLine" class="rounded-lg px-3 py-2 text-xs text-content" :class="toneFill(`warning`, `strong`)" data-plan-memory>{{ memoryLine }}</p>

            <div v-if="move.kind === `scheduled`" class="flex flex-wrap items-center justify-between gap-2" data-plan-scheduled>
                <p class="text-xs text-content">
                    {{ t(`settings.plans.scheduledLine`, { name: rungOf(ladder, move.tier).name, date: formatDayShort(move.at), current: plan.name }) }}
                </p>
                <Button size="small" tier="boring" :label="t(`settings.plans.act.keep`, { name: plan.name })" :loading="direct.busy.value" @click="press(plan.id)" />
            </div>

            <p v-if="move.kind === `waiting`" class="text-xs text-content">{{ t(`settings.plans.waitingLine`, { name: rungOf(ladder, move.tier).name }) }}</p>

            <p v-if="lapsed" class="rounded-lg px-3 py-2 text-xs text-content" :class="toneFill(`warning`, `strong`)">
                {{ t(`settings.plans.lapsedLine`, { name: plan.name }) }}
            </p>

            <div v-if="move.kind === `failed`" class="flex flex-col items-start gap-2 rounded-lg px-3 py-2" :class="toneFill(`danger`, `strong`)" data-plan-failed>
                <p class="text-xs text-content">
                    {{ move.error ? t(`settings.plans.failedLine`, { error: move.error }) : t(`settings.plans.failedBare`) }}
                </p>
                <Button size="small" tier="accent" :label="t(`settings.plans.act.retry`)" :loading="direct.busy.value" @click="press(move.tier)" />
            </div>

            <Notice v-if="failure" :of="failure" />

            <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
                <Button
                    v-if="lead.kind === `upgrade`"
                    tier="loud"
                    :label="t(`settings.plans.upgradeTo`, { name: lead.to.name, price: lead.to.priceUsd })"
                    data-plan-upgrade
                    @click="openDialog(lead.to.id)"
                />
                <Button
                    v-else-if="lead.kind === `renew`"
                    tier="loud"
                    :label="t(`settings.plans.act.renew`, { name: plan.name, price: plan.priceUsd })"
                    @click="openDialog(plan.id)"
                />
                <Button v-else-if="lead.kind !== `retry`" tier="boring" :label="t(`settings.plans.changePlan`)" data-plan-change @click="openDialog()" />
                <span v-if="lead.kind === `upgrade`" class="text-xs text-muted">{{ t(`settings.plans.orOwnComputer`) }}</span>
            </div>
        </template>

        <PlanDialog v-model:open="dialogOpen" :sandbox-id="sandboxId" :initial="dialogTier" />
    </Card>
</template>
