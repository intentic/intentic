<script setup lang="ts">
import { Button, type ButtonTier } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import type { ChatMessage } from "../../../../models/conversations/transcript/transcript";
import { useKeptTurn } from "../held/heldQueue";
import { useAccessWall } from "../../../../models/conversations/endings/accessWall";
import { usePaneView } from "../../../../models/conversations/panel/useChat-view";

/* The press that runs a turn the sandbox kept after a refusal no raise would clear, while it still waits behind this notice. */

const props = withDefaults(defineProps<{ message: ChatMessage; tier?: ButtonTier }>(), { tier: `quiet` });

const t = useT();
// Only a kept turn carries this press: the conversation's queue holds the words of one a person sent (ChatHeldMessages).
const { waiting, send } = useKeptTurn(() => props.message);
// Where no account of the provider can serve (accessWall.ts), the card over the composer carries the retry, named for the
// account it re-tests, beside the fix: this line would be a second press for the same attempt.
const accessWall = useAccessWall();
// So does the card of ways out of a wall a press would only hit again (wayOut.ts), whose quiet Try again is that press.
const { wayOut } = usePaneView();
</script>

<template>
    <Button v-if="waiting && accessWall === undefined && wayOut === undefined" size="small" :tier="props.tier" class="shrink-0" @click="send">
        {{ t(`agents.words.sendAgain`) }}
    </Button>
</template>
