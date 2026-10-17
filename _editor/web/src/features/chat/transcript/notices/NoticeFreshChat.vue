<script setup lang="ts">
import { sandboxNoticeOf } from "@intentic/sandbox-contract/events/sandbox-notice";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { track } from "../../../../app/analytics";
import { composeAgent } from "../../../../models/fleet/agentActions";
import type { ChatMessage } from "../../../../models/conversations/transcript/transcript";
import { useKeptTurn } from "../held/heldQueue";

/* The way on from a turn the sandbox kept under a refusal that every resend would meet the same way (keptForGood): the
   held line's own press (ChatHeldMessages' startFresh), a new chat opened with the kept message in its composer. */

const props = defineProps<{ message: ChatMessage }>();

const t = useT();
const { waiting, words } = useKeptTurn(() => props.message);
const hint = computed(() => ({ title: t(`chat.chatHeld.startNewChatTitle`), note: t(`chat.chatHeld.startNewChatNote`) }));
const startFresh = (): void => {
    const notice = sandboxNoticeOf(props.message);
    track(`turn_refused_new_chat`, { code: notice?.code === `undelivered` ? notice.params.error : undefined, held: 1 });
    composeAgent(words());
};
</script>

<template>
    <button v-if="waiting" type="button" class="touch-target shrink-0 font-medium text-link hover:underline" v-tooltip.top="hint" @click="startFresh">
        {{ t(`chat.chatHeld.startNewChat`) }}
    </button>
</template>
