<!-- A form field's explanation, kept behind an (i) beside its label: a form shows what to answer, the why is there on hover. -->
<script setup lang="ts">
import { InfoHint } from "@intentic/ui";

defineProps<{ label: string; text: string }>();
</script>

<template>
    <!-- `.prevent`: inside a <label>, a tap on the (i) would otherwise flip the switch or focus the box it labels. -->
    <span class="ml-1.5 inline-flex align-middle normal-case tracking-normal" @click.prevent>
        <InfoHint :label="label">
            <span class="block text-xs text-content">{{ text }}</span>
        </InfoHint>
    </span>
</template>
