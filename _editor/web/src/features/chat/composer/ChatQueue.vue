<script setup lang="ts">
import type { QueuedMessage } from "@intentic/sandbox-contract";
import { Button, Icon, ui } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { basename } from "@intentic/ui/path";
import { computed, ref } from "vue";
import { usePaneView } from "../panel/useChat-view";

// What waits for this conversation's next turn: the daemon's queue, the same in every window, with each message's own
// doors (reword, take back) and, when the queue is held, the one press that lets it go.

const t = useT();
const props = defineProps<{
    /** What happens to what waits while nothing holds it (composerSend.queuedHint). */
    hint: string;
}>();
const { queued, queuePaused, streaming, unqueue, reword, resumeQueue } = usePaneView();

// The message being reworded here, and the words it is being given; one at a time.
const rewording = ref<{ readonly id: string; text: string } | undefined>();

const heldLine = computed(() => (queuePaused.value === `stopped` ? t(`chat.chatQueue.heldStopped`) : t(`chat.chatQueue.heldRefused`)));

// Who a message is from when a person did not type it.
const fromLine = (message: QueuedMessage): string | undefined => {
    if (message.voice === `person`) {
        return undefined;
    }
    return message.voice === `agent` ? t(`chat.chatQueue.fromAgent`) : t(`chat.chatQueue.fromSandbox`);
};

const save = async (message: QueuedMessage): Promise<void> => {
    const text = rewording.value?.text.trim() ?? ``;
    if (text.length === 0 || (await reword(message, text))) {
        rewording.value = undefined;
    }
};
</script>

<template>
    <!-- Outside the transcript until the agent receives them; every window shows the same list. -->
    <div v-if="queued.length > 0" class="flex flex-col gap-1">
        <div
            v-if="queuePaused !== undefined"
            class="flex items-center gap-2 rounded-xl border border-line-strong bg-card px-3 py-2 text-2xs text-muted"
        >
            <Icon name="pause" class="shrink-0 text-2xs text-subtle" />
            <span class="min-w-0 flex-1">{{ heldLine }}</span>
            <Button size="small" :text="true" class="shrink-0" v-tooltip.top="t(`chat.chatQueue.resumeHint`)" @click="resumeQueue()">
                {{ t(`chat.chatQueue.resume`) }}
            </Button>
        </div>
        <div
            v-for="message in queued"
            :key="message.id"
            class="flex items-start gap-2 rounded-xl border border-dashed border-line-strong bg-card px-3 py-2"
        >
            <Icon name="clock" class="mt-0.5 shrink-0 text-2xs text-subtle" />
            <form v-if="rewording?.id === message.id" class="flex min-w-0 flex-1 flex-col gap-1" @submit.prevent="save(message)">
                <textarea
                    v-model="rewording.text"
                    rows="2"
                    :class="ui.inputSm('w-full resize-y')"
                    :aria-label="t(`chat.chatQueue.rewordLabel`)"
                    @keydown.esc.prevent="rewording = undefined"
                />
                <div class="flex justify-end gap-1">
                    <Button size="small" :text="true" @click="rewording = undefined">{{ t(`chat.chatQueue.cancel`) }}</Button>
                    <Button size="small" type="submit">{{ t(`chat.chatQueue.save`) }}</Button>
                </div>
            </form>
            <div v-else class="min-w-0 flex-1">
                <p v-if="message.text" class="truncate text-2xs text-muted">{{ message.text }}</p>
                <p v-if="(message.attachments?.length ?? 0) > 0" class="truncate text-2xs text-subtle">
                    <Icon name="file" class="text-2xs" />
                    {{ message.attachments?.map((path) => basename(path)).join(`, `) }}
                </p>
                <p v-if="fromLine(message) !== undefined" class="text-2xs text-subtle">{{ fromLine(message) }}</p>
            </div>
            <button
                v-if="message.voice === `person` && rewording?.id !== message.id"
                type="button"
                class="composer-ghost h-5 w-5 shrink-0"
                v-tooltip.top="t(`chat.chatQueue.rewordHint`)"
                :aria-label="t(`chat.chatQueue.rewordLabel`)"
                @click="rewording = { id: message.id, text: message.text }"
            >
                <Icon name="pencil" class="text-2xs" />
            </button>
            <button
                type="button"
                class="composer-ghost h-5 w-5 shrink-0"
                v-tooltip.top="t(`chat.chatQueue.removeHint`)"
                :aria-label="t(`chat.chatQueue.removeLabel`)"
                @click="unqueue(message)"
            >
                <Icon name="times" class="text-2xs" />
            </button>
        </div>
        <p v-if="queuePaused === undefined" class="flex items-center gap-2 px-1 text-2xs text-subtle">
            <span class="min-w-0 flex-1">{{ props.hint }}</span>
            <!-- Nothing runs here, yet it waits: a recovery the sandbox runs first, or a turn in another window. -->
            <Button v-if="!streaming" size="small" :text="true" class="shrink-0" @click="resumeQueue()">{{ t(`chat.chatQueue.sendNow`) }}</Button>
        </p>
    </div>
</template>
