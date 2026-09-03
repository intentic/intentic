<!-- THE COMPOSER'S BINDING OF THE EFFORT METER (EffortMeter.vue holds the control itself): which rungs THIS
     conversation's model offers, the one it is on, and where a click writes.

     A binding rather than the control, because the meter is asked the same question by something that has no
     conversation at all: the pinned models in Sandbox ▸ Agent ▸ Models, where each entry carries its own effort.
     The two composers that draw this one (the chat's, and the suggested-session box's) keep passing a
     Conversation and nothing about them changes.

     THE SCALE IS READ, NEVER STORED. `effortsFor` is a property of the MODEL and of whether thinking is on, so
     the segments follow a model switch by themselves, and Conversation.effort clamps the pick for the send
     rather than ratcheting the user's choice down behind their back (see effortScale.ts). -->
<script setup lang="ts">
import { computed } from "vue";
import type { Conversation } from "../composables/chat/conversation";
import { effortsFor } from "../composables/chat/effortScale";
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
