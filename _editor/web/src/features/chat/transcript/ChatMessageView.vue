<script setup lang="ts">
import { browserOwnsClick, formatElapsed, MarkdownParts, parseLoopbackLink, useDevice } from "@intentic/ui";
import { useNow } from "@intentic/ui/async";
import { formatClock, formatDateTime } from "@intentic/ui/format";
import { copyCodeFromEvent } from "@intentic/ui/markdown";
import { basename } from "@intentic/ui/path";
import { REQUEST_FIELDS, type RequestField } from "@intentic/sandbox-contract";
import { type Component, computed, nextTick, ref, useTemplateRef, watch } from "vue";
import { attachmentPreview } from "../drafts/attachmentPreviews";
import { useAgents } from "../../agents/fleet/useAgents";
import { errandOf } from "../run/errands";
import { chatRouteWait } from "../routing/chatRoute";
import { changedNothing, type ChatMessage, type ChecklistView, continuationKind, foldsIntoTurn } from "./transcript";
import { pinPrompt } from "./promptPins";
import { watchClamp } from "./clampWatch";
import { type CardAnswer, requestIdOf } from "../session/cardReplies";
import { useMarkdown } from "../../../lib/markdown/useMarkdown";
import { openFileRefFromEvent } from "../../workspace/files/refs/openFileRef";
import { claimInText, openClaimed, openClaimedLinkFromEvent } from "../../../workbench/side/sideLinks";
import { openLoopbackPreview } from "../../terminal/portPreview";
import { usePaneView } from "../panel/useChat-view";
import ChatAttachmentStrip from "../composer/ChatAttachmentStrip.vue";
import ChatBrowserHelpCard from "./cards/ChatBrowserHelpCard.vue";
import ChatCapabilityCard from "./cards/ChatCapabilityCard.vue";
import NeedCard from "../../needs/NeedCard.vue";
import ChatCredentialCard from "./cards/ChatCredentialCard.vue";
import ChatPaymentCard from "./cards/ChatPaymentCard.vue";
import ChatPermissionCard from "./cards/ChatPermissionCard.vue";
import ChatPlanCard from "./cards/ChatPlanCard.vue";
import ChatQuestionCard from "./cards/ChatQuestionCard.vue";
import ChatTerminalHelpCard from "./cards/ChatTerminalHelpCard.vue";
import ChatJobRow from "./ChatJobRow.vue";
import ChatAsideLane from "./asides/ChatAsideLane.vue";
import ChatNotes from "./asides/ChatNotes.vue";
import ChatTodoList from "./ChatTodoList.vue";
import ChatTurnAsides from "./asides/ChatTurnAsides.vue";
import ChatTurnStatus from "./ChatTurnStatus.vue";
import NoticeDepsInstall from "./notices/NoticeDepsInstall.vue";
import NoticeHeld from "./notices/NoticeHeld.vue";
import NoticeLandHold from "./notices/NoticeLandHold.vue";
import NoticeMemory from "./notices/NoticeMemory.vue";
import NoticeWatchStop from "./notices/NoticeWatchStop.vue";
import { isMemoryHold } from "./held/heldQueue";
import { noticeLine } from "./notices/sandboxNotice";
import { useAudience } from "../../../app/useAudience";
import { useT } from "@intentic/ui/i18n";

// Renders one transcript entry (user bubble, notice line, or assistant turn stack). Card answers go through the pane's
// conversation (CardReplies); per-message UI state lives here.

const t = useT();

const props = defineProps<{
    message: ChatMessage;
    streaming: boolean;
    // Messages folded into this turn (continue-nudges, errands), set only on the opening message (ChatTurn.folded).
    folded?: readonly ChatMessage[];
    // Row would be discarded by the pending edit (ChatPane's `doomed`); a preview only, not an actual state change.
    doomed?: boolean;
    // How this row's checklist snapshot draws (transcript.ts); absent draws the list in full.
    checklistView?: ChecklistView;
    // Rows follow this live bubble, so the column's foot draws the turn's status line rather than this bubble.
    statusBelow?: boolean;
}>();

// A snapshot that moved nothing is not a checklist event, so it draws no line at all — not an empty one.
const showsTodos = computed(
    () => (props.message.todos?.length ?? 0) > 0 && !(props.checklistView !== undefined && changedNothing(props.checklistView)),
);

const { conversation, awaitingDecision, editing, streaming: conversationStreaming, ending } = usePaneView();

// The card this row holds, if any: every button on it answers through the chat's one reply (CardReplies).
const requestId = computed(() => requestIdOf(props.message));
// Gates a card's other buttons while one answer is in flight; the pressed button already holds itself (kit's Button).
const settling = computed(() => requestId.value !== undefined && conversation.value.requests.isReplying(requestId.value));
const reply = async (answer: CardAnswer): Promise<void> => {
    if (requestId.value !== undefined) {
        await conversation.value.requests.reply(requestId.value, answer);
    }
};

// The card each request field is drawn as, as cardReplies' FIELD_OF names the answers; a row holds at most one.
const CARDS: Readonly<Record<RequestField, Component>> = {
    plan: ChatPlanCard,
    question: ChatQuestionCard,
    permission: ChatPermissionCard,
    browserHelp: ChatBrowserHelpCard,
    terminalHelp: ChatTerminalHelpCard,
    capabilityOffer: ChatCapabilityCard,
    paymentOffer: ChatPaymentCard,
    credentialOffer: ChatCredentialCard,
};
const card = computed(() => REQUEST_FIELDS.find((field) => props.message[field] !== undefined));

// The follow-up each notice action offers; each decides for itself whether it still stands. A low-memory hold is not
// here: it draws its whole row (NoticeMemory), since its sentence is the sandbox's numbers and belongs a hover away.
const NOTICE_ACTIONS: Readonly<Record<Exclude<NonNullable<ChatMessage["noticeAction"]>, `sendAnyway` | `sandboxMemory`>, Component>> = {
    landHold: NoticeLandHold,
    depsInstall: NoticeDepsInstall,
    watchStop: NoticeWatchStop,
    sendAgain: NoticeHeld,
};
const noticeAction = computed(() => {
    const action = props.message.noticeAction;
    return action === undefined || action === `sendAnyway` || action === `sandboxMemory` ? undefined : NOTICE_ACTIONS[action];
});

const { mobile } = useDevice();

// The outside condition this row's wait is about, while it is still armed (AgentSummary.watches), named by id.
const { agentById } = useAgents();
const armedWatch = computed(() => {
    const id = props.message.noticeWaitId;
    return id === undefined ? undefined : agentById(conversation.value.conversationId)?.watches?.find((armed) => armed.id === id);
});

// One renderer per message, held for the component's life; file links resolve in the chat's own checkout.
// The words through a computed: a tool or thinking patch replaces the row object with the same text, and a computed
// that returns an equal string wakes nothing, so the live bubble's tail is not re-parsed for a frame that did not write.
const words = computed(() => props.message.text);
const body = useMarkdown(
    words,
    () => props.streaming,
    () => conversation.value.scope.value,
);

// Delegated listener for markdown's copy buttons, file links and links a side view claims (inside v-html); bound to
// press, since a live rerender can destroy the button before click fires.
const onMarkdownClick = (event: MouseEvent): void => {
    copyCodeFromEvent(event);
    openFileRefFromEvent(event);
    openClaimedLinkFromEvent(event);
    // What no side view claimed, and no modified click (the browser's own), falls to the loopback rule below.
    if (event.defaultPrevented || event.button !== 0 || browserOwnsClick(event)) {
        return;
    }
    // A `localhost` link an agent wrote names the sandbox's own loopback, dead from here: opened through the sandbox's
    // forwarded port instead, as the terminal does.
    const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>(`a[href]`) : null;
    const local = link === null ? undefined : parseLoopbackLink(link.href);
    if (local !== undefined) {
        event.preventDefault();
        openLoopbackPreview(local);
    }
};

// Status line shows for the whole live turn, not just before the first token, since the model can go quiet
// mid-tool-call. Reads the conversation's streaming flag, not this message's. A turn a person ended shows it too, parked
// or not: that line is where the ending is said.
const showTyping = computed(() => props.streaming && !props.statusBelow && (!awaitingDecision.value || ending.value !== undefined));

// Still being written into: live, and nobody has ended the turn. A Stop takes every spinner in the bubble down at the
// press (a tool still letting go reads unfinished, as it will once settled); whatever the stream's tail still brings is
// drawn all the same.
const live = computed(() => props.streaming && ending.value === undefined);

// Wait shown by this notice while running (ChatMessage.noticeWait); undefined once it ends. Each kind is asked of
// whoever owns that wait, since none of them is a field on the row.
type PendingWait = { readonly at: number; readonly counts: "up" | "down" } | undefined;
// An instant that may not exist yet: a wait nobody owns any more has no clock, which is how a settled row stops
// ticking without the row itself being rewritten.
const clock = (instant: number | undefined, counts: "up" | "down"): PendingWait => (instant === undefined ? undefined : { at: instant, counts });

const pendingWait = computed<PendingWait>(() => {
    switch (props.message.noticeWait) {
        case `credentialRenewal`:
            return clock(conversation.value.failures.credentialRenewal.value?.since, `up`);
        case `chatRoute`:
            return clock(chatRouteWait(conversation.value)?.since, `up`);
        case `watch`:
            // Counts down, like the board's own watch clock: the deadline is the next moment this conversation
            // definitely moves, and how long it has already waited says nothing about that.
            return clock(armedWatch.value?.deadlineAt, `down`);
        default:
            return undefined;
    }
});

// Clock for a pending notice wait only; stops once the wait ends.
const now = useNow(() => pendingWait.value !== undefined);
const waitClock = computed(() => {
    const wait = pendingWait.value;
    if (wait === undefined) {
        return undefined;
    }
    return wait.counts === `up` ? formatElapsed((now.value - wait.at) / 1000) : formatElapsed((wait.at - now.value) / 1000);
});

// What the model was told, for a row nobody at the composer typed; one press away.
const watchEvidence = ref(false);
const unspokenSent = computed(() => props.message.watchWake?.sent ?? props.message.needWake?.sent ?? props.message.agentWords?.sent);
// A watch that never saw its condition, or a child that failed, calls for a different next step.
const watchGaveUp = computed(
    () => (props.message.watchWake !== undefined && props.message.watchWake.outcome !== `met`) || props.message.agentWords?.failed === true,
);
// A notice in the reader's language and words where the row says which one it is (sandboxNotice.ts), else as it was
// written: a sandbox older than this app sends no code, and a newer one may send a code this build does not know.
const { audience } = useAudience();
const noticeText = computed(() => noticeLine(props.message, audience.value) ?? props.message.text);
// A notice the runtime's own extension or loop said (sandbox-contract events/agent-ui.ts): its level's glyph and colour.
// An info line stays the muted notice every other row is; only a warning or an error is drawn louder.
const AGENT_NOTICE_LOOK = {
    info: { icon: `info-circle`, tone: `text-subtle` },
    warning: { icon: `exclamation-triangle`, tone: `text-warning` },
    error: { icon: `exclamation-circle`, tone: `text-danger` },
} as const;
const agentNoticeLook = computed(() => (props.message.agentNotice === undefined ? undefined : AGENT_NOTICE_LOOK[props.message.agentNotice.level]));
// The board's own watch glyph, another conversation, or a child reporting back.
const noticeIcon = computed(() => {
    if (agentNoticeLook.value !== undefined) {
        return agentNoticeLook.value.icon;
    }
    if (props.message.watchWake !== undefined) {
        return `eye`;
    }
    // An answered need: the same glyph as its card, so the two read as one thread.
    if (props.message.needWake !== undefined) {
        return props.message.needWake.outcome === `met` ? `check-circle` : `times`;
    }
    if (props.message.agentWords !== undefined) {
        return props.message.agentWords.kind === `peer` ? `comments` : `users`;
    }
    return `info-circle`;
});

// Edit pencil shows only for a user prompt with a rewindIndex, never mid-turn (agent/rewind.ts), and never while this
// message's own edit is open.
const editable = computed(
    () =>
        props.message.role === `user` &&
        props.message.rewindIndex !== undefined &&
        !conversationStreaming.value &&
        editing.value?.id !== props.message.id,
);

const startEdit = (): void => {
    conversation.value.transcript.beginEdit(props.message);
};

// Clamp overflow (.chat-prompt-text) depends on wrap width, so it's measured via ResizeObserver, not guessed from text.
const bubble = useTemplateRef<HTMLElement>(`bubble`);
const overflowing = ref(false);
const expanded = ref(false);
// Measured with every other prompt's in one pass (clampWatch.ts), skipped while expanded: the box always fits then, and
// remeasuring would clear the collapse flag.
watch(
    bubble,
    (element, _previous, onCleanup) => {
        if (element === null) {
            overflowing.value = false;
            return;
        }
        onCleanup(watchClamp(element, { skip: () => expanded.value, answer: (value) => (overflowing.value = value) }));
    },
    { immediate: true, flush: `post` },
);

// Folded messages never pin, since sticking one would cover the prompt it defers to.
const defers = computed(() => foldsIntoTurn(props.message));

// An errand is a prompt the app sent on the user's behalf (errands.ts): named in one quiet line, since a turn nobody
// typed still has to appear as a turn, with the words it actually sent out on the mark beside it.
const errand = computed(() => errandOf(props.message));
const errandMarks = computed(() =>
    errand.value === undefined
        ? []
        : [{ key: `errand`, icon: errand.value.icon, label: errand.value.label, tip: t(`chat.chatMessageView.showPrompt`), findable: true }],
);

// What an errand is about, when its prompt names something a side view can show (a ci-fix errand's failing run): one
// press on its line opens it beside the chat, so the conversation fixing it and the thing it fixes share a screen.
const errandSubject = computed(() => (errand.value === undefined ? undefined : claimInText(props.message.text)));
// A prompt as the reader sees it: the app's own "Continue" (sent in English, the words the agent reads) in the reader's
// language, anything the user typed as typed.
const promptText = (message: ChatMessage): string => {
    const kind = message.role === `user` ? continuationKind(message.text) : undefined;
    if (kind === `plain`) {
        return t(`ui.action.continue`);
    }
    return kind === `afterDenial` ? t(`chat.chatMessageView.continueWithoutDeclined`) : message.text;
};

// Trailer naming the latest thing keeping this turn going, and how many said the same; shown in-flow so it can't shift
// the pinned row's height.
const foldedLabel = (message: ChatMessage): string => errandOf(message)?.label ?? promptText(message).trim();
const trailer = computed(() => {
    const folded = props.folded ?? [];
    const last = folded.at(-1);
    if (last === undefined) {
        return undefined;
    }
    const label = foldedLabel(last);
    return { label, count: folded.filter((message) => foldedLabel(message) === label).length };
});

// Pinned state (.chat-prompt-pinned): whether the prompt is actually stuck, which CSS can't ask. Measured by the
// scroller's one watcher over all its prompts (promptPins.ts), not by one per prompt.
const row = useTemplateRef<HTMLElement>(`row`);
const pinned = ref(false);

watch(
    row,
    (element, _previous, onCleanup) => {
        pinned.value = false;
        if (element === null || props.message.role !== `user` || defers.value) {
            return;
        }
        // The row's only valid pin anchor is `.chat-scroller`.
        const scroller = element.closest<HTMLElement>(`.chat-scroller`);
        if (scroller === null) {
            return;
        }
        // One prompt pins per turn, so the turn's `--chat-pin` has one writer.
        const host = element.closest<HTMLElement>(`.chat-pin-host`);
        onCleanup(pinPrompt(scroller, { element, host, pinned: (value) => (pinned.value = value) }));
    },
    { immediate: true, flush: `post` },
);

// The character at the middle of a box, as a live one-character range: find-in-page centres its match there.
const middleOf = (element: HTMLElement): Range | undefined => {
    const box = element.getBoundingClientRect();
    const [x, y] = [box.left + box.width / 2, box.top + box.height / 2];
    const page = element.ownerDocument;
    const range = page.createRange();
    // WebKit has only the older caretRangeFromPoint.
    if (typeof page.caretPositionFromPoint === `function`) {
        const position = page.caretPositionFromPoint(x, y);
        if (position === null) {
            return undefined;
        }
        range.setStart(position.offsetNode, position.offset);
    } else {
        const caret = page.caretRangeFromPoint(x, y);
        if (caret === null) {
            return undefined;
        }
        range.setStart(caret.startContainer, caret.startOffset);
    }
    // nodeType, not instanceof Text: a popped-out window's nodes belong to its own realm.
    const node = range.startContainer;
    if (node.nodeType !== Node.TEXT_NODE || !element.contains(node)) {
        return undefined;
    }
    range.setEnd(node, Math.min(range.startOffset + 1, node.textContent?.length ?? 0));
    return range;
};

// A clamped box has no scrollbar, so any scroll event means find-in-page or a screen reader jumped inside it: open it
// and scroll the spot it jumped to back into the middle, since opening re-wraps a stuck prompt's one line.
const onBubbleScroll = (): void => {
    const element = bubble.value;
    if (expanded.value || element === null || (element.scrollTop === 0 && element.scrollLeft === 0)) {
        return;
    }
    const spot = middleOf(element);
    expanded.value = true;
    void nextTick(() => {
        const rect = spot?.getBoundingClientRect();
        if (rect === undefined || rect.height === 0) {
            return;
        }
        element.scrollTop += rect.top + rect.height / 2 - element.getBoundingClientRect().top - element.clientHeight / 2;
    });
};

// Clicking a clamped bubble expands it, one direction only; guarded on an active selection so dragging text doesn't
// trigger it.
const onBubbleClick = (): void => {
    // Reads the bubble's own window's selection, since a popped-out window has its own.
    const selection = bubble.value?.ownerDocument.defaultView?.getSelection() ?? window.getSelection();
    if (expanded.value || !overflowing.value || selection?.isCollapsed === false) {
        return;
    }
    expanded.value = true;
};

const toggleExpanded = (): void => {
    expanded.value = !expanded.value;
    // Reset scroll before the clamp reapplies, or the leftover offset re-triggers onBubbleScroll's find-in-page
    // detection.
    if (!expanded.value && bubble.value !== null) {
        bubble.value.scrollTop = 0;
        bubble.value.scrollLeft = 0;
    }
};

// Resolves thumbnails by path: an object URL minted here if staged locally, else re-minted from workspace bytes.
const attachmentThumbs = computed(() =>
    (props.message.attachments ?? []).map((path) => ({
        name: basename(path),
        path,
        previewUrl: attachmentPreview(path),
    })),
);

// Whether a single image attachment may sit beside the prompt instead of stacking above it (width is handled separately
// by the @lg container query):
// - exactly one attachment, since beside costs only the taller of the two
// - an image, since anything else is a filename chip that needs its own width
// - a prompt to align against
const attachmentsAside = computed(
    () => props.message.text.length > 0 && attachmentThumbs.value.length === 1 && attachmentThumbs.value[0]?.previewUrl !== undefined,
);

// Absolute wall-clock minute label ("14:32"); day is omitted since ChatPane's day markers already show it (full
// date/time in the tooltip). Undefined with no sentAt.
const sentClock = computed(() => (props.message.sentAt === undefined ? undefined : formatClock(props.message.sentAt)));
const sentExact = computed(() => (props.message.sentAt === undefined ? undefined : formatDateTime(props.message.sentAt)));
</script>

<template>
    <!-- Delegated markdown controls (copy buttons, file links), since both live inside v-html. -->
    <!-- A folded message renders like any other row: no pin, no extra inset. -->
    <!-- Blocks within a message share the transcript's own gap (.chat-stack, --chat-gap). -->
    <div
        ref="row"
        class="chat-message chat-stack flex flex-col"
        :class="{
            'chat-prompt': message.role === 'user' && !defers,
            // The rows that host the pencil, which is the same set `items-end` names below: the user speaking,
            // in a bubble. It hangs in the gutter, OUTSIDE this row's box, and .chat-message paint-contains the
            // row — see .chat-gutter-host in chat.css for what that did to it.
            'chat-gutter-host': message.role === 'user' && errand === undefined,
            // Everything the user's side sent — typed or on their behalf — hangs off the same edge.
            'items-end': message.role === 'user',
            'chat-prompt-open': expanded,
            'chat-prompt-pinned': pinned,
            'chat-doomed': doomed,
        }"
        @click="onMarkdownClick"
        @pointerdown="copyCodeFromEvent"
    >
        <!-- One line on the mark's own bar, worded as the trailer a FOLDED errand leaves on the prompt above it, so a
             turn nobody typed reads the same whichever way it landed. -->
        <ChatAsideLane v-if="errand" :marks="errandMarks">
            <span class="min-w-0 truncate text-2xs text-subtle">↳ {{ errand.label }} · {{ errand.detail }}</span>
            <button
                v-if="errandSubject !== undefined"
                type="button"
                class="ui-chip shrink-0 gap-1 rounded-md px-1.5 py-0.5 text-2xs font-medium"
                v-tooltip.top="t(`chat.chatMessageView.openBeside`)"
                @click="openClaimed(errandSubject)"
            >
                <Icon name="expand" class="text-2xs" />
                {{ errandSubject.label }}
            </button>
            <template #errand>
                <!-- Uncapped: the lane's material around it is the capped scroll box. -->
                <pre class="chat-inset px-2.5 py-1.5 text-2xs leading-relaxed whitespace-pre-wrap">{{ message.text }}</pre>
            </template>
        </ChatAsideLane>
        <div v-else-if="message.role === 'user'" class="group relative flex max-w-[85%] flex-col items-end gap-1.5">
            <!-- Attachments stack above the prompt when they cannot fit beside it. -->
            <ChatAttachmentStrip
                v-if="attachmentThumbs.length"
                :attachments="attachmentThumbs"
                class="flex-wrap justify-end"
                :class="attachmentsAside && '@lg:hidden'"
            />
            <!-- A stuck prompt is ONE NOWRAP LINE, whose min-content is the whole prompt — and min-content is the floor
                 of `fit-content`, so this row would size itself to the entire message and paint across the pane.
                 `max-w-full` is the definite clamp that beats that floor (percentages resolve against the 85% column
                 above); `min-w-0` on the frame is what then lets it shrink to the clamp. Both inert while it wraps. -->
            <div class="flex max-w-full items-center gap-1">
                <!-- Beside-prompt thumbnail once the panel is wide enough (attachmentsAside gates it): costs only the taller element. -->
                <ChatAttachmentStrip v-if="attachmentsAside" :attachments="attachmentThumbs" class="mr-1 hidden shrink-0 self-start @lg:flex" />
                <!-- The frame owns positioning for the fade and toggle chip. -->
                <div
                    v-if="message.text"
                    class="chat-surface relative min-w-0 rounded-lg"
                    :class="{ 'chat-prompt-clamped': overflowing && !expanded }"
                >
                    <div
                        ref="bubble"
                        class="chat-prompt-text whitespace-pre-wrap px-3 py-2 text-xs leading-relaxed text-content"
                        :class="{ 'cursor-pointer': overflowing && !expanded }"
                        @scroll="onBubbleScroll"
                        @click="onBubbleClick"
                    >
                        {{ promptText(message) }}
                    </div>
                    <!-- Shown only when the clamp cut the text. -->
                    <button
                        v-if="overflowing"
                        type="button"
                        class="chat-prompt-toggle"
                        :aria-expanded="expanded"
                        :aria-label="expanded ? t(`chat.chatMessageView.collapseMessage`) : t(`chat.chatMessageView.expandMessage`)"
                        @click="toggleExpanded"
                    >
                        <Icon :name="expanded ? 'chevron-up' : 'chevron-down'" class="text-2xs" />
                    </button>
                </div>
            </div>
            <!-- Sent-time label sits in the margin beside the bubble, visible only on hover, so it costs no row height. -->
            <span
                v-if="sentClock"
                v-tooltip.top="sentExact"
                class="absolute inset-y-0 right-full mr-2 flex items-center text-2xs whitespace-nowrap tabular-nums text-subtle opacity-0 transition-opacity group-hover:opacity-100"
                >{{ sentClock }}</span
            >
            <!-- Edit pencil sits in the gutter's own column (the fork mark's lane), costing no width. -->
            <button
                v-if="editable"
                type="button"
                class="absolute top-0 left-full flex h-7 w-[var(--chat-gutter)] cursor-pointer items-center justify-center rounded-md text-subtle transition-opacity hover:bg-overlay hover:text-content"
                :class="mobile ? `opacity-40` : `opacity-0 focus-visible:opacity-100 group-hover:opacity-100`"
                v-tooltip.right="{ title: t(`chat.chatMessageView.editMessageShort`), note: t(`chat.chatMessageView.replacesWhatFollows`) }"
                :aria-label="t(`chat.words.editMessage`)"
                @click.stop="startEdit"
            >
                <Icon name="pencil" class="text-2xs" />
            </button>
        </div>
        <!-- A background job's start: its own row, since what matters about it (running, done, failed) is still changing. -->
        <ChatJobRow v-else-if="message.role === 'notice' && message.backgroundJob" :job="message.backgroundJob" />
        <!-- A low-memory hold: one line, whether it still holds a message or only says it once did. -->
        <NoticeMemory v-else-if="isMemoryHold(message)" :message="message" />
        <!-- Something the agent asked a person for: a card of its own, drawn from the need's live state, which outlives the turn (docs/architecture/needs.md). -->
        <NeedCard v-else-if="message.role === 'notice' && message.need" :need-id="message.need.id" :snapshot="message.need" />
        <div
            v-else-if="message.role === 'notice' && message.text !== ''"
            class="flex flex-wrap items-center justify-center gap-x-2 gap-y-0.5 self-center py-0.5 text-2xs"
            :class="watchGaveUp ? `text-danger` : (agentNoticeLook?.tone ?? `text-subtle`)"
            :data-agent-notice="message.agentNotice?.level"
        >
            <!-- Mark, sentence and clock are one non-wrapping group inside the wrapping row: a sentence wider than the pane must wrap inside its own span. -->
            <span class="flex min-w-0 items-center gap-x-2">
                <!-- Spins and shows the wait's clock while it runs, then settles to a plain line (ChatMessage.noticeWait). -->
                <!-- A mark set at the row's own 11px has no counter left to read; both glyphs take a step up from the sentence. -->
                <Icon v-if="pendingWait" name="spinner" spin class="shrink-0 text-xs text-info" />
                <!-- The board's own watch glyph, so one conversation's watch reads the same in both places. -->
                <Icon v-else :name="noticeIcon" class="shrink-0 text-xs" />
                <!-- Who said it, when the runtime named an extension: its words are not the sandbox's. -->
                <span class="min-w-0" :class="{ 'whitespace-pre-line': message.agentNotice }"
                    ><span v-if="message.agentNotice?.source" class="font-medium">{{ message.agentNotice.source }}: </span>{{ noticeText }}</span
                >
                <span v-if="waitClock" class="shrink-0 tabular-nums">{{ waitClock }}</span>
            </span>
            <!-- Nobody at the composer typed it, so what the model was told is one press away. -->
            <button
                v-if="unspokenSent !== undefined"
                type="button"
                class="shrink-0 font-medium text-link hover:underline"
                :aria-expanded="watchEvidence"
                @click="watchEvidence = !watchEvidence"
            >
                <template v-if="message.watchWake">{{
                    watchEvidence ? t(`chat.chatMessageView.hideCheck`) : t(`chat.chatMessageView.showCheck`)
                }}</template>
                <template v-else>{{ watchEvidence ? t(`chat.chatMessageView.hideMessage`) : t(`chat.chatMessageView.showMessage`) }}</template>
            </button>
            <pre
                v-if="watchEvidence && unspokenSent !== undefined"
                class="chat-inset max-h-64 w-full overflow-auto px-2.5 py-1.5 text-left text-2xs leading-relaxed whitespace-pre-wrap text-subtle"
                >{{ unspokenSent }}</pre>
            <!-- The one follow-up this notice offers, by its action's name (NOTICE_ACTIONS). -->
            <component :is="noticeAction" v-if="noticeAction" :message="message" />
        </div>
        <template v-else>
            <!-- Live marks the bubble currently receiving streamed text. -->
            <ChatTurnAsides :thinking="message.thinking" :tools="message.tools" :live="live" />

            <ChatTodoList v-if="showsTodos" :todos="message.todos!" :live="live" :view="checklistView" />

            <!-- Markdown parts preserve settled DOM while the live tail updates. -->
            <div v-if="message.text" class="md-prose chat-markdown chat-surface-assistant w-full rounded-lg px-3.5 py-2.5">
                <MarkdownParts :parts="body" />
            </div>
            <!-- Marks a message the user wrote in the agent's voice (composer "as agent"); the agent itself never sees this flag. -->
            <p
                v-if="message.placed"
                class="flex items-center gap-1 px-1 text-2xs text-subtle"
                v-tooltip.top="{ title: t(`chat.chatMessageView.agentsVoice`), note: t(`chat.chatMessageView.readAsItsOwn`) }"
            >
                <Icon name="pencil" class="text-2xs" />{{ t(`chat.chatMessageView.placedBy`) }}
            </p>

            <!-- The card this row holds, by its field (CARDS); every answer goes through the chat's one reply. -->
            <component :is="CARDS[card]" v-if="card" :message="message" :settling="settling" :reply="reply" />

            <!-- Same component ChatPane mounts at the column's foot for a turn with no bubble yet — one spinner, one status line. -->
            <ChatTurnStatus v-if="showTyping" />
        </template>

        <!-- Trailer belongs to the turn's opener, whatever it turned out to be (prompt, errand, or restored assistant text). -->
        <span v-if="trailer" class="text-2xs text-subtle"
            >↳ {{ trailer.label }}<template v-if="trailer.count > 1"> ×{{ trailer.count }}</template></span
        >
    </div>

    <!-- Its own row, not part of the bubble above: a pinned prompt charges its whole height against reading room. -->
    <!-- `chat-notes-row`: shut, no row at all, its paperclip standing up beside the message in the left gutter (chat.css). -->
    <div
        v-if="message.notes?.length"
        class="chat-message chat-notes-row chat-stack flex flex-col"
        :class="{ 'chat-doomed': doomed, 'chat-notes-row-trailed': trailer }"
    >
        <ChatNotes :notes="message.notes" />
    </div>
</template>
