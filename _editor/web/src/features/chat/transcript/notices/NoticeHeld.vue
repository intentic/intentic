<script setup lang="ts">
import { useT } from "@intentic/ui/i18n";
import type { ChatMessage } from "../../../../models/conversations/transcript/transcript";
import { useKeptTurn } from "../held/heldQueue";
import { useAccessWall } from "../../../../models/conversations/endings/accessWall";

/* The press that runs a turn the sandbox kept after a refusal no raise would clear, while it still waits behind this notice. */

const props = defineProps<{ message: ChatMessage }>();

const t = useT();
// Only a kept turn carries this press: the conversation's queue holds the words of one a person sent (ChatHeldMessages).
const { waiting, send } = useKeptTurn(() => props.message);
// Where no account of the provider can serve (accessWall.ts), the card over the composer carries the retry, named for the
// account it re-tests, beside the fix: this line would be a second press for the same attempt.
const accessWall = useAccessWall();
</script>

<template>
    <button v-if="waiting && accessWall === undefined" type="button" class="touch-target shrink-0 font-medium text-link hover:underline" @click="send">
        {{ t(`agents.words.sendAgain`) }}
    </button>
</template>
