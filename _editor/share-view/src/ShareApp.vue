<script setup lang="ts">
import type { TranscriptRow, TranscriptTool } from "@intentic/sandbox-contract";
import Icon from "@intentic/ui/icon";
import Markdown from "@intentic/ui/markdown-view";
import { formatDate, formatDateTime } from "@intentic/ui/format";
import { CHAT_SURFACE } from "@intentic/web/features/chat/tools/chatToolSurface";
import ChatToolCard from "@intentic/web/features/chat/tools/ChatToolCard.vue";
import { computed, provide, ref } from "vue";
import { readPayload } from "./payload";
import { shareSurface } from "./shareSurface";

// Renders the published conversation using the app's own markdown engine and tool card, adding only the bubble,
// thinking fold and day markers around them. Deliberately not ChatMessageView (the live row): a record has no
// pending card, no streaming, nobody to answer anything.

const result = readPayload();
const payload = computed(() => (result.ok ? result.payload : undefined));

// Tool cards here reach nothing beyond their own pictures — the whole difference from the app's live transcript.
provide(CHAT_SURFACE, shareSurface);

// The shared prose renderer gets no file-link decorator here (there's no workspace to link into) but keeps
// everything else, including figures, so a diagram-focused share still shows its diagram.

const subtitle = computed(() => {
    const shared = payload.value;
    if (shared === undefined) {
        return "";
    }
    const count = shared.messages.length;
    return `${count} message${count === 1 ? "" : "s"} · shared ${formatDate(shared.sharedAt)}`;
});

// Marks where the day changes, using only user rows' timestamps (a turn's answers belong to the day it was
// asked). A conversation from before timestamps existed just gets no markers, not guesses.
const dayMarks = computed(() => {
    const marks = new Map<number, string>();
    let last: string | undefined;
    (payload.value?.messages ?? []).forEach((message, index) => {
        if (message.sentAt === undefined) {
            return;
        }
        const day = formatDate(message.sentAt);
        if (day !== last) {
            marks.set(index, day);
            last = day;
        }
    });
    return marks;
});

// Always false: a settled record has nothing in flight, so no card may animate.
const LIVE = false;

// Tool calls arrive in the contract's own shape, the same one the app's card renders.
const toolsOf = (message: TranscriptRow): readonly TranscriptTool[] => message.tools ?? [];

// Folded by default even on a full share: reasoning is the longest, least-read part of a transcript.
const openThinking = ref<Record<number, boolean>>({});
const toggleThinking = (index: number): void => {
    openThinking.value = { ...openThinking.value, [index]: !openThinking.value[index] };
};
</script>

<template>
    <div class="mx-auto flex min-h-dvh w-full max-w-3xl flex-col gap-4 px-4 py-6 sm:px-6">
        <template v-if="payload">
            <header class="flex flex-col gap-1 border-b border-line pb-4">
                <h1 class="text-lg font-semibold text-content">{{ payload.title }}</h1>
                <p class="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-2xs text-subtle">
                    <span :title="formatDateTime(payload.sharedAt)">{{ subtitle }}</span>
                    <!--
                        Says plainly when work is left out, or a messages-only share reads as an agent that did
                        nothing.
                    -->
                    <span aria-hidden="true">·</span>
                    <span>{{ payload.detail === "messages" ? "messages only" : "with the agent's work" }}</span>
                </p>
            </header>

            <!--
                `chat-turns`/`chat-markdown` are the app's own stylesheet classes, so a shared page's type and spacing
                match the
                chat exactly.
            -->
            <!-- No copy delegation here: <Markdown> binds its own code-block button; a second listener would double it. -->
            <main class="chat-turns flex flex-1 flex-col">
                <template v-for="(message, index) in payload.messages" :key="index">
                    <div v-if="dayMarks.get(index)" class="flex items-center gap-2 py-1 text-2xs text-subtle">
                        <span class="h-px flex-1 bg-line"></span>
                        <span>{{ dayMarks.get(index) }}</span>
                        <span class="h-px flex-1 bg-line"></span>
                    </div>

                    <div v-if="message.role === 'user'" class="chat-stack flex flex-col items-end">
                        <div class="chat-surface max-w-[85%] rounded-lg px-3 py-2 text-xs leading-relaxed whitespace-pre-wrap text-content">
                            {{ message.text }}
                        </div>
                        <!--
                            Published beside the page: these are the actual bytes the agent looked at, not a filename
                            standing in.
                        -->
                        <div v-if="message.attachments?.length" class="flex flex-wrap justify-end gap-1">
                            <img
                                v-for="path in message.attachments"
                                :key="path"
                                :src="path"
                                :alt="path"
                                class="max-h-40 rounded border border-line object-contain"
                            />
                        </div>
                    </div>

                    <div v-else-if="message.role === 'notice'" class="flex items-center justify-center gap-1.5 py-0.5 text-2xs text-subtle">
                        <Icon name="info-circle" class="text-2xs" />
                        <span>{{ message.text }}</span>
                    </div>

                    <div v-else class="chat-stack flex w-full flex-col">
                        <div v-if="message.thinking" class="w-full overflow-hidden rounded-lg border-l-2 border-line-strong bg-overlay/60">
                            <button
                                type="button"
                                class="flex w-full items-center gap-1.5 px-2 py-1 text-2xs tracking-wide uppercase text-subtle"
                                :aria-expanded="openThinking[index] === true"
                                @click="toggleThinking(index)"
                            >
                                <Icon class="text-2xs" :name="openThinking[index] === true ? 'chevron-down' : 'chevron-right'" />
                                <span>Thinking</span>
                            </button>
                            <div
                                v-if="openThinking[index] === true"
                                class="scrollbar-thin max-h-64 overflow-auto px-3 pb-2 text-xs leading-relaxed whitespace-pre-wrap text-muted"
                            >
                                {{ message.thinking }}
                            </div>
                        </div>

                        <div v-if="toolsOf(message).length" class="flex w-full flex-col gap-1">
                            <ChatToolCard v-for="tool in toolsOf(message)" :key="tool.id" :tool="tool" :live="LIVE" />
                        </div>

                        <Markdown
                            v-if="message.text"
                            :source="message.text"
                            class="chat-markdown chat-surface-assistant w-full rounded-lg px-3.5 py-2.5"
                        />
                    </div>
                </template>
            </main>
        </template>

        <!-- Empty state matches the outbox's own status pages: say what happened, offer one useful action. -->
        <div v-else class="flex flex-1 flex-col items-center justify-center gap-2 text-center">
            <h1 class="text-sm font-semibold text-content">Nothing to show</h1>
            <p class="text-xs text-muted">{{ result.ok ? "" : result.reason }}</p>
        </div>

        <!-- Same attribution volume as the outbox's status pages, placed after the content rather than before it. -->
        <footer class="chat-footer mt-2 border-t border-line pt-3 text-center text-2xs text-subtle">
            <a href="https://intentic.dev" target="_blank" rel="noopener" class="text-link hover:underline">
                Shared from <b>Intentic</b>: run your own agents →
            </a>
        </footer>
    </div>
</template>
