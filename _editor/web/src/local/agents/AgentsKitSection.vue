<script setup lang="ts">
import { SegmentedControl } from "@intentic/ui";
import { ref, shallowRef, watch } from "vue";
import LocalAgents from "./LocalAgents.vue";
import { type AgentsFixtureName, onboardingFixture } from "./onboardingFixtures";

const NAMES: readonly AgentsFixtureName[] = [
    `needsSetup`,
    `pcReady`,
    `prefetch`,
    `settingUp`,
    `needsYou`,
    `restart`,
    `restartScheduled`,
    `admin`,
    `signOut`,
    `setupFailed`,
    `cantRun`,
    `sandboxReady`,
];

const picked = ref<AgentsFixtureName>(`needsSetup`);
// shallowRef: a deep ref would unwrap the fixture's own refs, and the view reads them as refs (`check.value`).
const host = shallowRef(onboardingFixture(picked.value));

watch(picked, (name) => {
    host.value = onboardingFixture(name);
});
</script>

<template>
    <section class="space-y-3 rounded-lg border border-line p-4">
        <h2 class="text-sm font-semibold text-content">Local · Agents (first run)</h2>
        <SegmentedControl v-model="picked" :options="NAMES.map((name) => ({ value: name, label: name }))" />
        <div class="rounded border border-line bg-canvas">
            <LocalAgents
                :key="picked"
                :onboarding="host"
                :sandbox-ready="picked === `sandboxReady`"
                :repair-available="picked === `setupFailed`"
            />
        </div>
    </section>
</template>
