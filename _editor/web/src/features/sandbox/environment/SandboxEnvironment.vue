<script setup lang="ts">
import { ui } from "@intentic/ui";
import { computed } from "vue";
import { useEnvironment } from "./useEnvironment";
import { useSandboxOutline } from "../overview/useSandboxOutline";
import EnginesCard from "./EnginesCard.vue";
import EnvironmentCard from "./EnvironmentCard.vue";
import MoveCard from "../access/MoveCard.vue";

// The Sandbox hub's Environment tab: what this sandbox is (overlay, engines), then moving it. The move cards are split
// by direction (out/in), not by artifact, since each artifact is a choice inside a direction rather than its own card.
// The overlay sits above MoveCard, since a bundle's last step is the rebuild it hands you.

const { proposal, pending, applied, query } = useEnvironment();
const empty = computed(() => !proposal.value && !pending.value && !applied.value);

// Without `reading`, an unread sandbox flashes the empty-state sentence before its real overlay loads, since all three
// computeds read off one initially-undefined state. The outline stands in for the card's shape, not the sentence.
const reading = query.isLoading;
const outline = useSandboxOutline(reading);
</script>

<template>
    <div class="flex flex-col gap-4">
        <EnvironmentCard />

        <div v-if="outline" role="status" aria-busy="true" class="flex flex-col gap-3 rounded-lg border border-line bg-card p-4">
            <span class="sr-only">Reading this sandbox's environment…</span>
            <span class="skeleton block h-3.5 w-44" aria-hidden="true" />
            <div class="flex flex-col gap-2" aria-hidden="true">
                <span v-for="(width, index) in [`w-3/4`, `w-1/2`, `w-5/6`, `w-2/5`]" :key="index" class="skeleton block h-2.5" :class="width" />
            </div>
        </div>
        <!-- `!reading`, not `!outline`: the sentence must stay silent through the pre-outline delay too. -->
        <div v-else-if="empty && !reading" :class="ui.emptyState('py-10')">
            No environment changes yet. When the agent proposes a change to the sandbox image's overlay, its diff appears here to review and rebuild.
        </div>

        <!--
            Sits one layer below the overlay (installed vs. which engine version) and above the bundle; never hidden, since every sandbox has engines
            worth checking.
        -->
        <EnginesCard />

        <!-- One card, both directions: out is drawn first, since that's the one an owner reaches for while still holding this sandbox. -->
        <MoveCard />
    </div>
</template>
