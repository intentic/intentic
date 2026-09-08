<script setup lang="ts">
import { Button, CodeField, ResponsiveOverlay, useDevice } from "@intentic/ui";
import { computed, nextTick, onMounted, ref } from "vue";
import ChatModelPicker from "../../chat/models/ChatModelPicker.vue";
import ComposerEffort from "../../chat/composer/ComposerEffort.vue";
import ComposerModelPill from "../../chat/composer/ComposerModelPill.vue";
import type { Conversation } from "../../chat/session/conversation";

// The chat composer's own controls (model picker, effort, fill ramp, composer-* classes) reused exactly over a
// different Conversation, not a lookalike, so it can't drift from what the catalog actually offers.
// The promise is that the proposed turn is one the user could have composed themselves.
// Leaves out attachments, @-mentions, slash commands, dictation and the mode menu: those compose a task from nothing,
// and this box opens with the task already written.

const { conversation, action, busy = false } = defineProps<{ conversation: Conversation; action: string; busy?: boolean }>();
const emit = defineEmits<{ start: [] }>();

const { mobile } = useDevice();

const codeField = ref<InstanceType<typeof CodeField>>();
// The frame the field scrolls inside, held so the view can reset to the top after the caret is placed.
const scroller = ref<HTMLDivElement>();
// The pill IS the overlay's anchor: its element supplies the document to teleport into, the viewport to measure
// against, and the outside-click that dismisses it, so the box works unchanged wherever it's mounted.
const modelPill = ref<InstanceType<typeof ComposerModelPill>>();
// One flag shared by both hosts (sheet and panel), rather than one per host.
const modelOpen = ref(false);

const canStart = computed(() => !busy && conversation.draft.value.trim() !== ``);
const start = (): void => {
    if (canStart.value) {
        emit(`start`);
    }
};

// Ctrl/Cmd+Enter sends, a bare Enter is a newline: reversed from the chat composer, since this box opens with text
// already in it and the first action is editing, not sending mid-sentence.
const onKeydown = (event: KeyboardEvent): void => {
    if (event.key === `Enter` && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        start();
    }
};

onMounted(() => {
    void nextTick(() => {
        // Caret at the end, not a selection: the common edit is an addition.
        // A selection here is a trap a single keystroke would wipe out.
        const el = codeField.value?.field;
        if (el !== undefined && !mobile.value) {
            el.focus();
            el.setSelectionRange(el.value.length, el.value.length);
        }
        // Without this, placing the caret scrolls the frame to it, so a long proposal opens on its last line with no
        // top padding visible.
        // Reset after both focus() and setSelectionRange(), since each one scrolls the caret into view on its own.
        if (scroller.value !== undefined) {
            scroller.value.scrollTop = 0;
        }
    });
});
</script>

<template>
    <div class="rounded-xl border border-line bg-canvas">
        <div ref="scroller" class="scrollbar-thin max-h-64 overflow-y-auto">
            <CodeField
                ref="codeField"
                v-model="conversation.draft.value"
                lang="markdown"
                placeholder="What should the agent do?"
                aria-label="What should the agent do?"
                @keydown="onKeydown"
            />
        </div>

        <!--
            Vertical padding is 3, not 2: the field above already contributes 12px of its own, so a padding of 2 (8px) reads as an accidental
            mismatch, not a decision.
            Horizontal stays 2, aligning the model pill's glyph to the text's 16px column, since the pill carries 8px of its own.
        -->
        <div class="flex flex-wrap items-center gap-x-1 gap-y-1.5 px-2 py-3">
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

        <!--
            Same picker body as the chat composer's, over this conversation, in the same overlay; no height cap here since the overlay itself
            measures the room and passes it down.
            Remounted per open, so ChatModelPicker can bind its conversation's refs once.
        -->
        <ResponsiveOverlay v-model="modelOpen" :anchor="modelPill?.el" header="Model" panel-class="w-[26rem]">
            <ChatModelPicker :conversation="conversation" @selected="modelOpen = false" />
        </ResponsiveOverlay>
    </div>
</template>
