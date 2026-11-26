<!-- WHAT THE BILL IS MADE OF: each cloud sandbox as a row (its plan and any change waiting, its awake hours, what it costs
     a month) with one quiet press that opens the change dialog on what the row is about (Upgrade, Change, Keep Max, Try
     again); a paid plan no sandbox is on, asking where it goes; and one line for the sandboxes on the owner's own
     computers, which cost nothing and are never metered. What a plan is and how changing one works is the (i). -->
<script setup lang="ts">
import type { HostedPlanMachine, HostedPlanState } from "@intentic/api-contract";
import { Button, InfoHint, Row, RowGroup, RowNote } from "@intentic/ui";
import { formatElapsed } from "@intentic/ui/format";
import { useT } from "@intentic/ui/i18n";
import { computed, ref } from "vue";
import { useSandbox } from "../../../client/sandbox/useSandbox";
import { formatDayShort, hoursMeter } from "../../../models/hosted-plan/hostedHours";
import { planMove } from "../../../models/hosted-plan/planMoves";
import OpenSeatPrompt from "./OpenSeatPrompt.vue";
import { monthlyUsdOf, openingTier, planLapsed, rowActLabel } from "./planChange";
import PlanDialog from "./PlanDialog.vue";
import { type Rung, rungOf } from "./planLadder";

const { state, ladder } = defineProps<{ state: HostedPlanState; ladder: readonly Rung[] }>();

const t = useT();
const { sandboxes } = useSandbox();
const machines = computed(() => state.hosted?.machines ?? []);
const now = computed(() => (state.hosted === undefined ? 0 : Date.now()));
const comped = computed(() => state.comped === true);

// The sandboxes on the owner's own computers: the rest of the list, which the bill never touches.
const ownComputers = computed(
    () =>
        sandboxes.value.filter(
            (row) => row.tier === `owner` && (row.hosted ?? null) === null && (row.removedAt ?? null) === null && !machines.value.some((m) => m.sandboxId === row.id),
        ).length,
);

// Plans paid for that no sandbox is on, one prompt each.
const seats = computed(() =>
    Object.entries(state.hosted?.openSeats ?? {})
        .filter(([, count]) => count > 0)
        .map(([tier, count]) => ({ rung: rungOf(ladder, tier), count })),
);

const hoursWords = (machine: HostedPlanMachine): string | undefined => {
    const meter = hoursMeter(machine.hours);
    if (meter === undefined) {
        return undefined;
    }
    const left = formatElapsed(meter.remainingMinutes * 60, { largest: `hours` });
    const allowance = formatElapsed(meter.allowanceMinutes * 60, { largest: `hours` });
    return meter.remainingMinutes === 0 ? t(`settings.plans.row.hoursGone`) : t(`settings.plans.row.hoursLeft`, { left, allowance });
};

// The row's one line: its plan and where it is going, then its hours.
const describe = (machine: HostedPlanMachine): string => {
    const plan = rungOf(ladder, machine.tier);
    const move = planMove(machine, now.value);
    const parts: string[] = [];
    switch (move.kind) {
        case `scheduled`:
            parts.push(t(`settings.plans.row.scheduled`, { name: plan.name, to: rungOf(ladder, move.tier).name, date: formatDayShort(move.at) }));
            break;
        case `moving`:
            parts.push(t(`settings.plans.row.moving`, { name: plan.name, to: rungOf(ladder, move.tier).name }));
            break;
        case `failed`:
            parts.push(t(`settings.plans.row.failed`, { name: rungOf(ladder, move.tier).name }));
            break;
        default:
            parts.push(planLapsed(machine, ladder) ? t(`settings.plans.row.lapsed`, { name: plan.name }) : plan.name);
    }
    const hours = move.kind === `moving` ? undefined : hoursWords(machine);
    if (hours !== undefined) {
        parts.push(hours);
    }
    return parts.join(` · `);
};
const monthly = (machine: HostedPlanMachine): string =>
    comped.value ? t(`settings.plans.onTheHouse`) : t(`settings.plans.row.monthly`, { price: monthlyUsdOf(machine, ladder, now.value) });

const dialogFor = ref<string>();
const dialogTier = ref<string>();
const dialogOpen = computed({
    get: () => dialogFor.value !== undefined,
    set: (shown: boolean) => {
        if (!shown) {
            dialogFor.value = undefined;
        }
    },
});
const openDialog = (machine: HostedPlanMachine): void => {
    dialogTier.value = openingTier({ ladder, machine, now: Date.now() });
    dialogFor.value = machine.sandboxId;
};
</script>

<template>
    <RowGroup :label="t(`settings.plans.cloudSandboxes`)" data-bill-sandboxes>
        <template #info>
            <InfoHint :label="t(`settings.plans.aboutPlans`)" wide>
                <span class="flex flex-col gap-2 text-xs">
                    <span class="font-medium text-content">{{ t(`settings.plans.rules.what`) }}</span>
                    <span class="text-muted">{{ t(`settings.plans.rules.up`) }}</span>
                    <span class="text-muted">{{ t(`settings.plans.rules.down`) }}</span>
                    <span class="text-muted">{{ t(`settings.plans.rules.bill`) }}</span>
                </span>
            </InfoHint>
        </template>

        <RowNote v-for="seat in seats" :key="seat.rung.id" variant="block">
            <OpenSeatPrompt :rung="seat.rung" :count="seat.count" :machines="machines" :renews-at="state.renewsAt" />
        </RowNote>

        <div v-if="machines.length > 0" class="divide-y divide-line-subtle">
            <Row v-for="machine in machines" :key="machine.sandboxId" :title="machine.name" :description="describe(machine)" :data-bill-row="machine.sandboxId">
                <template #meta>
                    <span class="text-xs text-content tabular-nums">{{ monthly(machine) }}</span>
                </template>
                <template #control>
                    <Button
                        v-if="planMove(machine, now).kind !== `moving`"
                        size="small"
                        tier="quiet"
                        :label="rowActLabel({ ladder, machine, now })"
                        @click="openDialog(machine)"
                    />
                </template>
            </Row>
        </div>
        <RowNote v-else variant="empty">{{ t(`settings.plans.noCloud`) }}</RowNote>

        <RowNote v-if="ownComputers > 0">{{ t(`settings.plans.ownComputers`, { count: ownComputers }, ownComputers) }}</RowNote>

        <PlanDialog v-if="dialogFor" v-model:open="dialogOpen" :sandbox-id="dialogFor" :initial="dialogTier" />
    </RowGroup>
</template>
