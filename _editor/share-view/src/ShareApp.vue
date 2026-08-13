<script setup lang="ts">
import type { RestoredMessage, RestoredToolCall } from "@intentic/sandbox-contract";
/* Both by FILE rather than through the barrel, which is boot.ts's rule and this is what enforces it: the barrel
 * statically imports every component in the kit, and among them is the graph canvas, whose stylesheet import is
 * a side effect no bundler will drop. Reached through the barrel, prose costs this page a fifth of a megabyte of
 * Vue Flow — in the bundle a stranger downloads to read someone's transcript, for a canvas a conversation almost
 * never contains. Reached by file, a `dag` figure loads it on demand and nothing else pays. */
import Icon from "@intentic/ui/src/components/Icon.vue";
import Markdown from "@intentic/ui/src/components/Markdown.vue";
import { formatDate, formatDateTime } from "@intentic/ui/format";
import { CHAT_SURFACE } from "@intentic-app/web/chat/chatSurface";
import ChatToolCard from "@intentic-app/web/chat/ChatToolCard.vue";
import { computed, provide, ref } from "vue";
import { readPayload } from "./payload";
import { shareSurface } from "./shareSurface";

/* THE PUBLISHED CONVERSATION, as the person the link was sent to reads it.
 *
 * The transcript is drawn by the app's own pieces — the same markdown engine every surface renders prose with,
 * and the same tool card the chat draws work with (with nothing to click, see shareSurface.ts). What this file
 * adds is only what the app's chat does around them: the bubble, the thinking fold, the day markers.
 *
 * It deliberately does NOT reuse ChatMessageView. That component is the LIVE row — plan approvals, question
 * cards, permission prompts, pinning, the streaming loader, an errand's reveal — and every one of those is a
 * control, a decision or a claim about right now. A record has none: no card is pending, nothing is streaming,
 * and there is nobody here who could answer anything. Rendering the live row read-only would mean disabling a
 * dozen affordances one at a time and getting all of them right forever; drawing the record directly is both
 * smaller and the honest shape of the thing. */

const result = readPayload();
const payload = computed(() => (result.ok ? result.payload : undefined));

// The cards on this page reach nothing beyond their own pictures — the whole difference between the app's
// transcript and a published one, stated once here (chatSurface.ts).
provide(CHAT_SURFACE, shareSurface);

/* Prose goes through the shared component with NO decorator. The app passes one that turns file mentions into
 * links into the workspace; here there is no workspace, and a link that navigated nowhere would be a promise the
 * page cannot keep. Everything else about the answer is the app's — including the figures in it, so a
 * conversation shared for the diagram it drew shows the diagram. */

const subtitle = computed(() => {
    const shared = payload.value;
    if (shared === undefined) {
        return "";
    }
    const count = shared.messages.length;
    return `${count} message${count === 1 ? "" : "s"} · shared ${formatDate(shared.sharedAt)}`;
});

/* WHERE THE DAY CHANGES, so a conversation that ran across a week reads as one — the same marker the app's
 * transcript draws. Only user rows carry a stamp (RestoredMessage.sentAt), which is enough: a turn's answers
 * belong to the day its question was asked, and a conversation recorded before stamps existed simply gets no
 * markers rather than a row of guesses. */
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

// A settled record: nothing is in flight, so no card may animate and no spinner may claim otherwise. The one
// prop the tool card needs from this page, and it is always false.
const LIVE = false;

// Tool calls arrive as the contract's own restored shape, which is what the app's card renders too.
const toolsOf = (message: RestoredMessage): readonly RestoredToolCall[] => message.tools ?? [];

// The agent's reasoning is folded away by default even on an `everything` share: it is the longest and least
// read part of a transcript, and a page that opens on three screens of it buries the conversation.
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
                    <!-- What a reader is looking at, said plainly. A `messages` share leaves the agent's work
                         out entirely, and a page that did not say so would read as a conversation in which the
                         agent happened to do nothing. -->
                    <span aria-hidden="true">·</span>
                    <span>{{ payload.detail === "messages" ? "messages only" : "with the agent's work" }}</span>
                </p>
            </header>

            <!-- `chat-turns` is the column the app reads a conversation in; `chat-markdown` tunes the prose
                 tokens for it (<Markdown> brings `md-prose` itself). Both come from the app's own stylesheets,
                 which is why a shared page's type, spacing and code blocks match the chat rather than
                 approximating it. -->
            <!-- No copy delegation up here: a code block's button lives inside rendered prose, and <Markdown>
                 binds its own — a second listener on this element would copy the same text twice. -->
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
                        <!-- What was attached to the ask. Published beside the page, so these are the bytes the
                             agent actually looked at rather than a filename standing in for them. -->
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

        <!-- A page with nothing to draw. Same shape as the outbox's own status pages: say what happened, offer
             the one thing that is actually useful from here. -->
        <div v-else class="flex flex-1 flex-col items-center justify-center gap-2 text-center">
            <h1 class="text-sm font-semibold text-content">Nothing to show</h1>
            <p class="text-xs text-muted">{{ result.ok ? "" : result.reason }}</p>
        </div>

        <!-- The attribution the outbox's status pages already carry, at the same volume: a shared conversation
             is the most persuasive thing this product produces, and the link is read by someone who has never
             seen it. Bottom of the page, after the thing they came for. -->
        <footer class="chat-footer mt-2 border-t border-line pt-3 text-center text-2xs text-subtle">
            <a href="https://intentic.dev" target="_blank" rel="noopener" class="text-link hover:underline">
                Shared from <b>Intentic</b> — run your own agents →
            </a>
        </footer>
    </div>
</template>
