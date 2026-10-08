<script setup lang="ts">
import type { QueuedMessage } from "@intentic/sandbox-contract";
import { Button, Icon, ui } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { useNow } from "@intentic/ui/async";
import { basename } from "@intentic/ui/path";
import { computed, ref } from "vue";
import { attachmentPreview } from "../../drafts/attachmentPreviews";
import { usePaneView } from "../../panel/useChat-view";
import { pickUpWhen, wakesHeldUntil } from "../../run/pickUp";
import ChatImageThumb from "../../transcript/attachments/ChatImageThumb.vue";

// What waits for this conversation's next turn and will go by itself: the daemon's queue, the same in every window, with
// each message's own doors (reword, take back). A HELD queue is not drawn here: nothing goes by itself then, so its
// messages stand at the transcript's foot as the prompts that did not go out (ChatHeldMessages). Nor is a message booked
// for later, which stands there too, with the time it goes.

const t = useT();
const { waiting, queuePaused, streaming, awaitingDecision, pickUp, unqueue, reword, resumeQueue } = usePaneView();

// The sandbox's own words stranded behind a spent allowance go with the held turn when it reopens (wakesHeldUntil), and
// not before: the agent is free, yet nothing can take them, so "as soon as the agent is free" and a Send now (which the
// daemon would answer by letting nothing go) were both untrue. The strip above says the limit and offers its Continue.
const now = useNow(() => pickUp.value?.readyAt !== undefined);
const heldUntil = computed(() => wakesHeldUntil(pickUp.value, waiting.value, now.value));

// What happens to what waits: a parked turn takes it once answered, a running one ends first.
const hint = computed(() => {
    if (heldUntil.value !== undefined) {
        return t(`chat.chatQueue.goesWithHeldTurn`, { when: pickUpWhen(heldUntil.value, now.value) });
    }
    if (!streaming.value) {
        return t(`chat.chatQueue.goesWhenFree`);
    }
    return awaitingDecision.value ? t(`chat.chatQueue.goesAfterAnswer`) : t(`chat.chatQueue.goesAfterTurn`);
});

// The message being reworded here, and the words it is being given; one at a time.
const rewording = ref<{ readonly id: string; text: string } | undefined>();

// Who a message is from when a person did not type it.
const fromLine = (message: QueuedMessage): string | undefined => {
    if (message.voice === `person`) {
        return undefined;
    }
    return message.voice === `agent` ? t(`chat.chatQueue.fromAgent`) : t(`chat.chatQueue.fromSandbox`);
};

// A picture that goes with a message is drawn as one, small, the way it will be once sent; any other file by its name.
const picturesOf = (message: QueuedMessage) =>
    (message.attachments ?? []).flatMap((path) => {
        const previewUrl = attachmentPreview(path);
        return previewUrl === undefined ? [] : [{ name: basename(path), path, previewUrl }];
    });
const filesOf = (message: QueuedMessage): string[] =>
    (message.attachments ?? []).filter((path) => attachmentPreview(path) === undefined).map((path) => basename(path));

const save = async (message: QueuedMessage): Promise<void> => {
    const text = rewording.value?.text.trim() ?? ``;
    if (text.length === 0 || (await reword(message, text))) {
        rewording.value = undefined;
    }
};
</script>

<template>
    <!-- Outside the transcript until the agent receives them; every window shows the same list. -->
    <div v-if="waiting.length > 0 && queuePaused === undefined" class="flex flex-col gap-1">
        <div
            v-for="message in waiting"
            :key="message.id"
            class="flex items-start gap-2 rounded-xl border border-dashed border-line-strong bg-card px-3 py-2"
        >
            <Icon name="clock" class="mt-0.5 shrink-0 text-2xs text-subtle" />
            <form v-if="rewording?.id === message.id" class="flex min-w-0 flex-1 flex-col gap-1" @submit.prevent="save(message)">
                <textarea
                    v-model="rewording.text"
                    rows="2"
                    :class="ui.input({ size: `sm` }, 'w-full resize-y')"
                    :aria-label="t(`chat.chatQueue.rewordLabel`)"
                    @keydown.esc.prevent="rewording = undefined"
                />
                <div class="flex justify-end gap-1">
                    <Button size="small" tier="quiet" tone="accent" @click="rewording = undefined">{{ t(`ui.action.cancel`) }}</Button>
                    <Button size="small" type="submit">{{ t(`chat.chatQueue.save`) }}</Button>
                </div>
            </form>
            <div v-else class="flex min-w-0 flex-1 items-start gap-2">
                <ChatImageThumb
                    v-for="picture in picturesOf(message)"
                    :key="picture.path"
                    :src="picture.previewUrl"
                    :alt="picture.name"
                    size="h-8 w-8"
                />
                <div class="min-w-0 flex-1">
                    <p v-if="message.text" class="truncate text-2xs text-muted">{{ message.text }}</p>
                    <p v-if="filesOf(message).length > 0" class="truncate text-2xs text-subtle">
                        <Icon name="file" class="text-2xs" />
                        {{ filesOf(message).join(`, `) }}
                    </p>
                    <p v-if="fromLine(message) !== undefined" class="text-2xs text-subtle">{{ fromLine(message) }}</p>
                </div>
            </div>
            <button
                v-if="message.voice === `person` && rewording?.id !== message.id"
                type="button"
                class="composer-ghost h-5 w-5 shrink-0"
                v-tooltip.top="t(`chat.chatQueue.reword`)"
                :aria-label="t(`chat.chatQueue.rewordLabel`)"
                @click="rewording = { id: message.id, text: message.text }"
            >
                <Icon name="pencil" class="text-2xs" />
            </button>
            <button
                type="button"
                class="composer-ghost h-5 w-5 shrink-0"
                v-tooltip.top="t(`chat.chatQueue.takeBack`)"
                :aria-label="t(`chat.chatQueue.removeLabel`)"
                @click="unqueue(message)"
            >
                <Icon name="times" class="text-2xs" />
            </button>
        </div>
        <p class="flex items-center gap-2 px-1 text-2xs text-subtle">
            <span class="min-w-0 flex-1">{{ hint }}</span>
            <!-- Nothing runs here, yet it waits: a recovery the sandbox runs first, or a turn in another window. Not words a
                 spent allowance holds: the press would let nothing go, and the strip's Continue is the way to try sooner. -->
            <Button v-if="!streaming && heldUntil === undefined" size="small" tier="quiet" tone="accent" class="shrink-0" @click="resumeQueue()">{{ t(`chat.chatQueue.sendNow`) }}</Button>
        </p>
    </div>
</template>
