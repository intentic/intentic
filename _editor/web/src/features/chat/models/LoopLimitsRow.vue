<!-- What the pick's loop cannot do, straight off its declared record: one row (label-left/hint-right), the list behind a hover card, and the offered loop that lifts them all where there is one. -->
<script setup lang="ts">
import { computed } from "vue";
import { type AgentHarness, type AgentProvider, loopLabel } from "@intentic/sandbox-contract";
import { InfoHint } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { liftingLoop, limitationsOn, offeredLoops } from "./offeredLoops";

const t = useT();

const { provider, harness } = defineProps<{ provider: AgentProvider; harness: AgentHarness }>();

const limitations = computed(() => limitationsOn(provider, offeredLoops(provider), harness));
const lifting = computed(() => liftingLoop(provider, offeredLoops(provider), harness));
</script>

<template>
    <!-- Empty (the Claude Code loop, the ceiling) draws nothing. -->
    <div v-if="limitations.length > 0" class="flex items-center justify-between gap-2">
        <span class="text-2xs font-medium uppercase tracking-wide text-muted">{{ t(`chat.words.notAvailableHere`) }}</span>
        <InfoHint :label="t(`chat.words.whatIsntAvailableHere`)" :text="`${limitations.length}`" class="shrink-0">
            <!-- States its own heading, since the card teleports to the tooltip tier and may land clear of the row that raised it. -->
            <span class="block text-xs font-medium text-content">{{ t(`chat.words.notAvailableHere`) }}</span>
            <ul class="mt-1 flex flex-col gap-1 text-xs">
                <li v-for="limit in limitations" :key="limit" class="flex items-start gap-1.5">
                    <span class="mt-[0.4rem] h-1 w-1 shrink-0 rounded-full bg-line-strong" aria-hidden="true"></span>
                    <span class="text-muted">{{ limit }}</span>
                </li>
            </ul>
            <span v-if="lifting !== undefined" class="mt-2 block text-xs text-content">{{
                t(`chat.words.liftThroughLoop`, { loop: loopLabel(provider, lifting) })
            }}</span>
        </InfoHint>
    </div>
</template>
