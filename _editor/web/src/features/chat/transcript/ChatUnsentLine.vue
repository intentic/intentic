<script setup lang="ts">
import { useT } from "@intentic/ui/i18n";
import { usePaneView } from "../../../models/conversations/panel/useChat-view";

// Words the sandbox has not taken yet (ChatMessage.unsent), said under their bubble with what a person can do about it:
// send them now rather than on the next try, or take them back into the composer.
const props = defineProps<{ messageId: string | undefined }>();

const t = useT();
const { conversation } = usePaneView();

const sendNow = (): void => {
    void conversation.value.turn.outbox.flush();
};
const cancel = (): void => {
    if (props.messageId !== undefined) {
        conversation.value.turn.outbox.cancel(props.messageId);
    }
};
</script>

<template>
    <div
        v-tooltip.left="{ title: t(`chat.chatMessageView.waitingToSend`), note: t(`chat.chatMessageView.waitingToSendHint`) }"
        class="flex items-center gap-2 text-2xs text-subtle"
        data-testid="chat-unsent"
    >
        <Icon name="clock" class="text-2xs" />
        <span>{{ t(`chat.chatMessageView.waitingToSend`) }}</span>
        <button type="button" class="touch-target cursor-pointer text-content hover:underline" @click.stop="sendNow">
            {{ t(`chat.chatMessageView.sendNow`) }}
        </button>
        <button type="button" class="touch-target cursor-pointer hover:text-content hover:underline" @click.stop="cancel">
            {{ t(`chat.chatMessageView.cancelSend`) }}
        </button>
    </div>
</template>
