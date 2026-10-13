<!-- The vendor's own terms for one loop behind an (i): the card the terms row and a loop chip both raise, so the two say it in the same words. -->
<script setup lang="ts">
import { computed } from "vue";
import type { LoopTerms } from "@intentic/sandbox-contract";
import { InfoHint } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";

const { terms } = defineProps<{ terms: LoopTerms }>();
const t = useT();

// The card takes no pointer events, so it cannot hold a link; it names the vendor's page instead, and the models doc
// links every one of them.
const page = computed(() => terms.source.replace(/^https:\/\//, ``).replace(/\/$/, ``));
</script>

<template>
    <InfoHint :label="t(`chat.words.whatTheVendorAllows`)" class="shrink-0">
        <!-- States its own heading, since the card teleports to the tooltip tier and may land clear of the row that raised it. -->
        <span class="block text-xs font-medium text-content">{{ t(`chat.words.vendorTerms`) }}</span>
        <span class="mt-1 block text-xs text-muted">{{ terms.note }}</span>
        <span class="mt-1 block break-all text-2xs text-subtle">{{ page }}</span>
    </InfoHint>
</template>
