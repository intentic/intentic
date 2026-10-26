<script setup lang="ts">
import { ui } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import type { ConnectTripNote } from "./connectFlowNotes";

// The signs a sign-in's provider page will show (connectFlowNotes.ts), said as one sentence under the step: "You'll see
// Windsurf (the company behind Devin)". A labelled section with a row per sign was a heading and an icon for one fact,
// read as a notice to skip. A warning sign keeps the warning tone, and its way to another provider follows it inline.

const t = useT();

const { note } = defineProps<{ note: ConnectTripNote }>();
const emit = defineEmits<{ elsewhere: [] }>();
</script>

<template>
    <p class="text-muted">
        {{ t(`sandbox.connectFlow.whatYoullSee`) }}
        <template v-for="(sign, index) in note.signs" :key="sign.shows"
            ><template v-if="index > 0"> · </template
            ><span class="font-medium" :class="sign.warning ? `text-warning` : `text-content`">{{ sign.shows }}</span> ({{ sign.means }})</template
        >
        <button v-if="note.offerElsewhere" type="button" :class="ui.textButton({ size: `xs` }, `ml-2`)" @click="emit(`elsewhere`)">
            {{ t(`sandbox.connectFlow.useAnotherProvider`) }}
        </button>
    </p>
</template>
