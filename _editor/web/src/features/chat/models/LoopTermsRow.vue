<!-- The vendor's own terms for the loop a pick runs on, said quietly: a muted row and a hover card, never a banner. The owner keeps these routes by choice; the row exists so nobody runs one without being able to find out. -->
<script setup lang="ts">
import type { LoopTerms } from "@intentic/sandbox-contract/models/provider-specs";
import { useT } from "@intentic/ui/i18n";
import LoopTermsHint from "./LoopTermsHint.vue";

const { terms } = defineProps<{ terms: LoopTerms }>();
const t = useT();
</script>

<template>
    <!-- One row, label-left/hint-right, like the runtime's own limits beside it. -->
    <div class="flex items-center justify-between gap-2">
        <span class="text-2xs font-medium uppercase tracking-wide text-muted">{{ t(`chat.words.vendorTerms`) }}</span>
        <LoopTermsHint :terms="terms" />
    </div>
</template>
