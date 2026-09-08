<!--
    Binds <EffortMeter> to a Conversation: which effort rungs the current model offers, which one is set, and where a click writes. The scale is read
    live from the model (effortScale.ts's effortsFor), never stored; Conversation.effort only clamps the choice at send.
-->
<script setup lang="ts">
import { computed } from "vue";
import type { Conversation } from "../session/conversation";
import { effortsFor } from "../models/effortScale";
import EffortMeter from "./EffortMeter.vue";

const {
    conversation,
    disabled = false,
    labelClass = ``,
} = defineProps<{
    conversation: Conversation;
    /** Greyed and inert: the chat composer's controls go quiet under a workflow badge. */
    disabled?: boolean;
    /** Extra classes on the level word, for a composer that drops it in a narrow container. */
    labelClass?: string;
}>();

const { provider, model, thinking, effort, capabilities } = conversation;

// Nothing to offer when the runtime takes no effort at all: an ACP agent owns its own reasoning settings, and
// OpenCode drops the field entirely.
const efforts = computed(() => (capabilities.value.effort ? effortsFor(provider.value, model.value, thinking.value) : []));
</script>

<template>
    <EffortMeter
        :efforts="efforts"
        :effort="effort"
        :disabled="disabled"
        :label-class="labelClass"
        @pick="(level: string) => conversation.setEffort(level)"
    />
</template>
