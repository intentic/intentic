<script setup lang="ts">
import type { QueuedMessage } from "@intentic/sandbox-contract";
import { Button, Icon, type SwipeAction, SwipeRow, type TooltipValue, useDevice } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { useNow } from "@intentic/ui/async";
import { basename } from "@intentic/ui/path";
import { computed } from "vue";
import { attachmentPreview } from "../../drafts/attachmentPreviews";
import { usePaneView } from "../../panel/useChat-view";
import { pickUpWhen, wakesHeldUntil } from "../../run/endings/pickUp";
import ChatImageThumb from "../../transcript/attachments/ChatImageThumb.vue";

// What waits for this conversation's next turn and will go by itself: the daemon's queue, the same in every window, with
// each message's one door: a person's words go back into the composer to be edited there, anyone else's are removed. A HELD queue is not drawn here: nothing goes by itself then, so its
// messages stand at the transcript's foot as the prompts that did not go out (ChatHeldMessages). Nor is a message booked
// for later, which stands there too, with the time it goes.

const t = useT();
const { waiting, queuePaused, streaming, awaitingDecision, pickUp, unqueue, resumeQueue } = usePaneView();

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

// Editing happens in the composer below, the box the reader already writes in: the press takes the message out of line
// and puts its words and files there (TurnClient.takenBack), and sending it again queues it afresh. The sandbox's or an
// agent's words were nobody's here to write: removed. The hover says which, since the glyph alone does not.
const doorTip = (message: QueuedMessage): TooltipValue =>
    message.voice === `person` ? { title: t(`chat.chatQueue.edit`), note: t(`chat.chatQueue.editNote`) } : t(`chat.chatQueue.remove`);

// On a touch screen a waiting message is swiped aside for the same door: its button was the one way, a 20px target a
// thumb kept missing while clearing a queue of them one by one (PostHog, 2026-10: bursts of 8 to 16 taps in four
// seconds). The button stays, now with a thumb's target, for whoever reaches for it.
const { coarse } = useDevice();
const swipe = (message: QueuedMessage): SwipeAction | undefined => {
    if (!coarse.value) {
        return undefined;
    }
    return message.voice === `person`
        ? { label: t(`chat.chatQueue.edit`), icon: `pencil`, tone: `accent` }
        : { label: t(`chat.chatQueue.remove`), icon: `times`, tone: `danger` };
};
</script>

<template>
    <!-- Outside the transcript until the agent receives them; every window shows the same list. -->
    <div v-if="waiting.length > 0 && queuePaused === undefined" class="flex flex-col gap-1">
        <SwipeRow
            v-for="message in waiting"
            :key="message.id"
            :action="swipe(message)"
            class="rounded-xl"
            @commit="unqueue(message)"
        >
            <div class="flex items-start gap-2 rounded-xl border border-dashed border-line-strong bg-card px-3 py-2">
                <Icon name="clock" class="mt-0.5 shrink-0 text-2xs text-subtle" />
                <div class="flex min-w-0 flex-1 items-start gap-2">
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
                    type="button"
                    class="composer-ghost touch-target h-5 w-5 shrink-0"
                    v-tooltip.top="doorTip(message)"
                    :aria-label="message.voice === `person` ? t(`chat.chatQueue.editLabel`) : t(`chat.chatQueue.removeLabel`)"
                    @click="unqueue(message)"
                >
                    <Icon :name="message.voice === `person` ? `pencil` : `times`" class="text-2xs" />
                </button>
            </div>
        </SwipeRow>
        <p class="flex items-center gap-2 px-1 text-2xs text-subtle">
            <span class="min-w-0 flex-1">{{ hint }}</span>
            <!-- Nothing runs here, yet it waits: a recovery the sandbox runs first, or a turn in another window. Not words a
                 spent allowance holds: the press would let nothing go, and the strip's Continue is the way to try sooner. -->
            <Button v-if="!streaming && heldUntil === undefined" size="small" thumb tier="quiet" tone="accent" class="shrink-0" @click="resumeQueue()">{{ t(`chat.chatQueue.sendNow`) }}</Button>
        </p>
    </div>
</template>
