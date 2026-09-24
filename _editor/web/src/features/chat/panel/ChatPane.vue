<script setup lang="ts">
import { FACE_SIZES, Icon, Notice, PersonaFace, ResponsiveOverlay, useDevice } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, provide, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { loopDesignLine } from "@intentic/sandbox-contract";
import type { Conversation } from "../session/conversation";
import { useChat } from "../run/useChat";
import { conversationView, PANE_VIEW } from "./useChat-view";
import { useChatRoute } from "../routing/chatRoute";
import { useRole } from "../../sandbox/secrets/useRole";
import { useChatAttachments } from "../drafts/useChatAttachments";
import { useComposerVoice } from "../composer/useComposerVoice";
import { useEditorContextChip } from "../composer/useEditorContextChip";
import { useRunThrough } from "../models/run-settings/useRunThrough";
import { isBlocked } from "../../sandbox/live/connection";
import { useSandbox } from "../../sandbox/client/useSandbox";
import { usePaneAttach } from "./pane/paneAttach";
import { usePaneFocus } from "./pane/paneFocus";
import { usePaneScroll } from "./pane/paneScroll";
import { paneSurface } from "./pane/paneSurface";
import { CHAT_SURFACE } from "../tools/chatToolSurface";
import ChatPaneTurns from "./pane/ChatPaneTurns.vue";
import ChatEditNotice from "./pane/ChatEditNotice.vue";
import ChatPaneEmpty from "./pane/ChatPaneEmpty.vue";
import { useComposerSize } from "./pane/composerSize";
import { useComposerControls } from "./pane/composerControls";
import { usePanePersona } from "./pane/panePersona";
import { useComposerSend } from "./pane/composerSend";
import { useComposerPopovers } from "./pane/composerPopovers";
import { useComposerKeys, useRecallRing } from "./pane/composerKeys";
import ChatCommandPopover from "../composer/ChatCommandPopover.vue";
import ChatContinueStrip from "./ChatContinueStrip.vue";
import ChatLeftRunning from "./ChatLeftRunning.vue";
import ChatQueue from "../composer/ChatQueue.vue";
import ChatAttachmentStrip from "../composer/ChatAttachmentStrip.vue";
import ChatMentionPopover from "../composer/ChatMentionPopover.vue";
import ChatModelPicker from "../models/ChatModelPicker.vue";
import ChatModeMenu from "../models/run-settings/ChatModeMenu.vue";
import ChatPlacementMenu from "./ChatPlacementMenu.vue";
import ChatPaneNotices from "./ChatPaneNotices.vue";
import ChatPaneStatus from "./ChatPaneStatus.vue";
import ChatPersonaMenu from "../personas/ChatPersonaMenu.vue";
import ChatRunThroughMenu from "../models/run-settings/ChatRunThroughMenu.vue";
import ComposerEffort from "../composer/ComposerEffort.vue";
import ComposerModelPill from "../composer/ComposerModelPill.vue";
import ComposerMoreMenu from "../composer/ComposerMoreMenu.vue";

// One chat on screen: the transcript, its composer, and the pickers/banners for one conversation (ChatPanel owns
// the surrounding frame — list, pop-out, resize, shell commands). Takes its conversation as a prop rather than
// reading the focused one, and provides `conversationView` once so everything under it answers for the same chat.
// Turns, banners, edit notice and status are components; presses, the control row, the lists and keys are `pane/` composables.

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
const { messages, streaming, mode, provider, model, draft, attachments, staged, connected, editing } = paneView;
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

provide(
    CHAT_SURFACE,
    paneSurface(() => props.conversation, useRouter()),
);

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
const { continueStrip, continueOffer, canSend, refusal, sendShown, composerPlaceholder, sendHint, stopLabel, stopHint, submit, continueTurn } =
    useComposerSend({
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
        words: computed(() => ({
            provider: providerName.value,
            onTrial: onTrial.value,
            editDropped: props.conversation.transcript.doomed.value.size,
        })),
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
                <ChatPaneTurns v-if="!bare">
                    <template #empty>
                        <ChatPaneEmpty :unset="modelReading.unset" :on-trial="onTrial" :provider-name="providerName" />
                    </template>
                </ChatPaneTurns>

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
                        <!-- The turn is over, but the chat is not: what it left running, and the watches it armed (ChatLeftRunning). -->
                        <ChatLeftRunning />
                        <!-- What waits for the next turn: the conversation's queue, the same in every window. -->
                        <ChatQueue />
                        <!-- An armed edit, and the two ways out of it. -->
                        <ChatEditNotice />
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
                            <ChatAttachmentStrip
                                v-if="attachments.length > 0 || editorChip"
                                :attachments="attachments"
                                staged
                                class="flex-wrap px-3 pt-3"
                                @remove="staging.remove"
                            >
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
                            </ChatAttachmentStrip>
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
                                        :aria-label="t(`shared.agentMode`)"
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
                                        :aria-label="t(`shared.whereRuns`)"
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
        <ResponsiveOverlay v-model="modelOpen" :anchor="modelPill?.el" :header="t(`shared.model`)" panel-class="w-[26rem]">
            <ChatModelPicker :conversation="conversation" @selected="modelOpen = false" />
        </ResponsiveOverlay>
        <ResponsiveOverlay v-model="modeOpen" :anchor="modeAnchor" cross="end" :header="t(`shared.agentMode`)" panel-class="w-56 p-1">
            <ChatModeMenu @selected="modeOpen = false" />
        </ResponsiveOverlay>
        <ResponsiveOverlay v-model="personaOpen" :anchor="personaAnchor" cross="end" :header="t(`shared.acts`)" panel-class="w-80 p-1">
            <ChatPersonaMenu :picked="conversation.selection.actsAs.value" @picked="pickPersona($event)" />
        </ResponsiveOverlay>
        <ResponsiveOverlay v-model="placementOpen" :anchor="placementPill" cross="end" :header="t(`shared.whereRuns`)" panel-class="w-80 p-1">
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
    </div>
</template>
