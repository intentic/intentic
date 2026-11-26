<!-- THE THREE PLANS SIDE BY SIDE, as one table: what each costs, the machine it buys, its awake hours (and what that is
     in a working day), and whether a sandbox on it is kept. Every figure is the ladder's (planLadder.ts). For an account
     with nothing to change yet (no cloud sandbox, nothing paid) the table ends in the ways in: Start free, and each paid
     plan's checkout, the cheapest on sale bright. Everyone else changes a plan from its sandbox's row above. -->
<script setup lang="ts">
import { Button } from "@intentic/ui";
import { formatCount } from "@intentic/ui/format";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { RouterLink } from "vue-router";
import { newSandboxLink } from "../../../models/sandbox/addSandbox";
import { hoursPerWorkday, type Rung } from "./planLadder";

const { ladder, ways = false, opening = undefined } = defineProps<{
    ladder: readonly Rung[];
    /** The ways in under each plan: for an account with nothing to change yet. */
    ways?: boolean;
    /** The paid plan whose checkout is being opened, so only its button waits. */
    opening?: string | undefined;
}>();
const emit = defineEmits<{ get: [tier: string] }>();

const t = useT();
const HOSTED_SETUP = newSandboxLink(`hosted`);

const rows = computed(() => [
    { label: t(`settings.plans.compare.price`), cells: ladder.map((rung) => (rung.free ? t(`settings.plans.priceFree`) : t(`settings.plans.perMonth`, { price: rung.priceUsd }))) },
    { label: t(`settings.plans.diff.cpu`), cells: ladder.map((rung) => String(rung.machine.cpus)) },
    { label: t(`settings.plans.diff.memory`), cells: ladder.map((rung) => t(`settings.plans.gb`, { gb: formatCount(rung.machine.memoryMb / 1024) })) },
    { label: t(`settings.plans.diff.disk`), cells: ladder.map((rung) => t(`settings.plans.gb`, { gb: rung.machine.volumeGb })) },
    { label: t(`settings.plans.diff.hours`), cells: ladder.map((rung) => t(`settings.plans.hoursMonth`, { hours: rung.hours })) },
    { label: ``, cells: ladder.map((rung) => t(`settings.plans.compare.perWorkday`, { hours: hoursPerWorkday(rung.hours) })), quiet: true },
    { label: t(`settings.plans.diff.kept`), cells: ladder.map((rung) => (rung.free ? t(`settings.plans.compare.keptFree`) : t(`settings.plans.compare.keptPaid`))) },
]);
</script>

<template>
    <div class="-mx-1 overflow-x-auto" data-plan-compare>
        <table class="w-full min-w-[20rem] border-collapse text-xs">
            <thead>
                <tr>
                    <th class="w-1/4 px-1 pb-2 text-left font-normal text-muted"><span class="sr-only">{{ t(`settings.plans.choiceLabel`) }}</span></th>
                    <th v-for="rung in ladder" :key="rung.id" scope="col" class="px-1 pb-2 text-left text-sm font-semibold text-content">{{ rung.name }}</th>
                </tr>
            </thead>
            <tbody>
                <tr v-for="row in rows" :key="row.label + (row.quiet ? `-quiet` : ``)" :class="row.quiet ? `` : `border-t border-line-subtle`">
                    <th scope="row" class="px-1 py-1.5 text-left font-normal text-muted">{{ row.label }}</th>
                    <td v-for="(cell, index) in row.cells" :key="index" class="px-1 py-1.5 tabular-nums" :class="row.quiet ? `pt-0 text-2xs text-subtle` : `text-content`">
                        {{ cell }}
                    </td>
                </tr>
                <tr v-if="ways">
                    <td />
                    <td v-for="rung in ladder" :key="rung.id" class="px-1 pt-3 align-top">
                        <Button v-if="rung.free" :as="RouterLink" :to="HOSTED_SETUP" size="small" tier="boring" :label="t(`settings.plans.compare.startFree`)" />
                        <Button
                            v-else-if="rung.onSale"
                            size="small"
                            :tier="rung.recommended ? `loud` : `boring`"
                            :label="t(`settings.plans.compare.get`, { name: rung.name })"
                            :loading="opening === rung.id"
                            :disabled="opening !== undefined && opening !== rung.id"
                            @click="emit(`get`, rung.id)"
                        />
                        <span v-else class="text-2xs text-subtle">{{ t(`settings.plans.compare.notSold`) }}</span>
                    </td>
                </tr>
            </tbody>
        </table>
    </div>
</template>
