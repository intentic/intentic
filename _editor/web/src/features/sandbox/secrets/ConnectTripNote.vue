<script setup lang="ts">
import { ui } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import type { ConnectTripNote } from "./connectFlowNotes";

// The "what you'll see" line under a sign-in's first step (connectFlowNotes.ts), with its way to another provider when
// the note is about a warning the reader may want to heed.

const t = useT();

const { note } = defineProps<{ note: ConnectTripNote }>();
const emit = defineEmits<{ elsewhere: [] }>();
</script>

<template>
    <div class="flex flex-col items-start gap-1 rounded-md border border-line-subtle bg-overlay px-2.5 py-2">
        <p class="font-medium text-content">{{ t(`sandbox.connectFlow.whatYoullSee`) }}</p>
        <p class="text-muted">{{ note.text }}</p>
        <button v-if="note.offerElsewhere" type="button" :class="ui.textButton({ size: `xs` })" @click="emit(`elsewhere`)">
            {{ t(`sandbox.connectFlow.useAnotherProvider`) }}
        </button>
    </div>
</template>
