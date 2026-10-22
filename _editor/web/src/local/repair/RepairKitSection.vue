<script setup lang="ts">
import { SegmentedControl } from "@intentic/ui";
import { ref, shallowRef, watch } from "vue";
import LocalRepair from "./LocalRepair.vue";
import { type RepairFixtureName, repairFixture } from "./repairFixtures";

const NAMES: readonly RepairFixtureName[] = [
    `empty`,
    `checking`,
    `healthy`,
    `findings`,
    `thinking`,
    `needsApproval`,
    `done`,
    `failed`,
    `signedOut`,
    `offline`,
    `allowanceUsed`,
];

const picked = ref<RepairFixtureName>(`findings`);
// shallowRef: a deep ref would unwrap the fixture's own refs, and the view reads them as refs (`session.value`).
const host = shallowRef(repairFixture(picked.value));

watch(picked, (name) => {
    host.value = repairFixture(name);
});
</script>

<template>
    <section class="space-y-3 rounded-lg border border-line p-4">
        <h2 class="text-sm font-semibold text-content">Local · Repair</h2>
        <SegmentedControl v-model="picked" wrap :options="NAMES.map((name) => ({ value: name, label: name }))" />
        <!-- A window's height, as the shell gives the page one: the composer is pinned to its foot. -->
        <div class="h-184 overflow-hidden rounded border border-line bg-canvas">
            <LocalRepair :key="picked" :repair="host" />
        </div>
    </section>
</template>
