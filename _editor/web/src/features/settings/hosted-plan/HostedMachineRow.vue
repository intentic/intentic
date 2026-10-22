<script setup lang="ts">
import type { HostedPlanMachine } from "@intentic/api-contract";
import { Button, Icon } from "@intentic/ui";
import { timeAgo } from "@intentic/ui/format";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import HostedHoursMeter from "./HostedHoursMeter.vue";
import { machineWords } from "./machineWords";
import type { Rung } from "./planLadder";
import type { MachineHours } from "../../../models/hosted-plan/hostedHours";
import ProgressMeter from "../../../components/progress/ProgressMeter.vue";
import type { Progress } from "../../../components/progress/progress";

// One hosted sandbox: its name and rung, awake or asleep, its hours as a bar, and the rungs it can move to right now.
// Only moves that would work are offered, so the row never shows a set of greyed-out buttons to decode.

const t = useT();

const props = defineProps<{
    machine: HostedPlanMachine;
    hours: MachineHours;
    rungName: string;
    // Rungs with a free slot this machine could move onto now.
    targets: readonly Rung[];
    moving: boolean;
    moveProgress?: Progress | undefined;
    moveLines?: readonly string[];
}>();

const emit = defineEmits<{ move: [tier: string] }>();

const awake = computed(() => props.machine.wokeAt !== null);
const stateWords = computed(() =>
    props.machine.wokeAt === null
        ? t(`settings.settingsBilling.machineAsleep`)
        : t(`settings.settingsBilling.machineAwakeSince`, { ago: timeAgo(new Date(props.machine.wokeAt).getTime()) }),
);
</script>

<template>
    <li class="flex flex-col gap-3 p-4 @xl:flex-row @xl:items-start @xl:gap-5">
        <div class="flex min-w-0 flex-1 items-start gap-3">
            <span class="flex size-9 shrink-0 items-center justify-center rounded-lg bg-content/[0.07] text-accent">
                <Icon name="server" />
            </span>
            <div class="flex min-w-0 flex-1 flex-col gap-1">
                <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span class="min-w-0 truncate text-sm font-semibold text-content">{{ props.machine.name }}</span>
                    <span class="rounded-full bg-content/[0.07] px-2 py-0.5 text-2xs font-medium text-muted">{{ props.rungName }}</span>
                    <span class="inline-flex items-center gap-1.5 text-2xs text-subtle">
                        <span class="size-1.5 rounded-full" :class="awake ? `bg-success` : `bg-content/30`" aria-hidden="true" />
                        {{ stateWords }}
                    </span>
                </div>
                <span class="text-2xs text-subtle">{{ machineWords(props.machine.shape) }} · {{ props.machine.region }}</span>
                <span v-if="props.machine.oomsThisWeek > 0" class="inline-flex items-center gap-1.5 text-2xs text-warning">
                    <Icon name="exclamation-circle" class="text-xs" />
                    {{
                        t(
                            `settings.settingsBilling.ranOutOfMemory`,
                            { count: props.machine.oomsThisWeek, memory: props.machine.shape.memoryMb / 1024 },
                            props.machine.oomsThisWeek,
                        )
                    }}
                </span>
                <ProgressMeter
                    v-if="props.moving && props.moveProgress"
                    :progress="props.moveProgress"
                    :what="t(`settings.settingsBilling.movingNote`)"
                    :details="props.moveLines"
                    class="mt-1 max-w-sm"
                />
            </div>
        </div>
        <div class="flex w-full flex-col gap-2 @xl:w-64 @xl:shrink-0">
            <HostedHoursMeter :hours="props.hours" grow />
            <div v-if="props.targets.length > 0" class="flex flex-wrap gap-1.5">
                <Button
                    v-for="rung in props.targets"
                    :key="rung.id"
                    :label="t(`settings.settingsBilling.moveToRung`, { name: rung.name })"
                    size="small"
                    tier="quiet"
                    :loading="props.moving"
                    @click="emit(`move`, rung.id)"
                />
            </div>
        </div>
    </li>
</template>
