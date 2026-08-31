<script setup lang="ts">
import { Button, CodeField, ResponsiveOverlay, useDevice } from "@intentic/ui";
import { computed, nextTick, onMounted, ref } from "vue";
import ChatModelPicker from "../chat/ChatModelPicker.vue";
import ComposerEffort from "../chat/ComposerEffort.vue";
import ComposerModelPill from "../chat/ComposerModelPill.vue";
import type { Conversation } from "../composables/chat/conversation";

/* THE COMPOSER, LIFTED OUT OF THE CHAT: the box a suggested session is edited in before it is started.
 *
 * It is the chat composer's controls over a different Conversation, and deliberately not a lookalike: the same
 * model picker (ChatModelPicker, which is why that component takes the conversation it edits), the same effort
 * segments and the same fill ramp, the same `composer-*` classes out of chat.css. A second implementation would
 * have drifted on the first model the catalog added, and the whole promise of this dialog is that the turn it
 * proposes is a turn the user could have composed themselves.
 *
 * WHAT IT LEAVES OUT is as deliberate. No attachments, no @-mentions, no slash commands, no dictation, no mode
 * menu: those are for composing a task from nothing, and this box opens with the task already written. What
 * remains is exactly the two axes the user is being asked to approve: what to say, and what to spend saying it.
 */

const { conversation, action, busy = false } = defineProps<{ conversation: Conversation; action: string; busy?: boolean }>();
const emit = defineEmits<{ start: [] }>();

const { mobile } = useDevice();

const codeField = ref<InstanceType<typeof CodeField>>();
// The pill IS the anchor, which is why the component hands its element back: the overlay derives the document
// it teleports into, the viewport it measures the room against, and the click that never dismisses it, all from
// that element, so this box works unchanged wherever it is mounted (the app-wide dialog, the push dialog, a
// floating window).
const modelPill = ref<InstanceType<typeof ComposerModelPill>>();
// ONE flag for both hosts. It was two: one for the sheet, one for the panel, which is the shape a
// hand-written pair grows into and the reason the swap is a component now.
const modelOpen = ref(false);

const canStart = computed(() => !busy && conversation.draft.value.trim() !== ``);
const start = (): void => {
    if (canStart.value) {
        emit(`start`);
    }
};

/* Ctrl/Cmd+Enter sends; a bare Enter is a newline. The chat composer has this the other way round, and the
 * inversion is right here: this box opens with text already in it, so the first thing a user does is EDIT:
 * and a bare Enter that fired a frontier-model turn mid-sentence is the one mistake this dialog must not
 * make. The button's hint says so. */
const onKeydown = (event: KeyboardEvent): void => {
    if (event.key === `Enter` && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        start();
    }
};

onMounted(() => {
    void nextTick(() => {
        // Caret at the end, not selecting the whole prompt: the common edit is an addition, and a text
        // selection that a single keystroke would wipe out is a trap over a message the app just wrote.
        const el = codeField.value?.field;
        if (el !== undefined && !mobile.value) {
            el.focus();
            el.setSelectionRange(el.value.length, el.value.length);
        }
    });
});
</script>

<template>
    <div class="rounded-xl border border-line bg-canvas">
        <div class="scrollbar-thin max-h-64 overflow-y-auto px-1 pt-1">
            <CodeField
                ref="codeField"
                v-model="conversation.draft.value"
                lang="markdown"
                placeholder="What should the agent do?"
                aria-label="What should the agent do?"
                @keydown="onKeydown"
            />
        </div>

        <div class="flex flex-wrap items-center gap-x-1 gap-y-1.5 px-2 pb-2">
            <div class="flex min-w-0 items-center gap-1">
                <ComposerModelPill ref="modelPill" :conversation="conversation" :expanded="modelOpen" @click="modelOpen = !modelOpen" />

                <ComposerEffort :conversation="conversation" label-class="@max-lg:hidden" />
            </div>

            <Button
                size="small"
                class="ml-auto shrink-0"
                :disabled="!canStart"
                :loading="busy"
                :label="action"
                icon="send"
                v-tooltip.top="'Ctrl+Enter'"
                @click="start"
            />
        </div>

        <!-- The same picker body the chat composer raises, over THIS conversation, in the same overlay: no
             height cap, because the overlay measures the room its side of the pill actually has and passes that
             cap down to the picker's list. Remounted per open, which is what lets ChatModelPicker bind its
             conversation's refs once. -->
        <ResponsiveOverlay v-model="modelOpen" :anchor="modelPill?.el" header="Model" panel-class="w-[26rem]">
            <ChatModelPicker :conversation="conversation" @selected="modelOpen = false" />
        </ResponsiveOverlay>
    </div>
</template>
