<script setup lang="ts">
import { Card, Icon } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { RouterLink } from "vue-router";
import HostedHoursMeter from "../../settings/hosted-plan/HostedHoursMeter.vue";
import { formatDayShort, machineHours, rungName } from "../../settings/hosted-plan/hostedHours";
import { useHostedPlan } from "../../settings/hosted-plan/useHostedPlan";
import { useSandbox } from "../client/useSandbox";

// WHETHER THIS SANDBOX'S AWAKE TIME COSTS HOURS, answered on the page about what the sandbox uses. A limit belongs
// beside the thing it limits: shown only at account level, it reads as a limit on every sandbox, and one on the
// owner's own computer spends none. So a sandbox on its owner's computer says it is never metered, a hosted one shows
// the hours it spends (the account's free ones, or its own month on a paid slot), and a guest on a hosted one is told
// whose hours those are. Nothing at all where the platform hosts nothing, since there is nothing metered to speak of.

const t = useT();
const { active } = useSandbox();
const { state: plan, offered } = useHostedPlan();

// The platform runs machines at all: its plan state carries a hosted half only where it does.
const lane = computed(() => plan.value?.hosted !== undefined);
const onOurMachine = computed(() => (active.value?.hosted ?? null) !== null);
const owner = computed(() => active.value?.role === `owner`);
const machine = computed(() => plan.value?.hosted?.machines.find((row) => row.sandboxId === active.value?.id));
const hours = computed(() => (machine.value === undefined ? undefined : machineHours(plan.value, machine.value)));

// What these hours are and when they come back, in the one sentence the bar cannot say.
const note = computed(() => {
    const current = machine.value;
    if (current === undefined) {
        return undefined;
    }
    if (current.hours.allowanceMinutes === null) {
        return plan.value?.comped === true ? t(`sandbox.sandboxHours.onTheHouseNote`) : t(`sandbox.sandboxHours.noLimitNote`);
    }
    const day = formatDayShort(current.hours.resetsAt);
    return current.hours.kind === `slot`
        ? t(`sandbox.sandboxHours.slotNote`, { name: rungName(current.tier), day })
        : t(`sandbox.sandboxHours.freeNote`, { day });
});
</script>

<template>
    <template v-if="lane">
        <!-- On the owner's own computer: the question a limit anywhere else raises, answered where it is asked. Drawn
             like the charges banner above it, since it is the same kind of statement: what intentic never counts. -->
        <div v-if="!onOurMachine" class="flex items-center gap-3 rounded-xl bg-card shadow-sm px-4 py-3">
            <span class="grid size-10 shrink-0 place-items-center rounded-xl bg-content/5 text-muted" aria-hidden="true">
                <Icon name="desktop" class="text-xl" />
            </span>
            <div class="min-w-0">
                <p class="text-xs font-medium leading-relaxed text-content">{{ t(`sandbox.sandboxHours.ownComputer`) }}</p>
                <p class="mt-0.5 text-xs leading-relaxed text-muted">{{ t(`sandbox.sandboxHours.ownComputerNeverMetered`) }}</p>
            </div>
        </div>

        <!-- Hosted, read by its owner: the hours this machine spends, as Billing draws them. -->
        <Card v-else-if="owner && hours" class="flex flex-col gap-3">
            <div class="flex items-center justify-between gap-3">
                <span class="flex items-center gap-2 text-sm font-semibold text-content">
                    <Icon name="clock" class="text-link" aria-hidden="true" />{{ t(`sandbox.sandboxHours.awakeHours`) }}
                </span>
                <RouterLink v-if="offered" to="/settings/billing" class="text-xs text-link hover:underline">{{
                    t(`sandbox.sandboxHours.billing`)
                }}</RouterLink>
            </div>
            <HostedHoursMeter :hours="hours" grow />
            <p v-if="note" class="text-2xs text-subtle">{{ note }}</p>
        </Card>

        <!-- Hosted, read by a guest: the hours are the owner's to spend and to buy, never the reader's. -->
        <div v-else-if="!owner" class="flex items-center gap-3 rounded-xl bg-card shadow-sm px-4 py-3">
            <span class="grid size-10 shrink-0 place-items-center rounded-xl bg-content/5 text-muted" aria-hidden="true">
                <Icon name="server" class="text-xl" />
            </span>
            <div class="min-w-0">
                <p class="text-xs font-medium leading-relaxed text-content">{{ t(`sandbox.sandboxHours.hostedForOwner`) }}</p>
                <p class="mt-0.5 text-xs leading-relaxed text-muted">{{ t(`sandbox.sandboxHours.ownersHours`) }}</p>
            </div>
        </div>
    </template>
</template>
