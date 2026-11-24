<script setup lang="ts">
import { Button, Icon, Notice } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, ref, useTemplateRef } from "vue";
import { useHeldQueue } from "../../transcript/held/heldQueue";
import { useReopenPress } from "../../transcript/held/heldPresses";
import { useLimitResend } from "./scheduledSend";
import { memoryShare, sendAnywayTip } from "../../../../models/agent-status/memoryTip";
import { usePaneView } from "../../../../models/conversations/panel/useChat-view";
import { useHeldLineSeen } from "./heldLineSeen";
import ChatAskDock from "../asks/ChatAskDock.vue";

// What waits on the reader, pinned right above the composer so it is on screen at any scroll position: every ask the
// agent made of them (ChatAskDock), and a message held because the sandbox is short of memory. Both sat in the transcript
// where a reader scrolled elsewhere never saw them: a question waited 3 h 36 min, a held message 6 minutes while its
// writer thought it had gone out.

const props = defineProps<{
    // Whether this reader may answer. One who may not (a viewer, a writer with agents off) gets no press they would be refused.
    canDrive: boolean;
}>();
// The plan's two answers, done by the composer (composerSend), whose box holds the notes either one may carry.
const emit = defineEmits<{ approve: []; keepPlanning: [] }>();

const t = useT();
const { conversation, waiting, resumeQueue, next } = usePaneView();
const root = useTemplateRef<HTMLElement>(`root`);

// A message held for memory, said as held with the figures, and the two ways on: send it now, or leave it held, which
// only folds this notice away; the message stays held at the transcript's foot with its own press. That line under the
// message is the hold's home (ChatHeldMessages): this one stands in for it only while it is scrolled out of view, so
// a reader never sees the same hold and the same press twice.
const { held, reason, detail } = useHeldQueue();
const leftHeld = ref<string | undefined>();
const holdKey = computed(() => (held.value && reason.value === `memory` ? `${conversation.value.conversationId}:${detail.value ?? ``}` : undefined));
const lineSeen = useHeldLineSeen(root, holdKey);
const memoryShown = computed(() => holdKey.value !== undefined && holdKey.value !== leftHeld.value && !lineSeen.value);
// Lets go only the messages the hold kept, as the line's own press does: a booking beside them stays on its time.
const heldIds = computed(() => waiting.value.map((message) => message.id));
const sendHeld = (): Promise<void> => resumeQueue(heldIds.value);
// On an account spent until a reopen still ahead the bar offers what the line does: book them for then, Send anyway
// stepping back to a quiet press (heldPresses.ts).
const reopen = useReopenPress(() => memoryShown.value, useLimitResend(() => conversation.value).arm);
// Whether the sandbox sends it by itself once memory frees up, as the card says (`next`), so the bar never calls stuck
// what is about to go.
const sendsItself = computed(() => next.value?.kind === `room`);
const memoryLine = computed(() => {
    const share = memoryShare(detail.value);
    const said = share === undefined ? t(`chat.chatWaitingBar.heldMemory`) : t(`chat.chatWaitingBar.heldMemoryShare`, { share });
    return sendsItself.value ? `${said} · ${t(`chat.chatWaitingBar.sendsWhenRoom`)}` : said;
});
</script>

<template>
    <!-- `contents`: always in the tree, so the bar can find its pane's held line before it shows, yet no gap in the footer. -->
    <div ref="root" class="contents">
        <div class="flex flex-col gap-2 empty:hidden">
            <ChatAskDock @approve="emit(`approve`)" @keep-planning="emit(`keepPlanning`)" />
            <Notice v-if="memoryShown" tone="warning" icon="pause" size="sm" role="status">
                {{ reopen.blockedLine.value === undefined ? memoryLine : `${memoryLine} · ${reopen.blockedLine.value}` }}
                <template #actions>
                    <Button
                        tier="accent"
                        v-if="reopen.reopenAt.value !== undefined && props.canDrive"
                        size="small"
                        thumb
                        v-tooltip.top="reopen.hint.value"
                        @click="reopen.bookWords(heldIds)"
                        ><Icon name="clock" class="mr-1 text-2xs" />{{ reopen.label.value }}</Button
                    >
                    <Button
                        v-if="props.canDrive"
                        size="small"
                        thumb
                        :tier="reopen.reopenAt.value === undefined ? `accent` : `quiet`"
                        :disabled="reopen.blockedLine.value !== undefined"
                        v-tooltip.top="reopen.blockedHint.value ?? sendAnywayTip()"
                        @click="sendHeld()"
                        >{{ t(`chat.chatHeld.sendAnyway`) }}</Button
                    >
                    <Button
                        size="small"
                        thumb
                        tier="quiet"
                        v-tooltip.top="{ title: t(`chat.chatWaitingBar.wait`), note: sendsItself ? t(`chat.chatWaitingBar.waitHintRoom`) : t(`chat.chatWaitingBar.waitHint`) }"
                        @click="leftHeld = holdKey"
                        >{{ t(`chat.chatWaitingBar.wait`) }}</Button
                    >
                </template>
            </Notice>
        </div>
    </div>
</template>
