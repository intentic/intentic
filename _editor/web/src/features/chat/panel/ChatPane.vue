<script setup lang="ts">
import { Button, FACE_SIZES, Icon, Notice, PersonaFace, ResponsiveOverlay, useDevice } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, provide, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { loopDesignLine } from "@intentic/sandbox-contract";
import type { Conversation } from "../session/conversation";
import { useShotViewer } from "../transcript/shots/useShotViewer";
import ChatShotViewer from "../transcript/shots/ChatShotViewer.vue";
import ChatTurnShots from "../transcript/shots/ChatTurnShots.vue";
import { useToolCalls } from "../tools/useToolCalls";
import { useChat } from "../run/useChat";
import { conversationView, PANE_VIEW } from "./useChat-view";
import { useChatRoute } from "../routing/chatRoute";
import { useRole } from "../../sandbox/secrets/useRole";
import { attachmentPeek } from "../drafts/attachmentPeeks";
import { attachmentAudio, attachmentKind, attachmentPreview } from "../drafts/attachmentPreviews";
import { useChatAttachments } from "../drafts/useChatAttachments";
import { useComposerVoice } from "../composer/useComposerVoice";
import { useEditorContextChip } from "../composer/useEditorContextChip";
import { useRunThrough } from "../models/run-settings/useRunThrough";
import { isBlocked } from "../../sandbox/live/connection";
import { useSandbox } from "../../sandbox/client/useSandbox";
import { usePaneAttach } from "./pane/paneAttach";
import { usePaneFocus } from "./pane/paneFocus";
import { usePaneScroll } from "./pane/paneScroll";
import { usePaneSurface } from "./pane/paneSurface";
import { usePaneTranscript } from "./pane/paneTranscript";
import { useComposerSize } from "./pane/composerSize";
import { useComposerControls } from "./pane/composerControls";
import { usePanePersona } from "./pane/panePersona";
import { useComposerSend } from "./pane/composerSend";
import { useComposerPopovers } from "./pane/composerPopovers";
import { useComposerKeys, useRecallRing } from "./pane/composerKeys";
import ChatCommandPopover from "../composer/ChatCommandPopover.vue";
import ChatContinueStrip from "./ChatContinueStrip.vue";
import ChatQueue from "../composer/ChatQueue.vue";
import ChatAudioChip from "../transcript/attachments/ChatAudioChip.vue";
import ChatFileChip from "../transcript/attachments/ChatFileChip.vue";
import ChatMentionPopover from "../composer/ChatMentionPopover.vue";
import ChatForkCut from "../transcript/ChatForkCut.vue";
import ChatForkLine from "../transcript/ChatForkLine.vue";
import ChatMessageView from "../transcript/ChatMessageView.vue";
import ChatSystemPrompt from "../transcript/prompt/ChatSystemPrompt.vue";
import ChatModelPicker from "../models/ChatModelPicker.vue";
import ChatModeMenu from "../models/run-settings/ChatModeMenu.vue";
import ChatPlacementMenu from "./ChatPlacementMenu.vue";
import ChatPaneNotices from "./ChatPaneNotices.vue";
import ChatPaneStatus from "./ChatPaneStatus.vue";
import ChatPersonaMenu from "../personas/ChatPersonaMenu.vue";
import ChatRunThroughMenu from "../models/run-settings/ChatRunThroughMenu.vue";
import ChatTranscriptSkeleton from "../transcript/ChatTranscriptSkeleton.vue";
import ChatTurnStatus from "../transcript/ChatTurnStatus.vue";
import ComposerEffort from "../composer/ComposerEffort.vue";
import ComposerModelPill from "../composer/ComposerModelPill.vue";
import ComposerMoreMenu from "../composer/ComposerMoreMenu.vue";

// One chat on screen: the transcript, its composer, and the pickers/banners for one conversation (ChatPanel owns
// the surrounding frame — list, pop-out, resize, shell commands). Takes its conversation as a prop rather than
// reading the focused one, and provides `conversationView` once so everything under it answers for the same chat.
// Wiring only: what the transcript draws, what a press means and does, the control row, the lists over the box and
// the keyboard are the headless composables in `pane/`; banners and status are their own components.

const t = useT();

const props = defineProps<{
    conversation: Conversation;
    // The pane the keyboard acts on; only the focused pane answers the shell's caret-focus signal.
    focused: boolean;
    // Whether this pane's column can be closed back into a single view; decided by the panel, not this chat.
    closable: boolean;
    // Composer and its notices alone, no transcript: what the quick bar hosts, so writing from another area is this
    // chat's own composer rather than a second one. The turns are withheld, never the chat — the stream, the draft and
    // every pick are the same conversation the full surface shows. A peek lifts it, and what arrives is these turns.
    bare?: boolean;
    // This pane is the floating strip's. Independent of `bare`, which is about the turns: this is about everything the
    // strip has no reader for — the status row is about a chat nobody is looking at, over a page they are.
    strip?: boolean;
}>();
// Working in a pane focuses it (a click, or the caret arriving via Tab or a closed picker); the × ends the column.
const emit = defineEmits<{ focus: []; close: [] }>();

// The prop as a ref, for the view and composables that follow this pane from one chat to the next.
const chat = computed(() => props.conversation);
const paneView = conversationView(chat);
provide(PANE_VIEW, paneView);
const { messages, streaming, awaitingDecision, mode, provider, model, draft, attachments, staged, connected, editing } = paneView;
const { reachable, connection } = useSandbox();
// The daemon refused this account outright, unlike "not connected yet": waiting won't fix it.
const denied = computed(() => connection.value.failure?.kind === `forbidden`);
const blocked = computed(() => connection.value.failure !== undefined && isBlocked(connection.value.failure));
const { mobile } = useDevice();
// A viewer's composer is present but inert (the daemon floors every route at collaborator).
const { canDrive, isGuest } = useRole();

const scroller = ref<HTMLElement | null>(null);
const content = ref<HTMLElement | null>(null);
const input = ref<HTMLTextAreaElement | null>(null);
// The sticky footer, textarea included: its chrome's height is what's left for the box to grow into.
const footer = ref<HTMLElement | null>(null);
// The pill anchors the model panel, so a popped-out window's overlay still lands on it.
const modelPill = ref<InstanceType<typeof ComposerModelPill>>();
const modePill = ref<HTMLElement>();
const placementPill = ref<HTMLElement>();
const runThroughPill = ref<HTMLElement>();
const personaPill = ref<HTMLElement>();
// The overflow's button; also the anchor three pickers fall back to when their own chip isn't in the row.
const morePill = ref<HTMLElement>();
const mentionPopover = ref<InstanceType<typeof ChatMentionPopover>>();
const commandPopover = ref<InstanceType<typeof ChatCommandPopover>>();
// The picker behind the paperclip (useChatAttachments.onPick).
const filePicker = ref<HTMLInputElement | null>(null);

usePaneAttach({ conversation: () => props.conversation, focused: () => props.focused, streaming });

const { showToolCalls } = useToolCalls();
const {
    turns,
    turnShots,
    repeatedChecklists,
    doomed,
    isStreaming,
    showTurnStatus,
    stripOf,
    checklistViews,
    dayMarks,
    forkCuts,
    cutsAbove,
    editDropped,
    skeleton,
} = usePaneTranscript({
    messages,
    streaming,
    awaitingDecision,
    editing,
    showToolCalls,
    loading: computed(() => props.conversation.transcript.loading.value),
    conversationId: computed(() => props.conversation.conversationId),
});
const shotViewer = useShotViewer(turns, turnShots);
const { open: shotViewerOpen, start: shotViewerStart, shots: shotViewerShots, prompts: shotViewerPrompts } = shotViewer;
const { pictureScope } = usePaneSurface({ conversation: () => props.conversation, router: useRouter(), viewer: shotViewer });

const { composerCap, grow } = useComposerSize({ scroller, footer, input });
const { pin, realizing } = usePaneScroll({
    scroller,
    content,
    conversationId: () => props.conversation.conversationId,
    bare: () => props.bare,
    messageCount: () => messages.value.length,
    streaming,
    grow,
});
const { takeFocus, closeHint } = usePaneFocus({
    focused: () => props.focused,
    raise: () => emit(`focus`),
    composerFocus: useChat().composerFocus,
    connected,
    mobile,
    input,
    grow,
});

// The badge for what the next message runs through: a loop, a workflow, or nothing.
const runThrough = useRunThrough(chat, { reachable, connected, staged, draft });
const {
    open: runThroughOpen,
    state: runThroughState,
    icon: runThroughIcon,
    name: runThroughName,
    hint: runThroughHint,
    label: runThroughLabel,
    workflow: pickedWorkflow,
    loop: pickedLoop,
    running: runningLoop,
    workflowFailure,
    loopFailure,
    pickLoop,
    pickWorkflow,
    manage: manageRunThrough,
    end: endLoop,
} = runThrough;
const steered = computed(() => pickedWorkflow.value !== undefined);

const {
    modelOpen,
    modeOpen,
    personaOpen,
    placementOpen,
    moreOpen,
    voiceAgent,
    conversationBox,
    remote,
    pairedRunners,
    placementShown,
    placementLabel,
    modelReading,
    modelLabelText,
    providerName,
    onTrial,
    modeLabel,
    modeIcon,
    inRow,
    moreRows,
    moreHint,
    modeAnchor,
    personaAnchor,
    runThroughAnchor,
    openFromMore,
} = useComposerControls({
    conversation: () => props.conversation,
    mode,
    provider,
    model,
    runThrough,
    steered,
    editing,
    pills: { mode: modePill, persona: personaPill, runThrough: runThroughPill, more: morePill },
});

// Files staged for the next turn; bytes go to the conversation's own box and path.
const staging = useChatAttachments({ attachments, reachable, connected, at: conversationBox });
const { dragDepth } = staging;

// The chip offering the file the user is looking at, only for a conversation running where that file lives.
const { target: editorTarget, include: includeEditorContext, label: editorChipLabel, forSend: editorContextForSend } = useEditorContextChip();
const editorChip = computed(() => editorTarget.value !== undefined && !remote.value);

// What the daemon reads the sent message as opening this chat on, asked once on a turnless chat (chatRoute.ts).
const chatRoute = useChatRoute(() => props.conversation);
const { personas, pickedPersona, personaName, personaNotice, pickPersona } = usePanePersona({
    conversation: () => props.conversation,
    route: chatRoute,
    isGuest,
    picked: () => {
        personaOpen.value = false;
    },
});

const history = useRecallRing(() => props.conversation);
const {
    continueStrip,
    continueOffer,
    canSend,
    refusal,
    sendShown,
    composerPlaceholder,
    sendHint,
    stopLabel,
    stopHint,
    queuedHint,
    submit,
    continueTurn,
    forkInsteadOfEdit,
} = useComposerSend({
    view: paneView,
    voiceAgent,
    staging,
    editorContext: { include: includeEditorContext, forSend: editorContextForSend },
    runThrough,
    route: chatRoute,
    history,
    reachable,
    canDrive,
    mobile,
    words: computed(() => ({ provider: providerName.value, onTrial: onTrial.value, editDropped: editDropped.value })),
    pin,
    refocus: () => {
        grow();
        input.value?.focus();
    },
    openModels: () => {
        modelOpen.value = true;
    },
});

// Hands-free voice: the mic, and what the pause does; below the send, since the pause is the send.
const voice = useComposerVoice({ draft, reachable, grew: grow, send: submit });
const { on: voiceOn, state: voiceState, level: voiceLevel, buttonHint: voiceHint, errorMessage: voiceErrorMessage, toggle: toggleVoice } = voice;
// Leaving exits hands-free, so a mic isn't left recording a pane nobody's looking at; the draft is untouched.
watch([() => props.conversation, () => props.focused], voice.quit);

const popovers = useComposerPopovers({
    view: paneView,
    input,
    grow,
    personas,
    pickPersona,
    placement: { remote, shown: placementShown, runners: pairedRunners },
    steered,
    isGuest,
});
const { syncCaret, activeMention, commandMatches, filesOffered, quickSources, mentionOpen, commandOpen, flashed, pickMention, pickCommand } =
    popovers;
const { onKeydown, onInput, composerHint } = useComposerKeys({
    view: paneView,
    input,
    history,
    popovers,
    lists: { mention: mentionPopover, command: commandPopover },
    voice,
    reachable,
    mobile,
    continueOffer,
    grow,
    submit,
});
</script>

<!-- Everything the panel's chat list is not; carries the @container so composer density keys off this pane's own share of the width, not the panel's. -->
<!-- Kept outside the template: a comment inside it makes this multi-root, and dev patches a multi-root subtree
     unoptimized — every slotted child, including all six closed composer menus, redraws on every keystroke. -->
<template>
    <div
        class="chat-pane @container relative flex min-h-0 min-w-0 flex-1 flex-col"
        :class="{ 'chat-pane-on': focused }"
        @pointerdown="takeFocus"
        @focusin="takeFocus"
        @dragenter="staging.onDragEnter"
        @dragover.prevent
        @dragleave="staging.onDragLeave"
        @drop.prevent.stop="staging.onDrop"
    >
        <div
            v-if="dragDepth > 0"
            class="pointer-events-none absolute inset-1 z-30 rounded-xl border-2 border-dashed border-primary-500 bg-primary-500/10"
        ></div>
        <!-- Floats over the transcript's corner rather than a header, since a pane has no header of its own and the panel above already names the chats. -->
        <button
            v-if="closable"
            type="button"
            class="absolute top-2 right-2 z-20 flex h-6 w-6 cursor-pointer items-center justify-center rounded-lg bg-card/70 text-subtle backdrop-blur-sm transition-colors hover:bg-overlay hover:text-content"
            v-tooltip.bottom="closeHint"
            :aria-label="t(`chat.chatPane.closePane`)"
            @pointerdown.stop
            @focusin.stop
            @click.stop="emit(`close`)"
        >
            <Icon name="times" class="text-2xs" />
        </button>
        <!-- One scroller for the transcript and the composer under it, so the composer's height is reserved by layout, not measured back into it. -->
        <!-- `.chat-scroller` is the IntersectionObserver root each prompt uses to tell if it's pinned. -->
        <div
            ref="scroller"
            class="chat-scroller flex flex-1 flex-col"
            :class="[bare ? 'overflow-visible' : 'overflow-x-hidden overflow-y-auto', { 'chat-realize': realizing }]"
        >
            <div ref="content" class="flex min-w-0 flex-1 flex-col">
                <!-- Bare: the turns are the one part withheld, so no message component mounts and the scroller shrinks to the composer. -->
                <div v-if="!bare" class="chat-turns flex flex-1 flex-col pt-4">
                    <!-- The rest of the conversation, above the window it opened on (a long chat starts mid-history); drawn only where more exists. -->
                    <div v-if="conversation.transcript.historyMore.value" class="flex justify-center py-2">
                        <!-- The press is the words, not the row — a full-width button would light up on any pointer crossing the top with no visible edges. -->
                        <button
                            type="button"
                            class="cursor-pointer text-2xs text-subtle transition-colors hover:text-content disabled:cursor-default disabled:text-subtle"
                            :disabled="conversation.transcript.loadingOlder.value"
                            @click="conversation.transcript.loadOlder()"
                        >
                            {{
                                conversation.transcript.loadingOlder.value
                                    ? t(`chat.chatPane.loadingEarlierTurns`)
                                    : t(`chat.chatPane.loadEarlierTurns`)
                            }}
                        </button>
                    </div>
                    <!-- Where a forked chat says so, above its inherited turns; held back until the reader reaches that point. -->
                    <ChatForkLine v-if="!conversation.transcript.historyMore.value" />
                    <!-- What the conversation was told before its first word, at the one place in the column where that is
                         true: above everything it has said. Drawn only at the real top, since in the middle of a paged
                         history it would claim a beginning that isn't on screen. -->
                    <ChatSystemPrompt
                        v-if="!conversation.transcript.historyMore.value && messages.length > 0"
                        :conversation-id="conversation.conversationId"
                    />
                    <template v-if="messages.length > 0">
                        <!-- One section per turn, so each prompt's sticky range ends where its own answer does. -->
                        <!-- `index` is for the day marker below, the one row that cares about its column position, not its turn. -->
                        <template v-for="(turn, index) in turns" :key="turn.id">
                            <!-- The day this stretch was sent, drawn only where the date changes (dayMarks), between sections rather than inside one (a boundary, not part of a turn). -->
                            <div
                                v-if="dayMarks.get(turn.id)"
                                class="flex justify-center pb-0.5 text-2xs text-subtle"
                                :class="index === 0 ? '' : 'pt-3'"
                            >
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
                                <ChatTurnShots v-if="stripOf(turn)" :shots="stripOf(turn)!" :agent="pictureScope" @view="shotViewer.view" />
                                <!-- The fork point sits after the answer and inside its hover region. -->
                                <ChatForkCut :cut="forkCuts.get(turn.id) ?? messages.length" />
                            </section>
                        </template>
                    </template>
                    <!-- The transcript is on its way (a history open, an empty local mirror); without this it briefly reads as data loss, not loading. -->
                    <ChatTranscriptSkeleton v-else-if="skeleton" />
                    <!-- Names the provider because that's the fact worth having on every provider but the trial — and on a
                         chat with nothing that could answer, where there is no provider to name and the line below says the rest. -->
                    <p v-else class="m-auto max-w-[80%] text-center text-xs text-muted">
                        {{
                            modelReading.unset
                                ? t(`chat.chatPane.startConversationAny`)
                                : onTrial
                                  ? t(`chat.chatPane.askAnythingChatFree`)
                                  : t(`chat.chatPane.startConversation`, { providerName })
                        }}
                    </p>
                    <!-- The live turn before it's written anything (showTurnStatus); outside the turn sections since it belongs to no message yet. -->
                    <ChatTurnStatus v-if="showTurnStatus" />
                    <p v-if="conversation.error.value" class="text-xs text-danger">{{ conversation.error.value }}</p>
                </div>

                <!-- The composer and its gating notices; last row of the transcript, stuck to the bottom edge, rather than a separate band. -->
                <!-- The strip's composer keeps ONE rect whether or not a transcript is open above it (chat.css): its padding is room a
     peek adds above the box, never around it, since everything else would move the box being typed in. -->
                <div
                    ref="footer"
                    class="chat-footer sticky bottom-0 z-10 mx-auto flex w-full max-w-[51rem] flex-col gap-2"
                    :class="strip ? 'chat-footer-strip' : 'px-2 py-3'"
                >
                    <!-- The composer stands whatever this chat can or cannot send with: a box that vanishes reads as the app
                         breaking, and a first-run reader has nowhere to type their task. Having no model is said in a line
                         above it (ChatPaneNotices) and answered by Send itself, which opens the model list. -->
                    <Notice v-if="denied" tone="danger">{{ t(`chat.chatPane.googleAccountNoAccess`) }}</Notice>
                    <Notice v-else-if="blocked" tone="info" icon="clock">{{ t(`chat.chatPane.chatAvailableAfterSandbox`) }}</Notice>
                    <template v-if="!blocked">
                        <!-- This chat's standing: archived, the account gate, the trial, a credential to renew, an outage resuming (ChatPaneNotices). -->
                        <ChatPaneNotices />
                        <!-- The turn stopped before finishing, and the way on (ChatContinueStrip). -->
                        <ChatContinueStrip :visible="continueStrip" :ready="continueOffer" @continue="continueTurn" />
                        <!-- What waits for the next turn: the conversation's queue, the same in every window. -->
                        <ChatQueue :hint="queuedHint" />
                        <!-- The edit notice identifies the message and its two actions. -->
                        <div
                            v-if="editing !== undefined"
                            class="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl border border-primary-500/40 bg-primary-600/10 px-3 py-2 text-2xs text-muted"
                        >
                            <Icon name="pencil" class="shrink-0 text-link" />
                            <span class="min-w-0 flex-1">
                                {{ t(`chat.chatPane.editingMessage`) }}
                                <template v-if="editDropped > 1">{{
                                    t(`chat.chatPane.belowReplacedSend`, { editDropped: editDropped - 1 })
                                }}</template>
                                <template v-else>{{ t(`chat.chatPane.replacedSend`) }}</template>
                            </span>
                            <!-- The keep-answer action precedes Cancel so the answer is read first. -->
                            <Button
                                size="small"
                                severity="secondary"
                                :text="true"
                                class="shrink-0"
                                v-tooltip.top="t(`chat.chatPane.openNewChatHere`)"
                                @click="forkInsteadOfEdit"
                            >
                                {{ t(`chat.chatPane.keepBothInstead`) }}
                            </Button>
                            <Button
                                size="small"
                                :text="true"
                                class="shrink-0"
                                v-tooltip.top="t(`chat.chatPane.leaveEverythingNothingChanged`)"
                                @click="conversation.transcript.cancelEdit()"
                            >
                                {{ t(`ui.action.cancel`) }}
                            </Button>
                        </div>
                        <!-- The whole box changes standing when the agent's voice is armed (.composer-voice); being in this mode by accident is the one mistake worth painting. -->
                        <form
                            class="ui-field-shell composer-frame relative flex flex-col rounded-2xl border-line-strong bg-overlay shadow-lg"
                            :class="{ 'composer-voice': voiceAgent }"
                            @submit.prevent="submit"
                        >
                            <ChatMentionPopover
                                v-if="mentionOpen"
                                ref="mentionPopover"
                                :query="activeMention?.query ?? ''"
                                :sources="quickSources"
                                :files-offered="filesOffered"
                                @pick="pickMention"
                            />
                            <ChatCommandPopover v-if="commandOpen" ref="commandPopover" :commands="commandMatches" @pick="pickCommand" />
                            <!-- `items-start`, as the sent bubble's row is: a one-line chip stretched to the height of a player or a thumbnail beside it reads as a panel someone forgot to fill. -->
                            <div v-if="attachments.length > 0 || editorChip" class="flex flex-wrap items-start gap-2 px-3 pt-3">
                                <!-- The editor-context chip attaches the open file or selection when enabled. -->
                                <button
                                    v-if="editorChip"
                                    type="button"
                                    class="ui-chip rounded-lg px-2 py-1.5 text-xs"
                                    :class="includeEditorContext ? `ui-chip-on` : `border-dashed border-line`"
                                    @click="includeEditorContext = !includeEditorContext"
                                    :aria-pressed="includeEditorContext"
                                    :aria-label="t(`chat.chatPane.attachEditorContext`)"
                                >
                                    <Icon name="code" class="shrink-0 text-2xs" />
                                    <span class="max-w-36 truncate">{{ editorChipLabel }}</span>
                                </button>
                                <!-- Keyed by path like the sent bubble, but not until the upload lands: the daemon's copy of a file still going up is a prefix, which decodes as a part-drawn picture the path's cache then keeps. -->
                                <template v-for="a in attachments" :key="a.id">
                                    <!-- A sound plays where it was attached; there is nothing about it a filename and a byte count can tell you. -->
                                    <ChatAudioChip
                                        v-if="attachmentKind(a.path) === `audio`"
                                        :name="a.name"
                                        :path="a.path"
                                        :src="a.status === 'done' ? attachmentAudio(a.path) : a.previewUrl"
                                        :progress="a.status === 'uploading' ? a.progress : undefined"
                                        :error="a.status === 'failed' ? (a.error ?? 'Upload failed') : undefined"
                                        framed
                                        removable
                                        @remove="staging.remove(a)"
                                    />
                                    <ChatFileChip
                                        v-else
                                        :name="a.name"
                                        :path="a.path"
                                        :peek="a.status === 'done' ? attachmentPeek(a.path) : undefined"
                                        :preview-url="a.status === 'done' ? attachmentPreview(a.path) : a.previewUrl"
                                        :progress="a.status === 'uploading' ? a.progress : undefined"
                                        :error="a.status === 'failed' ? (a.error ?? 'Upload failed') : undefined"
                                        framed
                                        removable
                                        @remove="staging.remove(a)"
                                    />
                                </template>
                            </div>
                            <!-- The composer uses transcript body sizing on desktop. -->
                            <textarea
                                ref="input"
                                rows="1"
                                v-model="draft"
                                name="draft"
                                :disabled="!canDrive"
                                :placeholder="composerPlaceholder"
                                class="field-bare block w-full resize-none overflow-y-auto px-4 py-3 leading-relaxed md:text-xs"
                                :style="{ maxHeight: `${composerCap}px` }"
                                @input="onInput"
                                @keydown="onKeydown"
                                @keyup="syncCaret"
                                @click="syncCaret"
                                @paste="staging.onPaste"
                            ></textarea>

                            <!-- The control row keeps model controls and actions in separate groups. -->
                            <div class="flex flex-wrap items-center gap-x-1 gap-y-1.5 px-2.5 pb-2.5">
                                <!-- Workflow sends disable controls that do not affect the workflow step. -->
                                <!-- `min-w-0` lets the model name truncate first, since it's the one shrinkable middle in the row. -->
                                <div class="flex min-w-0 items-center gap-1">
                                    <!-- With nothing that could run here there is no provider to announce: the name is the press itself, and it
                                             keeps its label at every width. A narrow composer drops a model's name to its logo and still reads;
                                             dropping "Choose a model" leaves a bare glyph with nothing saying to press it. -->
                                    <ComposerModelPill
                                        ref="modelPill"
                                        :conversation="conversation"
                                        :class="{ 'composer-steered': pickedWorkflow !== undefined, 'composer-flash': flashed === 'model' }"
                                        :disabled="pickedWorkflow !== undefined"
                                        :expanded="modelOpen"
                                        :aria-label="
                                            modelReading.unset ? modelLabelText : t(`chat.chatPane.providerModel`, { providerName, modelLabelText })
                                        "
                                        :label-class="modelReading.unset ? `` : `@max-md:hidden`"
                                        @click="modelOpen = !modelOpen"
                                    />

                                    <ComposerEffort
                                        :conversation="conversation"
                                        :class="{ 'composer-steered': pickedWorkflow !== undefined, 'composer-flash': flashed === 'effort' }"
                                        :disabled="pickedWorkflow !== undefined"
                                        label-class="@max-lg:hidden"
                                    />
                                </div>

                                <!-- How the turn is shaped, and the press that sends it — the group holding the right edge. -->
                                <div class="ml-auto flex flex-wrap items-center justify-end gap-x-1 gap-y-1.5">
                                    <!-- Mode follows the model and effort controls in the shaping group. -->
                                    <button
                                        v-if="inRow.mode"
                                        ref="modePill"
                                        type="button"
                                        class="composer-ghost h-8 shrink-0 gap-1.5 px-2.5 text-2xs font-medium max-md:h-11"
                                        :class="{ 'composer-steered': pickedWorkflow !== undefined }"
                                        :disabled="pickedWorkflow !== undefined"
                                        @click="modeOpen = !modeOpen"
                                        :aria-expanded="modeOpen"
                                        :aria-label="t(`chat.chatPane.agentMode`)"
                                    >
                                        <Icon :name="modeIcon" class="text-2xs text-link" />
                                        <span class="@max-md:hidden">{{ modeLabel }}</span>
                                        <Icon name="chevron-down" class="text-2xs text-subtle" />
                                    </button>

                                    <!-- Placement controls the machine, not the message. -->
                                    <button
                                        v-if="placementShown"
                                        ref="placementPill"
                                        type="button"
                                        class="composer-ghost h-8 shrink-0 gap-1.5 px-2.5 text-2xs font-medium max-md:h-11"
                                        :class="{ 'composer-flash': flashed === 'placement' }"
                                        @click="placementOpen = !placementOpen"
                                        :aria-expanded="placementOpen"
                                        :aria-label="t(`chat.chatPane.whereRuns`)"
                                    >
                                        <Icon :name="remote ? `boxes` : `desktop`" class="text-2xs text-link" />
                                        <span class="@max-lg:hidden">{{ placementLabel }}</span>
                                        <Icon name="chevron-down" class="text-2xs text-subtle" />
                                    </button>

                                    <!-- Persona: who the chat is to the outside world. -->
                                    <button
                                        v-if="inRow.persona"
                                        ref="personaPill"
                                        type="button"
                                        class="composer-ghost h-8 shrink-0 gap-1.5 px-2.5 text-2xs font-medium max-md:h-11"
                                        :class="{
                                            'composer-active': pickedWorkflow === undefined,
                                            'composer-steered': pickedWorkflow !== undefined,
                                            'composer-flash': flashed === 'persona',
                                        }"
                                        :disabled="pickedWorkflow !== undefined"
                                        @click="personaOpen = !personaOpen"
                                        v-tooltip.top="t(`chat.chatPane.chatActsOnlyAccounts`, { personaName })"
                                        :aria-expanded="personaOpen"
                                        :aria-label="t(`chat.chatPane.acts`, { personaName })"
                                    >
                                        <!-- The persona control shows its face when a persona is selected, at the pill size: it clears the row's `h-8`. -->
                                        <PersonaFace v-if="pickedPersona !== undefined" :persona="pickedPersona" :size="FACE_SIZES.pill" />
                                        <Icon v-else name="users" class="text-2xs text-link" />
                                        <span class="max-w-32 truncate">{{ personaName }}</span>
                                        <Icon name="chevron-down" class="text-2xs text-subtle" />
                                    </button>

                                    <!-- Run-through chooses one loop or workflow action. -->
                                    <button
                                        v-if="inRow.runThrough"
                                        ref="runThroughPill"
                                        type="button"
                                        class="composer-active composer-ghost h-8 shrink-0 gap-1.5 px-2.5 text-2xs font-medium max-md:h-11"
                                        :disabled="runningLoop !== undefined && !reachable"
                                        @click="runningLoop ? endLoop() : (runThroughOpen = !runThroughOpen)"
                                        v-tooltip.top="runThroughHint"
                                        :aria-pressed="runningLoop !== undefined"
                                        :aria-expanded="runningLoop ? undefined : runThroughOpen"
                                        :aria-label="runThroughLabel"
                                    >
                                        <Icon :name="runThroughIcon" class="text-2xs text-link" :spin="runningLoop !== undefined" />
                                        <span v-if="runningLoop">{{ runningLoop.iteration }}/{{ runningLoop.maxIterations }}</span>
                                        <template v-else-if="runThroughName !== undefined">
                                            <span class="max-w-32 truncate">{{ runThroughName }}</span>
                                            <Icon name="chevron-down" class="text-2xs text-subtle" />
                                        </template>
                                    </button>

                                    <!-- Voice makes the next send use the agent's voice. -->
                                    <button
                                        v-if="inRow.voice"
                                        type="button"
                                        class="composer-ghost h-8 shrink-0 gap-1.5 px-2.5 text-2xs font-medium max-md:h-11"
                                        :class="{
                                            'composer-active': pickedWorkflow === undefined,
                                            'composer-steered': pickedWorkflow !== undefined,
                                        }"
                                        :disabled="pickedWorkflow !== undefined || editing !== undefined"
                                        @click="voiceAgent = false"
                                        v-tooltip.top="
                                            editing !== undefined
                                                ? t(`chat.chatPane.finishCancelEditFirst`)
                                                : t(`chat.chatPane.writingAgentSendPlaces`)
                                        "
                                        :aria-pressed="true"
                                        :aria-label="t(`chat.chatPane.writingAgent`)"
                                    >
                                        <Icon name="robot" class="text-2xs text-link" />
                                        <span>{{ t(`chat.chatPane.agent`) }}</span>
                                    </button>

                                    <!-- Files from this device; the same chips as a drop or a paste, since one `attach` serves all three. -->
                                    <button
                                        v-if="canDrive"
                                        type="button"
                                        class="composer-ghost h-8 w-8 shrink-0 max-md:h-11 max-md:w-11"
                                        :disabled="!reachable || !connected"
                                        @click="filePicker?.click()"
                                        v-tooltip.top="t(`chat.chatPane.attachFilesDevice`)"
                                        :aria-label="t(`chat.chatPane.attachFiles`)"
                                    >
                                        <Icon name="paperclip" class="text-xs max-md:text-base" />
                                    </button>
                                    <input
                                        ref="filePicker"
                                        type="file"
                                        multiple
                                        class="hidden"
                                        tabindex="-1"
                                        aria-hidden="true"
                                        @change="staging.onPick"
                                    />

                                    <!-- The overflow lists shaping controls that remain at their defaults. -->
                                    <button
                                        v-if="moreRows.length > 0"
                                        ref="morePill"
                                        type="button"
                                        class="composer-ghost h-8 w-8 shrink-0 max-md:h-11 max-md:w-11"
                                        :class="{ 'composer-steered': pickedWorkflow !== undefined }"
                                        :disabled="pickedWorkflow !== undefined"
                                        @click="moreOpen = !moreOpen"
                                        v-tooltip.top="moreHint"
                                        :aria-expanded="moreOpen"
                                        :aria-label="t(`chat.chatPane.moreComposerSettings`)"
                                    >
                                        <Icon name="sliders-h" class="text-xs max-md:text-base" />
                                    </button>

                                    <!-- Hands-free voice: one tap arms it, and the pause is the send (useComposerVoice). -->
                                    <button
                                        v-if="canDrive"
                                        type="button"
                                        class="composer-ghost h-8 w-8 shrink-0 max-md:h-11 max-md:w-11"
                                        :class="{ 'composer-active': voiceOn }"
                                        :disabled="!reachable && !voiceOn"
                                        @click="toggleVoice"
                                        v-tooltip.top="voiceHint"
                                        :aria-pressed="voiceOn"
                                        :aria-label="t(`chat.chatPane.talkHandsFree`)"
                                    >
                                        <Icon
                                            name="microphone"
                                            class="text-xs transition-transform max-md:text-base"
                                            :style="
                                                voiceState === 'listening' ? { transform: `scale(${1 + Math.min(0.5, voiceLevel * 3)})` } : undefined
                                            "
                                        />
                                    </button>

                                    <!-- Stop covers the entire live turn, including parked cards. -->
                                    <button
                                        v-if="streaming"
                                        type="button"
                                        class="composer-send composer-stop shrink-0 max-md:h-11 max-md:w-11"
                                        :disabled="!reachable"
                                        @click="conversation.turn.stop()"
                                        v-tooltip.top="stopHint"
                                        :aria-label="stopLabel"
                                    >
                                        <Icon name="stop" class="text-sm" />
                                    </button>
                                    <!-- Send remains available while a message can be sent. -->
                                    <button
                                        v-if="sendShown"
                                        type="submit"
                                        class="composer-send shrink-0 max-md:h-11 max-md:w-11"
                                        :disabled="!canSend || !reachable"
                                        v-tooltip.top="sendHint"
                                        :aria-label="t(`ui.action.send`)"
                                    >
                                        <Icon name="send" class="text-sm" />
                                    </button>
                                </div>
                            </div>
                        </form>

                        <p v-if="voiceErrorMessage" class="px-1 text-2xs text-danger">{{ voiceErrorMessage }}</p>
                        <p v-if="workflowFailure" class="px-1 text-2xs text-danger">{{ workflowFailure }}</p>
                        <p v-else-if="loopFailure" class="px-1 text-2xs text-danger">{{ loopFailure }}</p>
                        <!-- What the badge changes about the press, said under the box about to do it: the message goes to a design, not this chat. -->
                        <p v-else-if="pickedWorkflow" class="flex items-center gap-1.5 px-1 text-2xs text-muted">
                            <Icon name="sitemap" class="shrink-0 text-2xs text-link" />{{ t(`chat.chatPane.sendStarts`) }}{{ pickedWorkflow.name
                            }}{{ t(`chat.chatPane.messageWhatEveryStep`) }}
                        </p>
                        <!-- The loop badge includes its stop condition. -->
                        <p v-else-if="runThroughState === 'loop' && pickedLoop" class="flex items-center gap-1.5 px-1 text-2xs text-muted">
                            <Icon name="repeat" class="shrink-0 text-2xs text-link" />{{ t(`chat.chatPane.sendLoopsMessageUntil`) }}
                            {{ loopDesignLine(pickedLoop) }}.
                        </p>
                        <!-- Persona capability text appears where the message is written. -->
                        <p v-else-if="personaNotice" class="flex items-center gap-1.5 px-1 text-2xs text-warning">
                            <Icon name="exclamation-circle" class="shrink-0 text-2xs" />{{ personaNotice }}
                        </p>
                    </template>
                </div>
            </div>
        </div>

        <!-- The pane's status bar, the one part of the footer outside the scroller: it's about the pane (context, subscription, daemon liveness), not the message. -->
        <!-- Withheld from the strip, peek or no peek: floating over another page, readouts about a chat are a second row of text
             around a box asked for as one. -->
        <ChatPaneStatus v-if="connected && !strip" :block="refusal" :hint="composerHint" />

        <!-- The four composer menus, each in the app's standard desktop-panel/mobile-sheet swap (ResponsiveOverlay), uncapped in height. -->
        <ResponsiveOverlay v-model="modelOpen" :anchor="modelPill?.el" :header="t(`chat.chatPane.model`)" panel-class="w-[26rem]">
            <ChatModelPicker :conversation="conversation" @selected="modelOpen = false" />
        </ResponsiveOverlay>
        <ResponsiveOverlay v-model="modeOpen" :anchor="modeAnchor" cross="end" :header="t(`chat.chatPane.agentMode`)" panel-class="w-56 p-1">
            <ChatModeMenu @selected="modeOpen = false" />
        </ResponsiveOverlay>
        <ResponsiveOverlay v-model="personaOpen" :anchor="personaAnchor" cross="end" :header="t(`chat.chatPane.acts2`)" panel-class="w-80 p-1">
            <ChatPersonaMenu :picked="conversation.selection.actsAs.value" @picked="pickPersona($event)" />
        </ResponsiveOverlay>
        <ResponsiveOverlay v-model="placementOpen" :anchor="placementPill" cross="end" :header="t(`chat.chatPane.whereRuns`)" panel-class="w-80 p-1">
            <ChatPlacementMenu :conversation="conversation" @selected="placementOpen = false" />
        </ResponsiveOverlay>
        <ResponsiveOverlay
            v-model="runThroughOpen"
            :anchor="runThroughAnchor"
            cross="end"
            :header="t(`chat.chatPane.runMessageThrough`)"
            panel-class="w-80 p-1"
        >
            <ChatRunThroughMenu
                :loop="conversation.loopId.value"
                :workflow="conversation.workflowId.value"
                @loop="pickLoop($event)"
                @workflow="pickWorkflow($event)"
                @manage="manageRunThrough()"
            />
        </ResponsiveOverlay>
        <!-- The overflow itself; its rows hand off to the three panels above. -->
        <ResponsiveOverlay v-model="moreOpen" :anchor="morePill" cross="end" :header="t(`chat.chatPane.message`)" panel-class="w-80 p-1">
            <ComposerMoreMenu :rows="moreRows" @pick="openFromMore($event)" />
        </ResponsiveOverlay>
        <!-- Mounted only while open, so a chat nobody is looking through pictures in computes none of its filmstrip. -->
        <ChatShotViewer
            v-if="shotViewerOpen"
            v-model:open="shotViewerOpen"
            :shots="shotViewerShots"
            :start="shotViewerStart"
            :agent="pictureScope"
            :prompts="shotViewerPrompts"
        />
    </div>
</template>
