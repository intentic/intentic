<script setup lang="ts">
import type { TurnNote } from "@intentic/sandbox-contract";
import { computed, ref } from "vue";
import ChatAside from "./ChatAside.vue";

// The context the sandbox added to a message, as one pill on the prompt's own edge. Opened, it is the LIST of what was
// added, each note opening to its own words: the titles answer "what went with this" without charging the reader for
// the text of five notes to find out.

const props = defineProps<{ notes: readonly TurnNote[] }>();

// One note open at a time: the list is what the pill is for, and two open notes bury it.
const opened = ref<string>();
const toggle = (title: string): void => {
    opened.value = opened.value === title ? undefined : title;
};

const titles = computed(() => props.notes.map((note) => note.title).join(`, `));

// Strips a leading markdown heading (first line only); the row's own label already names the note.
const body = (text: string): string => text.replace(/^#{1,6} .*(\n|$)/, ``).trim();
</script>

<template>
    <!-- Paperclip, not a text mark: these are things attached to the message, not words the user wrote. -->
    <ChatAside icon="paperclip" label="Sent with your message" :count="notes.length" :hint="titles" end>
        <div class="flex w-full flex-col overflow-hidden rounded border border-line bg-canvas">
            <div v-for="note in notes" :key="note.title" class="flex flex-col border-t border-line first:border-t-0">
                <button
                    type="button"
                    class="flex items-center gap-1.5 px-2 py-1 text-left transition-colors hover:bg-overlay hover:text-content"
                    :class="opened === note.title && `text-content`"
                    :aria-expanded="opened === note.title"
                    @click="toggle(note.title)"
                >
                    <Icon :name="opened === note.title ? `chevron-down` : `chevron-right`" class="shrink-0 text-2xs" />
                    <span class="min-w-0 truncate font-medium">{{ note.title }}</span>
                </button>
                <!-- Capped and scrolled, not clamped: one note here is the whole project map. -->
                <p v-if="opened === note.title" class="max-h-48 overflow-auto px-2 pb-1.5 pl-6 whitespace-pre-wrap">{{ body(note.text) }}</p>
            </div>
        </div>
    </ChatAside>
</template>
