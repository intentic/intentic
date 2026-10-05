<script setup lang="ts">
import { Button, Icon, vSkeletonSource } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, provide, ref } from "vue";
import { awaitingUser, turnInFlight } from "../../../agents/fleet/agentStatus";
import { useAgents } from "../../../agents/fleet/useAgents";
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
import ChatTurnDeliverables from "../../transcript/deliverables/ChatTurnDeliverables.vue";
import ChatHeldMessages from "../../transcript/held/ChatHeldMessages.vue";
import { useHeldQueue } from "../../transcript/held/heldQueue";
import { unsaidError } from "../../transcript/transcript";
import { useShotViewer } from "../../transcript/shots/useShotViewer";
import { usePaneTranscript } from "./paneTranscript";
import { useRowBudget, windowTurns } from "./paneWindow";
import { viewingIn } from "./paneSurface";
import { usePaneView } from "../useChat-view";
import FileRefPeek from "../../../workspace/files/refs/FileRefPeek.vue";
import { retryHydrate } from "../../run/useChat-sessions";

// A pane's turns: rows grouped by prompt, the marks between them, each turn's pictures and the one viewer walking them.

const t = useT();

const props = defineProps<{
    // A subagent's own record (ChatSubagentPane), not a conversation: nothing was prompted into it that has a record of
    // its own to disclose, and nothing in it can be forked from.
    subagent?: boolean;
}>();

const { conversation, messages, streaming, ending, awaitingDecision } = usePaneView();
const { showToolCalls } = useToolCalls();
const { agentById } = useAgents();
// How the last read of this chat went, when it has not answered yet (TranscriptView.refresh).
const refresh = computed(() => conversation.value.transcript.refresh.value);
const {
    turns,
    turnShots,
    repeatedChecklists,
    isStreaming,
    showTurnStatus,
    statusBelow,
    stripOf,
    deliverablesOf,
    checklistViews,
    dayMarks,
    forkCuts,
    cutsAbove,
    skeleton,
    waiting,
    staleness,
} = usePaneTranscript({
    messages,
    streaming,
    ending,
    awaitingDecision,
    showToolCalls,
    loading: computed(() => conversation.value.transcript.loading.value),
    conversationId: computed(() => conversation.value.conversationId),
    rowsOwed: computed(() => {
        const card = agentById(conversation.value.conversationId);
        return card !== undefined && (turnInFlight(card) || awaitingUser(card));
    }),
    refresh,
});
// The rows drawn so far, newest first (paneWindow.ts): a long chat opens on its last rows and mounts the rest at idle.
const budget = useRowBudget({ messages, conversationId: computed(() => conversation.value.conversationId) });
const shownTurns = computed(() => windowTurns(turns.value, messages.value.length, budget.value));
// Every row is drawn: only then is the column's top the conversation's (the paging press, the fork line, the prompt).
const whole = computed(() => budget.value >= messages.value.length);
const doomed = computed(() => conversation.value.transcript.doomed.value);
// The error line only where it adds to the transcript: the daemon's notice already says a turn's failure.
const error = computed(() => unsaidError(conversation.value.error.value, messages.value));
// The low-memory row whose message is held at the foot: that message's own line says it (ChatHeldMessages), so the row
// is not drawn a second time above it.
const { notice: heldNotice } = useHeldQueue();
const heldRow = computed(() => heldNotice.value?.id);
const viewer = useShotViewer(turns, turnShots);
provide(CHAT_SURFACE, viewingIn(useChatSurface(), viewer));
// The column whose `path:line` links raise a preview of the file (FileRefPeek).
const column = ref<HTMLElement>();
// What this conversation's next wait draws (ChatTranscriptSkeleton): its turns as they last stood, kept per conversation.
const imprint = computed(() => `chat.transcript:${conversation.value.conversationId}`);
</script>

<template>
    <div ref="column" class="chat-turns flex flex-1 flex-col pt-4">
        <!-- One preview for every file link in the column, hanging off whichever link the pointer or focus is on. -->
        <FileRefPeek :host="column" />
        <!-- The rest of the conversation, above the window it opened on (a long chat starts mid-history); drawn only where more exists. -->
        <div v-if="conversation.transcript.historyMore.value && whole" class="flex justify-center py-2">
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
        <ChatForkLine v-if="!conversation.transcript.historyMore.value && whole && !props.subagent" />
        <!-- What the conversation was told before its first word, at the one place in the column where that is
             true: above everything it has said. Drawn only at the real top, since in the middle of a paged
             history it would claim a beginning that isn't on screen. -->
        <ChatSystemPrompt
            v-if="!conversation.transcript.historyMore.value && whole && messages.length > 0 && !props.subagent"
            :conversation-id="conversation.conversationId"
        />
        <!-- The turns as one element, so the skeleton has one thing to remember them by; stacked by the column's own gap. -->
        <div v-if="messages.length > 0" v-skeleton-source="imprint" class="chat-stack flex flex-col">
            <!-- One section per turn, so each prompt's sticky range ends where its own answer does. -->
            <!-- `index` is for the day marker below, the one row that cares about its column position, not its turn. -->
            <template v-for="(turn, index) in shownTurns" :key="turn.id">
                <!-- The day this stretch was sent, drawn only where the date changes (dayMarks), between sections rather than inside one (a boundary, not part of a turn). -->
                <div v-if="dayMarks.get(turn.id)" class="flex justify-center pb-0.5 text-2xs text-subtle" :class="index === 0 ? '' : 'pt-3'">
                    {{ dayMarks.get(turn.id) }}
                </div>
                <!-- `chat-pin-host` carries `--chat-pin`: this turn's prompt writes its pinned height there, and anything sticky inside the turn reads it. -->
                <!-- `chat-turn` scopes the fork marks' hover (chat.css): each lights for the rows above it, not for the whole turn. -->
                <section class="chat-pin-host chat-stack chat-turn relative flex flex-col">
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
                            isStreaming(message) && statusBelow,
                            turn.folded,
                            doomed.has(message.id),
                            cutsAbove.get(message.id),
                            repeatedChecklists.has(message.id),
                            checklistViews.get(message.id),
                            heldRow === message.id,
                        ]"
                        class="contents"
                        :class="cutsAbove.get(message.id) !== undefined && !props.subagent && `chat-cut-row`"
                    >
                        <!-- Fork marks sit between message rows because row overflow clips marks above a row. -->
                        <ChatForkCut v-if="cutsAbove.get(message.id) !== undefined && !props.subagent" :cut="cutsAbove.get(message.id)!" />
                        <ChatMessageView
                            v-if="(!repeatedChecklists.has(message.id) || isStreaming(message)) && heldRow !== message.id"
                            :message="message"
                            :streaming="isStreaming(message)"
                            :status-below="statusBelow"
                            :folded="message.id === turn.id ? turn.folded : undefined"
                            :doomed="doomed.has(message.id)"
                            :checklist-view="checklistViews.get(message.id)"
                        />
                    </div>
                    <!-- The documents the turn made or changed, for a person to open (ChatTurnDeliverables). -->
                    <ChatTurnDeliverables v-if="deliverablesOf(turn)" :deliverables="deliverablesOf(turn)!" />
                    <!-- The pictures the turn's tools showed the agent, where its answer is read (ChatTurnShots). -->
                    <ChatTurnShots v-if="stripOf(turn)" :shots="stripOf(turn)!" :agent="conversation.scope.value" @view="viewer.view" />
                    <!-- The fork point sits after the answer and inside its hover region. -->
                    <ChatForkCut v-if="!props.subagent" class="chat-cut-row" :cut="forkCuts.get(turn.id) ?? messages.length" />
                </section>
            </template>
        </div>
        <!-- The transcript is on its way (a history open, an empty local mirror); without this it briefly reads as data loss, not loading. -->
        <ChatTranscriptSkeleton v-else-if="skeleton" :of="imprint" @retry="retryHydrate(conversation)" />
        <!-- A read that did not answer, with nothing painted to fall back on: said, with the press that asks again, never the empty invitation to start a conversation. -->
        <div
            v-else-if="refresh?.kind === `failed`"
            class="flex flex-1 flex-col items-center justify-center gap-2 px-4 text-center text-xs text-muted"
            role="alert"
        >
            <span>{{ t(`chat.chatPaneTurns.couldntOpen`) }}</span>
            <span v-if="refresh.reason" class="text-2xs text-subtle">{{ refresh.reason }}</span>
            <Button size="small" severity="secondary" @click="retryHydrate(conversation)">{{ t(`chat.chatTranscriptSkeleton.retry`) }}</Button>
        </div>
        <!-- What an empty chat says, which is the composer's to word; not while it loads, whose outline is only held back a moment. -->
        <slot v-else-if="!waiting" name="empty" />
        <!-- The live turn before it's written anything, or with rows under its bubble (showTurnStatus); outside the turn sections so it is always the last thing the transcript says. -->
        <ChatTurnStatus v-if="showTurnStatus" />
        <!-- What the queue holds, where the message the reader just sent would have been: after everything that ran, above the error line a press on it may leave. -->
        <ChatHeldMessages />
        <p v-if="error !== undefined" class="text-xs text-danger">{{ error }}</p>
        <!-- A read of a painted chat that has not answered: what is shown is the saved copy, said quietly, not as the error line. A live stream is fresher than either. -->
        <p v-if="staleness" class="flex flex-wrap items-center gap-x-2 gap-y-1 text-2xs text-subtle" role="status">
            <template v-if="staleness.kind === `reconnecting`">
                <Icon name="spinner" spin class="text-2xs" />
                <span>{{ t(`chat.chatPaneTurns.reconnecting`) }}</span>
            </template>
            <template v-else>
                <Icon name="exclamation-triangle" class="text-2xs text-warning" />
                <span>{{ t(`chat.chatPaneTurns.couldntRefresh`) }}</span>
                <span v-if="staleness.reason">{{ staleness.reason }}</span>
                <Button size="small" severity="secondary" :text="true" @click="retryHydrate(conversation)">{{ t(`ui.action.retry`) }}</Button>
            </template>
        </p>
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
