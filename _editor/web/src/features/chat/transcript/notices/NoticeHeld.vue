<script setup lang="ts">
import { useT } from "@intentic/ui/i18n";
import { basename } from "@intentic/ui/path";
import { computed } from "vue";
import { usePaneView } from "../../panel/useChat-view";
import type { ChatMessage } from "../transcript";

/* The press that sends a message a refusal at the door turned away, while it still waits behind this notice. */

const props = defineProps<{ message: ChatMessage }>();

const t = useT();
const { conversation, streaming, messages, queued } = usePaneView();

// Still waiting: nothing running, no row since, and its words kept, in the queue or by the sandbox with the message above.
const held = computed(
    () => !streaming.value && (props.message.sandboxHeld === true || queued.value.length > 0) && messages.value.at(-1)?.id === props.message.id,
);

// A queued message only needs releasing; a kept one is the sandbox's to run again, as it was started.
const send = (): void => {
    if (props.message.sandboxHeld !== true) {
        void conversation.value.turn.resume();
        return;
    }
    const kept = messages.value.findLast((row) => row.run === props.message.run && row.role === `user`);
    void conversation.value.turn.resendKept({
        text: kept?.text ?? ``,
        attachments: (kept?.attachments ?? []).map((path) => ({ name: basename(path), path })),
    });
};
</script>

<template>
    <template v-if="held">
        <button type="button" class="shrink-0 font-medium text-link hover:underline" @click="send">
            {{ message.noticeAction === `sendAgain` ? t(`shared.sendAgain`) : t(`chat.chatMessageView.sendAnyway`) }}
        </button>
        <!-- What else the refusal offers, only while the message it would help still waits. -->
        <slot />
    </template>
</template>
