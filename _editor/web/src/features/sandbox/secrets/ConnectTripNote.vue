<script setup lang="ts">
import { SectionHeader, ui } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import type { ConnectTripNote } from "./connectFlowNotes";

// The "what you'll see" signs under a sign-in's first step (connectFlowNotes.ts): one row per thing the provider's page
// shows, its words as they appear there and a few of what they mean. Unboxed on purpose: it already sits in the panel's
// card, and a card in a card reads as a notice to skip. Its way to another provider follows when a sign is a warning the
// reader may want to heed.

const t = useT();

const { note } = defineProps<{ note: ConnectTripNote }>();
const emit = defineEmits<{ elsewhere: [] }>();
</script>

<template>
    <div class="flex flex-col items-start gap-1.5">
        <SectionHeader :label="t(`sandbox.connectFlow.whatYoullSee`)" density="dense" />
        <ul class="flex flex-col gap-1">
            <li v-for="sign in note.signs" :key="sign.shows" class="flex items-baseline gap-2">
                <Icon :name="sign.icon" class="shrink-0" :class="sign.warning ? `text-warning` : `text-subtle`" />
                <span>
                    <span class="font-medium" :class="sign.warning ? `text-warning` : `text-content`">{{ sign.shows }}</span>
                    <span class="text-muted"> · {{ sign.means }}</span>
                </span>
            </li>
        </ul>
        <button v-if="note.offerElsewhere" type="button" :class="ui.textButton({ size: `xs` })" @click="emit(`elsewhere`)">
            {{ t(`sandbox.connectFlow.useAnotherProvider`) }}
        </button>
    </div>
</template>
