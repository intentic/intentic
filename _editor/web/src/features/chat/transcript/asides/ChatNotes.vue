<script setup lang="ts">
import type { TurnNote } from "@intentic/sandbox-contract";
import { ref } from "vue";
import ChatSpineNode from "./ChatSpineNode.vue";
import { useT } from "@intentic/ui/i18n";

const t = useT();

// The context the sandbox added to a message, as one figure on the spine: a paperclip and a count standing in the
// left gutter beside the message it went out with (`.chat-notes-node` in chat.css), since these are things attached to
// that message, not words the user wrote. Opened, it is the LIST of what was added, each note opening to its own
// words: the titles answer "what went with this" without charging the reader for the text of five notes to find out.

defineProps<{ notes: readonly TurnNote[] }>();

const open = ref(false);
// The list find-in-page opened: shown at once, since the browser scrolls to the match before a reveal would finish.
const found = ref(false);
const toggleList = (): void => {
    found.value = false;
    open.value = !open.value;
};

// One note open at a time: the list is what the figure is for, and two open notes bury it.
const opened = ref<string>();
const toggle = (title: string): void => {
    opened.value = opened.value === title ? undefined : title;
};

// Strips a leading markdown heading (first line only); the row's own label already names the note.
const body = (text: string): string => text.replace(/^#{1,6} .*(\n|$)/, ``).trim();
</script>

<template>
    <div class="flex w-full flex-col">
        <div class="chat-spine-bar">
            <ChatSpineNode
                class="chat-notes-node"
                icon="paperclip"
                :count="notes.length"
                :open="open"
                :label="t(`chat.chatNotes.sentMessage`)"
                :tip="t(`chat.chatNotes.addedContext`)"
                @toggle="toggleList"
            />
        </div>
        <!-- Shut until found rather than absent, so find-in-page reaches the list, and a note inside it, and opens both. -->
        <div
            class="chat-mark-material chat-spine-material"
            :class="found && `chat-mark-found`"
            :hidden.attr="open ? undefined : `until-found`"
            @beforematch="
                found = true;
                open = true;
            "
        >
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
                    <!-- Shut until found rather than absent, so find-in-page reaches a note and opens it. -->
                    <div :hidden.attr="opened === note.title ? undefined : `until-found`" @beforematch="opened = note.title">
                        <!-- Capped and scrolled, not clamped: one note here is the whole project map. -->
                        <p class="max-h-48 overflow-auto px-2.5 pb-1.5 pl-7 whitespace-pre-wrap">{{ body(note.text) }}</p>
                    </div>
                </div>
            </div>
        </div>
    </div>
</template>
