<script setup lang="ts">
import { ui } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { toneWash } from "@intentic/ui/tone";
import type { ConnectTripNote } from "./connectFlowNotes";

// The signs a sign-in's provider page will show (connectFlowNotes.ts), as chips after "You'll see": the words as the
// page shows them, recognisable there at a glance, then what they mean here. A warning the provider puts up wears the
// warning tone and its glyph, so the reader knows it is the one they will meet; its way to another provider follows it.
// A labelled section with a sentence per sign read as a notice to skip.

const t = useT();

const { note } = defineProps<{ note: ConnectTripNote }>();
const emit = defineEmits<{ elsewhere: [] }>();
</script>

<template>
    <div class="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-xs">
        <span class="text-muted">{{ t(`sandbox.connectFlow.whatYoullSee`) }}</span>
        <span
            v-for="sign in note.signs"
            :key="sign.shows"
            :class="
                toneWash(sign.warning ? `warning` : `neutral`, `inline-flex max-w-full items-center gap-1.5 rounded-md px-2 py-0.5`, !sign.warning && `text-content`)
            "
        >
            <Icon :name="sign.warning ? `exclamation-triangle` : `info-circle`" class="shrink-0 text-2xs" />
            <span class="font-medium">{{ sign.shows }}</span>
            <span class="min-w-0 opacity-75">· {{ sign.means }}</span>
        </span>
        <button v-if="note.offerElsewhere" type="button" :class="ui.textButton({ tone: `subtle`, size: `xs` })" @click="emit(`elsewhere`)">
            {{ t(`sandbox.connectFlow.useAnotherProvider`) }}
        </button>
    </div>
</template>
