<!-- A stranded turn's own press (AgentCard's `resendable`), sent again now or booked for the reset (cardRequests.ts). It
     acts in place, so it is a text action leading with what it does, not a link trailing the arrow that marks a drill-in
     as a way somewhere else. -->
<script setup lang="ts">
import { type Tip, ui } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";

defineProps<{ resending: boolean; atReset: boolean; tip: Tip; disabled: boolean }>();
const emit = defineEmits<{ resend: [] }>();

const t = useT();
</script>

<template>
    <button
        type="button"
        :class="ui.textButton({ tone: `quiet` }, 'inline-flex shrink-0 font-medium')"
        :disabled="resending || disabled"
        v-tooltip.top="tip"
        @click.stop="emit(`resend`)"
    >
        <Icon :name="resending ? `spinner` : atReset ? `clock` : `refresh`" :spin="resending" class="text-2xs" />{{
            resending ? t(`ui.status.sending`) : atReset ? t(`agents.agentCard.sendAtReset`) : t(`agents.words.sendAgain`)
        }}
    </button>
</template>
