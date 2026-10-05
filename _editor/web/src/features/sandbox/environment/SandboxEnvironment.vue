<script setup lang="ts">
import { SkeletonSnapshot, ui, vSkeletonSource } from "@intentic/ui";
import { computed } from "vue";
import { useEnvironment } from "./useEnvironment";
import { useSandboxOutline } from "../overview/useSandboxOutline";
import EnginesCard from "./EnginesCard.vue";
import EnvironmentCard from "./EnvironmentCard.vue";
import ExportCard from "../access/ExportCard.vue";
import ImportCard from "../access/ImportCard.vue";
import { useT } from "@intentic/ui/i18n";

// The Sandbox hub's Environment tab: what this sandbox is (overlay, engines), then moving it. Moving is split by
// direction (out/in), not by artifact, since each artifact is a choice inside a direction rather than its own card.
// The overlay sits above both, since a bundle's last step is the rebuild it hands you.

const t = useT();

const { proposal, pending, applied, query } = useEnvironment();
const empty = computed(() => !proposal.value && !pending.value && !applied.value);

// Without `reading`, an unread sandbox flashes the empty-state sentence before its real overlay loads, since all three
// computeds read off one initially-undefined state. The card draws nothing until that state is read, so the outline
// takes its place: drawn as the card (or the empty-state sentence) last looked in this sandbox, and as a card's shape
// before either has been seen.
const reading = query.isLoading;
const outline = useSandboxOutline(reading);
</script>

<template>
    <div class="flex flex-col gap-6">
        <EnvironmentCard v-skeleton-source="`sandbox.environment.overlay`" />

        <SkeletonSnapshot v-if="outline" of="sandbox.environment.overlay" :label="t(`sandbox.sandboxEnvironment.readingSandboxsEnvironment`)">
            <div role="status" aria-busy="true" class="flex flex-col gap-3 rounded-lg bg-card shadow-sm p-4">
                <span class="sr-only">{{ t(`sandbox.sandboxEnvironment.readingSandboxsEnvironment`) }}</span>
                <span class="skeleton block h-3.5 w-44" aria-hidden="true" />
                <div class="flex flex-col gap-2" aria-hidden="true">
                    <span v-for="(width, index) in [`w-3/4`, `w-1/2`, `w-5/6`, `w-2/5`]" :key="index" class="skeleton block h-2.5" :class="width" />
                </div>
            </div>
        </SkeletonSnapshot>
        <!-- `!reading`, not `!outline`: the sentence must stay silent through the pre-outline delay too. -->
        <div v-else-if="empty && !reading" v-skeleton-source="`sandbox.environment.overlay`" :class="ui.emptyState('py-10')">
            {{ t(`sandbox.sandboxEnvironment.noEnvironmentChangesYet`) }}
        </div>

        <!-- The environment row sits below the overlay and separates installed from available states. -->
        <EnginesCard />

        <!-- Out is drawn first: that's the one an owner reaches for while still holding this sandbox. -->
        <ExportCard />
        <ImportCard />
    </div>
</template>
