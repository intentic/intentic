<script setup lang="ts">
import { useT } from "@intentic/ui/i18n";
import type { ChatMessage } from "../transcript";
import { useKeptTurn } from "../held/heldQueue";

/* The press that runs a turn the sandbox kept after a refusal no raise would clear, while it still waits behind this notice. */

const props = defineProps<{ message: ChatMessage }>();

const t = useT();
// Only a kept turn carries this press: the conversation's queue holds the words of one a person sent (ChatHeldMessages).
const { waiting, send } = useKeptTurn(() => props.message);
</script>

<template>
    <button v-if="waiting" type="button" class="shrink-0 font-medium text-link hover:underline" @click="send">
        {{ t(`agents.words.sendAgain`) }}
    </button>
</template>
