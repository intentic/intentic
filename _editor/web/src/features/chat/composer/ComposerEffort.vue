<!-- Binds <EffortMeter> to a Conversation: which effort rungs the current model offers, which one is set, and where a click writes. -->
<script setup lang="ts">
import { computed } from "vue";
import { useT } from "@intentic/ui/i18n";
import type { Conversation } from "../session/conversation";
import { effortsFor } from "../models/run-settings/effortScale";
import EffortMeter from "./EffortMeter.vue";

const t = useT();

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

const { provider, model, thinking, effort, capabilities, auto } = conversation;

// Nothing to offer when the runtime takes no effort at all: an ACP agent owns its own reasoning settings, and
// OpenCode drops the field entirely.
const efforts = computed(() => (capabilities.value.effort ? effortsFor(provider.value, model.value, thinking.value) : []));
// While Auto is armed the ladder under it belongs to the fallback model and the reading answers for effort itself,
// so no rung is lit and none can be pressed: the same rule the picker's footer keeps (ChatModelPicker.vue).
const shown = computed(() => (auto.value ? `` : effort.value));
</script>

<template>
    <EffortMeter
        :efforts="efforts"
        :effort="shown"
        :disabled="disabled || auto"
        :empty-label="auto ? t(`chat.composerEffort.auto`) : ``"
        :label-class="labelClass"
        @pick="(level: string) => conversation.setEffort(level)"
    />
</template>
