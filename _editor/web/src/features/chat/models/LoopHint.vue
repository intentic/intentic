<!-- Everything the picked loop costs, behind one quiet ⓘ beside the harness it qualifies: how many things it cannot do here
     (the count is the only text on the toolbar), and on hover the list, the offered loop that lifts them all, and the
     vendor's own terms for it. One icon, one card, rather than a row or a word per caveat. -->
<script setup lang="ts">
import { computed } from "vue";
import type { AgentHarness, AgentProvider } from "@intentic/sandbox-contract/schemas/agent";
import { loopLabel, termsOf } from "@intentic/sandbox-contract/models/agent-catalog";
import { InfoHint } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { liftingLoop, limitationsOn, offeredLoops, selectedLoop } from "../../../models/providers/offeredLoops";

const t = useT();

const { provider, harness } = defineProps<{ provider: AgentProvider; harness: AgentHarness }>();

const limitations = computed(() => limitationsOn(provider, offeredLoops(provider), harness));
const lifting = computed(() => liftingLoop(provider, offeredLoops(provider), harness));
const terms = computed(() => termsOf(provider, selectedLoop(offeredLoops(provider), harness)));
// The card takes no pointer events, so it cannot hold a link; it names the vendor's page instead, and the models doc
// links every one of them.
const page = computed(() => terms.value?.source.replace(/^https:\/\//, ``).replace(/\/$/, ``));
</script>

<template>
    <!-- Nothing to say (the Claude Code loop, the ceiling, on a vendor that sanctions it) draws nothing. -->
    <InfoHint
        v-if="limitations.length > 0 || terms !== undefined"
        :label="limitations.length > 0 ? t(`chat.words.whatIsntAvailableHere`) : t(`chat.words.whatTheVendorAllows`)"
        :text="limitations.length > 0 ? `${limitations.length}` : ``"
        class="shrink-0 text-2xs"
    >
        <!-- Each part states its own heading, since the card teleports to the tooltip tier and may land clear of the toolbar. -->
        <template v-if="limitations.length > 0">
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
        </template>
        <template v-if="terms !== undefined">
            <span class="block text-xs font-medium text-content" :class="{ 'mt-3': limitations.length > 0 }">{{ t(`chat.words.vendorTerms`) }}</span>
            <span class="mt-1 block text-xs text-muted">{{ terms.note }}</span>
            <span class="mt-1 block break-all text-2xs text-subtle">{{ page }}</span>
        </template>
    </InfoHint>
</template>
