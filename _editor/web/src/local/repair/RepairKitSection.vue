<script setup lang="ts">
import { SegmentedControl } from "@intentic/ui";
import { ref, shallowRef, watch } from "vue";
import LocalRepair from "./LocalRepair.vue";
import { type RepairFixtureName, repairFixture } from "./repairFixtures";

const NAMES: readonly RepairFixtureName[] = [
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
        <SegmentedControl v-model="picked" :options="NAMES.map((name) => ({ value: name, label: name }))" />
        <div class="rounded border border-line bg-canvas">
            <LocalRepair :key="picked" :repair="host" />
        </div>
    </section>
</template>
