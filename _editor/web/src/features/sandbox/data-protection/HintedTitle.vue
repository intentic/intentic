<script setup lang="ts">
import { InfoHint } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";

// A row's name with its explanation behind an (i) beside it, for the data protection page's lists: the name is what a
// reader scans, and what the protection does, which data a place receives or what a document holds is there on hover
// or focus for whoever asks. Inline, so a long name wraps and the (i) follows its last word.
const { title } = defineProps<{ title: string }>();

const t = useT();
</script>

<template>
    <span>
        {{ title }}
        <InfoHint class="ml-1 align-[-0.125em]" :label="t(`sandbox.dataProtection.about`, { name: title })">
            <span class="block text-xs text-content"><slot /></span>
        </InfoHint>
    </span>
</template>
