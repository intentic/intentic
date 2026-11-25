<!-- A need's "Not now", beside its yes: one press opens a line for a reason, a second declines with it. `label` names the
     no where "Not now" would misread it (a redirect's "Keep it here"). -->
<script setup lang="ts">
import { useT } from "@intentic/ui/i18n";
import ChatDecisionButton from "../../components/ChatDecisionButton.vue";

const t = useT();

defineProps<{ busy: boolean; declining: boolean; label?: string }>();
const emit = defineEmits<{ open: []; send: []; cancel: [] }>();
</script>

<template>
    <ChatDecisionButton v-if="!declining" tone="secondary" icon="times" :disabled="busy" @click="emit(`open`)">{{ label ?? t(`needs.card.notNow`) }}</ChatDecisionButton>
    <template v-else>
        <ChatDecisionButton tone="secondary" icon="times" :disabled="busy" @click="emit(`send`)">{{ t(`needs.card.declineSend`) }}</ChatDecisionButton>
        <ChatDecisionButton tone="secondary" @click="emit(`cancel`)">{{ t(`ui.action.cancel`) }}</ChatDecisionButton>
    </template>
</template>
