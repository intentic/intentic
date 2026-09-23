<script setup lang="ts">
import { useT } from "@intentic/ui/i18n";
import { computed, provide } from "vue";
import { CHAT_SURFACE, useChatSurface } from "../../tools/chatToolSurface";
import { useToolCalls } from "../../tools/useToolCalls";
import ChatForkCut from "../../transcript/ChatForkCut.vue";
import ChatForkLine from "../../transcript/ChatForkLine.vue";
import ChatMessageView from "../../transcript/ChatMessageView.vue";
import ChatTranscriptSkeleton from "../../transcript/ChatTranscriptSkeleton.vue";
import ChatTurnStatus from "../../transcript/ChatTurnStatus.vue";
import ChatSystemPrompt from "../../transcript/prompt/ChatSystemPrompt.vue";
import ChatShotViewer from "../../transcript/shots/ChatShotViewer.vue";
import ChatTurnShots from "../../transcript/shots/ChatTurnShots.vue";
import { useShotViewer } from "../../transcript/shots/useShotViewer";
import { usePaneTranscript } from "./paneTranscript";
import { viewingIn } from "./paneSurface";
import { usePaneView } from "../useChat-view";

// A pane's turns: rows grouped by prompt, the marks between them, each turn's pictures and the one viewer walking them.

const t = useT();

const { conversation, messages, streaming, awaitingDecision } = usePaneView();
const { showToolCalls } = useToolCalls();
const { turns, turnShots, repeatedChecklists, isStreaming, showTurnStatus, stripOf, checklistViews, dayMarks, forkCuts, cutsAbove, skeleton } =
    usePaneTranscript({
        messages,
        streaming,
        awaitingDecision,
        showToolCalls,
        loading: computed(() => conversation.value.transcript.loading.value),
        conversationId: computed(() => conversation.value.conversationId),
    });
const doomed = computed(() => conversation.value.transcript.doomed.value);
const viewer = useShotViewer(turns, turnShots);
provide(CHAT_SURFACE, viewingIn(useChatSurface(), viewer));
</script>

<template>
    <div class="chat-turns flex flex-1 flex-col pt-4">
        <!-- The rest of the conversation, above the window it opened on (a long chat starts mid-history); drawn only where more exists. -->
        <div v-if="conversation.transcript.historyMore.value" class="flex justify-center py-2">
            <!-- The press is the words, not the row — a full-width button would light up on any pointer crossing the top with no visible edges. -->
            <button
                type="button"
                class="cursor-pointer text-2xs text-subtle transition-colors hover:text-content disabled:cursor-default disabled:text-subtle"
                :disabled="conversation.transcript.loadingOlder.value"
                @click="conversation.transcript.loadOlder()"
            >
                {{ conversation.transcript.loadingOlder.value ? t(`chat.chatPane.loadingEarlierTurns`) : t(`chat.chatPane.loadEarlierTurns`) }}
            </button>
        </div>
        <!-- Where a forked chat says so, above its inherited turns; held back until the reader reaches that point. -->
        <ChatForkLine v-if="!conversation.transcript.historyMore.value" />
        <!-- What the conversation was told before its first word, at the one place in the column where that is
             true: above everything it has said. Drawn only at the real top, since in the middle of a paged
             history it would claim a beginning that isn't on screen. -->
        <ChatSystemPrompt v-if="!conversation.transcript.historyMore.value && messages.length > 0" :conversation-id="conversation.conversationId" />
        <template v-if="messages.length > 0">
            <!-- One section per turn, so each prompt's sticky range ends where its own answer does. -->
            <!-- `index` is for the day marker below, the one row that cares about its column position, not its turn. -->
            <template v-for="(turn, index) in turns" :key="turn.id">
                <!-- The day this stretch was sent, drawn only where the date changes (dayMarks), between sections rather than inside one (a boundary, not part of a turn). -->
                <div v-if="dayMarks.get(turn.id)" class="flex justify-center pb-0.5 text-2xs text-subtle" :class="index === 0 ? '' : 'pt-3'">
                    {{ dayMarks.get(turn.id) }}
                </div>
                <!-- `chat-pin-host` carries `--chat-pin`: this turn's prompt writes its pinned height there, and anything sticky inside the turn reads it. -->
                <section class="chat-pin-host chat-stack group/turn relative flex flex-col">
                    <!-- v-memo keys rendered inputs so streaming updates only the active row. -->
                    <!-- `doomed` is part of the memo key because struck rows render differently. -->
                    <!-- The checklist view is a fresh object per rebuild, so only the few rows that carry a
                         checklist redraw each tick; every other row keys on a stable `undefined`. -->

                    <!-- A display-contents wrapper keeps message children in the section's flex flow. -->
                    <div
                        v-for="message in turn.messages"
                        :key="message.id"
                        v-memo="[
                            message,
                            isStreaming(message),
                            turn.folded,
                            doomed.has(message.id),
                            cutsAbove.get(message.id),
                            repeatedChecklists.has(message.id),
                            checklistViews.get(message.id),
                        ]"
                        class="contents"
                    >
                        <!-- Fork marks sit between message rows because row overflow clips marks above a row. -->
                        <ChatForkCut v-if="cutsAbove.get(message.id) !== undefined" :cut="cutsAbove.get(message.id)!" />
                        <ChatMessageView
                            v-if="!repeatedChecklists.has(message.id) || isStreaming(message)"
                            :message="message"
                            :streaming="isStreaming(message)"
                            :folded="message.id === turn.id ? turn.folded : undefined"
                            :doomed="doomed.has(message.id)"
                            :checklist-view="checklistViews.get(message.id)"
                        />
                    </div>
                    <!-- The pictures the turn's tools showed the agent, where its answer is read (ChatTurnShots). -->
                    <ChatTurnShots v-if="stripOf(turn)" :shots="stripOf(turn)!" :agent="conversation.scope.value" @view="viewer.view" />
                    <!-- The fork point sits after the answer and inside its hover region. -->
                    <ChatForkCut :cut="forkCuts.get(turn.id) ?? messages.length" />
                </section>
            </template>
        </template>
        <!-- The transcript is on its way (a history open, an empty local mirror); without this it briefly reads as data loss, not loading. -->
        <ChatTranscriptSkeleton v-else-if="skeleton" />
        <!-- What an empty chat says, which is the composer's to word. -->
        <slot v-else name="empty" />
        <!-- The live turn before it's written anything (showTurnStatus); outside the turn sections since it belongs to no message yet. -->
        <ChatTurnStatus v-if="showTurnStatus" />
        <p v-if="conversation.error.value" class="text-xs text-danger">{{ conversation.error.value }}</p>
        <!-- Mounted only while open, so a chat nobody is looking through pictures in computes none of its filmstrip. -->
        <ChatShotViewer
            v-if="viewer.open.value"
            v-model:open="viewer.open.value"
            :shots="viewer.shots.value"
            :start="viewer.start.value"
            :agent="conversation.scope.value"
            :prompts="viewer.prompts.value"
        />
    </div>
</template>
