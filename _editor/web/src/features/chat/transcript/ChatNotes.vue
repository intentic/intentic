<script setup lang="ts">
import type { TurnNote } from "@intentic/sandbox-contract";
import { ref } from "vue";
import ChatAsideLane from "./ChatAsideLane.vue";
import type { ChatAsideMark } from "./chatAsides";

// The context the sandbox added to a message, as one mark in the lane. Opened, it is the LIST of what was added, each
// note opening to its own words: the titles answer "what went with this" without charging the reader for the text of
// five notes to find out. A paperclip, not a text mark — these are things attached to the message, not words the user
// wrote.

const props = defineProps<{ notes: readonly TurnNote[] }>();

const marks: readonly ChatAsideMark[] = [
    { key: `notes`, icon: `paperclip`, label: `Sent with your message`, count: props.notes.length },
];

// One note open at a time: the list is what the mark is for, and two open notes bury it.
const opened = ref<string>();
const toggle = (title: string): void => {
    opened.value = opened.value === title ? undefined : title;
};

// Strips a leading markdown heading (first line only); the row's own label already names the note.
const body = (text: string): string => text.replace(/^#{1,6} .*(\n|$)/, ``).trim();
</script>

<template>
    <ChatAsideLane :marks="marks">
        <template #notes>
            <div class="chat-inset flex w-full flex-col overflow-hidden text-2xs leading-relaxed">
                <div v-for="note in notes" :key="note.title" class="flex flex-col">
                    <button
                        type="button"
                        class="flex items-center gap-1.5 px-2.5 py-1 text-left transition-colors hover:text-content"
                        :class="opened === note.title ? `text-content` : `text-muted`"
                        :aria-expanded="opened === note.title"
                        @click="toggle(note.title)"
                    >
                        <Icon :name="opened === note.title ? `chevron-down` : `chevron-right`" class="shrink-0 text-2xs" />
                        <span class="min-w-0 truncate font-medium">{{ note.title }}</span>
                    </button>
                    <!-- Capped and scrolled, not clamped: one note here is the whole project map. -->
                    <p v-if="opened === note.title" class="max-h-48 overflow-auto px-2.5 pb-1.5 pl-7 whitespace-pre-wrap">{{ body(note.text) }}</p>
                </div>
            </div>
        </template>
    </ChatAsideLane>
</template>
