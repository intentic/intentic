<script setup lang="ts">
import { MarkdownFigure, useDevice, ui } from "@intentic/ui";
import { useNow } from "@intentic/ui/async";
import { formatClock, formatDateTime } from "@intentic/ui/format";
import { copyCodeFromEvent } from "@intentic/ui/markdown";
import { basename } from "@intentic/ui/path";
import { CAPABILITY_CATALOG } from "@intentic/capability-catalog";
import { type CardDocument, planParts, type TranscriptPlan, type TranscriptTerminalHelp } from "@intentic/sandbox-contract";
import { computed, ref, useTemplateRef, watch } from "vue";
import { useRouter } from "vue-router";
import { useQueryClient } from "@tanstack/vue-query";
import { attachmentPreview } from "../drafts/attachmentPreviews";
import { effectiveAutoLand, effectiveOutageResume, formatElapsed } from "../../agents/fleet/agentStatus";
import { useAgents } from "../../agents/fleet/useAgents";
import { errandOf } from "../run/errands";
import { personaRouteWait } from "../personas/personaRoute";
import { modelRouteWait } from "../models/modelRoute";
import { changedNothing, type ChatMessage, type ChecklistView, foldsIntoTurn } from "./transcript";
import { navigateInApp } from "../../../shell/window/mainWindow";
import { useMarkdown } from "../../../lib/markdown/useMarkdown";
import { openFileRefFromEvent } from "../../workspace/files/openFileRef";
import { invalidateWorkspace } from "../../workspace/changes/history/useHistory";
import { usePaneView } from "../panel/useChat-view";
import { landsByDefault } from "../../sandbox/environment/rules";
import { useSandboxSettings } from "../../sandbox/overview/useSandboxSettings";
import { openWorkTerminal, useWorkTerminals } from "../../terminal/useWorkTerminals";
import { useTerminalPanel } from "../../terminal/useTerminalPanel";
import { useSandboxSession } from "../../sandbox/session/sandboxSession";
import ChatAttachmentStrip from "../composer/ChatAttachmentStrip.vue";
import ChatCard from "./cards/ChatCard.vue";
import ChatCommandBlock from "../tools/ChatCommandBlock.vue";
import ChatDecisionButton from "./cards/ChatDecisionButton.vue";
import ChatDocumentBody from "./cards/ChatDocumentBody.vue";
import { capabilityStatus, credentialLane, helpStatus, offerStatus, permissionStatus, planStatus } from "./cards/cardStatus";
import ChatAsideLane from "./asides/ChatAsideLane.vue";
import ChatNotes from "./asides/ChatNotes.vue";
import ChatQuestionCard from "./cards/ChatQuestionCard.vue";
import ChatTodoList from "./ChatTodoList.vue";
import ChatTurnAsides from "./asides/ChatTurnAsides.vue";
import ChatTurnStatus from "./ChatTurnStatus.vue";
import { present } from "../tools/toolPresentation";
import { useT } from "@intentic/ui/i18n";

// Renders one transcript entry (user bubble, notice line, or assistant turn stack). Card decisions go through the
// useChat singleton; per-message UI state lives here.

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
}>();

// A snapshot that moved nothing is not a checklist event, so it draws no line at all — not an empty one.
const showsTodos = computed(
    () => (props.message.todos?.length ?? 0) > 0 && !(props.checklistView !== undefined && changedNothing(props.checklistView)),
);

const {
    conversation,
    decidePlan,
    answerQuestion,
    cancelQuestion,
    decidePermission,
    decideCapabilityOffer,
    decidePaymentOffer,
    decideCredentialOffer,
    declineBrowserHelp,
    declineTerminalHelp,
    awaitingDecision,
    isDeciding,
    editing,
    beginEdit,
    streaming: conversationStreaming,
} = usePaneView();

// Browser-help's primary action links to /browsers (ChatDecisionButton's `to`) rather than deciding in place.
// Gates a card's other buttons while one answer is in flight; the pressed button already holds itself (kit's Button).
const settling = computed(() => isDeciding(props.message));

// Whether the viewer is a release card's named approver; a courtesy only — the daemon verifies identity server-side.
// Case-insensitive; no presented email leaves the buttons enabled.
const { presentedEmail } = useSandboxSession();
const mayRelease = computed(() => {
    const approvers = props.message.credentialOffer?.offer.approvers;
    const me = presentedEmail.value?.toLowerCase();
    return approvers === undefined || me === undefined || approvers.some((approver) => approver.toLowerCase() === me);
});

const router = useRouter();
const helpBrowserAt = (session: string): string => `/browsers/${session}`;

// Opens the terminal-help card's target: a panel, not a route, focused on the agent's session.
const openHelpTerminal = (help: TranscriptTerminalHelp): void =>
    useTerminalPanel().openFocused(help.session, { title: t(`chat.chatMessageView.agentNeedsAtTerminal`), detail: help.message });

// Connect is both a decision (un-parks the daemon) and a navigation to the Capabilities page, opened to this card.
const capabilitySetupAt = (card: string): string => `/capabilities/${card}`;
const connectCapability = async (message: ChatMessage): Promise<void> => {
    // Awaits the decision so the button holds; the navigation is fire-and-forget.
    navigateInApp(router, capabilitySetupAt(message.capabilityOffer?.offer.card ?? ``));
    await decideCapabilityOffer(message, true);
};

// Catalog description, when the static catalog knows the card; absent for a contributed card.
const capabilityDescription = computed(() => {
    const card = props.message.capabilityOffer?.offer.card;
    return card === undefined ? undefined : CAPABILITY_CATALOG.find((entry) => entry.id === card)?.description;
});
const { mobile } = useDevice();

// landHold's one-press opt-out from future auto-land, scoped per-agent and gated on the current effective posture.
const { agentById, setAutoLand, setResumeAfterOutage, stopWatching } = useAgents();
const { settings: sandboxSettings } = useSandboxSettings();
const holdOffer = computed(
    () =>
        props.message.noticeAction === `landHold` &&
        effectiveAutoLand(agentById(conversation.value.conversationId), landsByDefault(sandboxSettings.value?.rules ?? [])),
);
// Best-effort like markSeen: a failed write leaves the offer standing to press again.
const holdFutureLands = async (): Promise<void> => {
    await setAutoLand(conversation.value.conversationId, false).catch(() => undefined);
};

// Outage opt-out, same pattern as landHold; sets `false` rather than null so it can't fall back to a resuming default.
const outageOptOutOffer = computed(
    () =>
        props.message.noticeAction === `outageOptOut` &&
        effectiveOutageResume(agentById(conversation.value.conversationId), sandboxSettings.value?.resumeAfterOutage),
);
const stopResumingOutages = async (): Promise<void> => {
    await setResumeAfterOutage(conversation.value.conversationId, false).catch(() => undefined);
};

// Reveals the terminal for a daemon-started dependency install; gated on the install still running.
const { rows: liveWork } = useWorkTerminals();
// Install panel jobs are keyed `<project>--install` (workspace-setup.ts installPanelKey); matched here by suffix.
const installSession = computed(() => liveWork.value.find((row) => row.session.endsWith(`--install`))?.session);
const depsInstallOffer = computed(() => props.message.noticeAction === `depsInstall` && installSession.value !== undefined);
const watchDepsInstall = (): void => {
    if (installSession.value !== undefined) {
        openWorkTerminal(installSession.value);
    }
};

// The outside condition this row is about, while it is still armed (AgentSummary.watches). Named by id rather than
// taken as "the conversation is watching something", so two armed watches settle their rows one at a time.
const armedWatch = computed(() => {
    const id = props.message.noticeWaitId;
    return id === undefined ? undefined : agentById(conversation.value.conversationId)?.watches?.find((armed) => armed.id === id);
});

// Disarms the one watch this row names, leaving the conversation's others armed; offered only while it is still on,
// so a fired watch's row keeps its words without keeping a button that would do nothing.
const watchStopOffer = computed(() => props.message.noticeAction === `watchStop` && armedWatch.value !== undefined);
const stopThisWatch = async (): Promise<void> => {
    await stopWatching(conversation.value.conversationId, props.message.noticeWaitId).catch(() => undefined);
};

// Both prose surfaces share one composable (useMarkdown); one renderer per message, held for the component's life.
// Workspace scope for file links: an isolated conversation's own checkout, undefined (= /work) for a shared one.
const linkAgent = computed(() => (conversation.value.isolated.value ? conversation.value.conversationId : undefined));

const body = useMarkdown(
    () => props.message.text,
    () => props.streaming,
    linkAgent,
);
// A plan card's body arrives whole with the card, so it never streams.
const plan = useMarkdown(() => (props.message.plan ? planParts(props.message.plan.text).body : ``), false, linkAgent);

const planTitle = (request: TranscriptPlan): string => planParts(request.text).title ?? `Proposed plan`;

// Whether the document's title differs enough from the card's own to need its own name row.
const documentTitled = (cardTitle: string, carried: CardDocument): boolean => carried.title.trim() !== cardTitle.trim();

// Whether a bubble already renders a card's document (as the Write that produced it); the card then opens folded.
const documentDrawn = (document: CardDocument | undefined): boolean =>
    // Checked via the tool's own presenter, not the shared rule, so a failed write can't fold the card away.
    document !== undefined && (props.message.tools ?? []).some((tool) => present(tool).document?.path === document.path);

// Delegated listener for markdown's copy buttons and file links (inside v-html); bound to press, since a live rerender
// can destroy the button before click fires.
const onMarkdownClick = (event: MouseEvent): void => {
    copyCodeFromEvent(event);
    openFileRefFromEvent(event);
};

// Permission card header: bridge's rendered prompt sentence, else short noun phrase, else bare tool name.
const permissionTitle = computed(() => {
    const permission = props.message.permission;
    if (permission === undefined) {
        return ``;
    }
    return permission.title ?? permission.displayName ?? permission.toolName;
});

// Command disclosure, closed by default, per-decision only: the card's title already states the safety judgment.
const commandOpen = ref(false);

// Status line shows for the whole live turn, not just before the first token, since the model can go quiet
// mid-tool-call. Reads the conversation's streaming flag, not this message's.
const showTyping = computed(() => props.streaming && !awaitingDecision.value);

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
        case `personaRoute`:
            return clock(personaRouteWait(conversation.value)?.since, `up`);
        case `modelRoute`:
            return clock(modelRouteWait(conversation.value)?.since, `up`);
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
    return wait.counts === `up` ? formatElapsed(wait.at, now.value) : formatElapsed(now.value, wait.at);
});

// The wake itself: its evidence is one press away rather than in the reading column, since a fired watch is usually
// read as "good, it happened" and only sometimes as "why did it say that".
const watchEvidence = ref(false);
// A watch that ended without its condition ever holding is the one outcome calling for a different next step, so it is
// the one that carries weight in the row rather than reading as the good news beside it.
const watchGaveUp = computed(() => props.message.watchWake !== undefined && props.message.watchWake.outcome !== `met`);

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
    beginEdit(props.message);
};

// Clamp overflow (.chat-prompt-text) depends on wrap width, so it's measured via ResizeObserver, not guessed from text.
const bubble = useTemplateRef<HTMLElement>(`bubble`);
const overflowing = ref(false);
const expanded = ref(false);
watch(
    bubble,
    (element, _previous, onCleanup) => {
        if (element === null) {
            overflowing.value = false;
            return;
        }
        const observer = new ResizeObserver(() => {
            // Skip measuring while expanded, since the box always fits and remeasuring would clear the collapse flag.
            if (!expanded.value) {
                overflowing.value = element.scrollHeight > element.clientHeight + 1;
            }
        });
        observer.observe(element);
        onCleanup(() => observer.disconnect());
    },
    { immediate: true, flush: `post` },
);

// Folded messages never pin, since sticking one would cover the prompt it defers to.
const defers = computed(() => foldsIntoTurn(props.message));

// An errand is a prompt the app sent on the user's behalf (errands.ts): named in one quiet line, since a turn nobody
// typed still has to appear as a turn, with the words it actually sent out on the mark beside it.
const errand = computed(() => errandOf(props.message));
const errandMarks = computed(() => (errand.value === undefined ? [] : [{ key: `errand`, icon: errand.value.icon, label: errand.value.label }]));

// Trailer naming the latest thing keeping this turn going, and how many said the same; shown in-flow so it can't shift
// the pinned row's height.
const foldedLabel = (message: ChatMessage): string => errandOf(message)?.label ?? message.text.trim();
const trailer = computed(() => {
    const folded = props.folded ?? [];
    const last = folded.at(-1);
    if (last === undefined) {
        return undefined;
    }
    const label = foldedLabel(last);
    return { label, count: folded.filter((message) => foldedLabel(message) === label).length };
});

// Pinned state (.chat-prompt-pinned).
// Whether the prompt is actually stuck (CSS can't ask): compares the row's top to the scroller's edge on scroll and on
// either box resizing; the IntersectionObserver only toggles that listener.
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
        const scroller = element.closest(`.chat-scroller`);
        if (scroller === null) {
            return;
        }
        // What this row covers while pinned, published to the turn as `--chat-pin` so anything else that sticks inside
        // it (an open mark bar) parks below the prompt instead of under it. One prompt pins per turn, so one writer.
        const host = element.closest<HTMLElement>(`.chat-pin-host`);
        // `top: -1px` is the pin's own offset: the row's last pixel sits that far above the scroller's edge.
        const publish = (): void => host?.style.setProperty(`--chat-pin`, `${element.offsetHeight - 1}px`);
        // Compares against the midpoint of the row's 1px sticky offset, robust to fractional scroll position or display
        // scaling.
        const sync = (): void => {
            const edge = scroller.getBoundingClientRect().top + scroller.clientTop;
            pinned.value = element.getBoundingClientRect().top < edge - 0.5;
        };
        let listening = false;
        const listen = (on: boolean): void => {
            if (on === listening) {
                return;
            }
            listening = on;
            if (on) {
                scroller.addEventListener(`scroll`, sync, { passive: true });
            } else {
                scroller.removeEventListener(`scroll`, sync);
            }
        };
        // Gates the scroll listener on visibility so off-screen rows aren't measured.
        const observer = new IntersectionObserver(
            (entries) => {
                listen(entries.at(-1)?.isIntersecting === true);
                sync();
            },
            { root: scroller },
        );
        observer.observe(element);
        // A row crosses the threshold with nothing scrolled, too: content above it changes height (a card folding,
        // the warm-up pass giving skipped rows their real heights) or the box around it resizes (the floating
        // window fitting itself around a second pane). Scroll anchoring hides most of that — it moves scrollTop to
        // hold the reader's place, and Chromium does fire a scroll event when it does — but it is suppressed on any
        // frame that changes a computed style on the anchor's ancestors, which is what folding a row IS. The row
        // then lifts with no scroll event behind it, and the prompt keeps a transparent band while the turn scrolls
        // through it, until the reader happens to scroll: the report this measurement was added for.
        // Two boxes, for the reason useStickToBottom watches two: the scroller's own box changes when the pane or
        // window resizes it, the wrapper inside it (ChatPane's `content`, which the transcript's insets live on)
        // changes when the turn grows, and neither implies the other.
        const resizer = new ResizeObserver(() => {
            publish();
            if (listening) {
                sync();
            }
        });
        // The row itself, for `--chat-pin`: its height changes when the reader opens a clamped prompt.
        resizer.observe(element);
        resizer.observe(scroller);
        // Guarded, not asserted: a scroller with nothing in it yet is a transcript with no row to pin either.
        if (scroller.firstElementChild !== null) {
            resizer.observe(scroller.firstElementChild);
        }
        // Syncs and listens immediately, so an already-stuck row (transcript restored at the bottom) starts out pinned.
        publish();
        sync();
        listen(true);
        onCleanup(() => {
            observer.disconnect();
            resizer.disconnect();
            listen(false);
            host?.style.removeProperty(`--chat-pin`);
        });
    },
    { immediate: true, flush: `post` },
);

// A clamped box has no scrollbar, so any scroll event means find-in-page or a screen reader jumped inside it: expand
// and reset scroll. An open box is left alone.
const onBubbleScroll = (): void => {
    if (expanded.value) {
        return;
    }
    if (bubble.value !== null && bubble.value.scrollTop > 0) {
        expanded.value = true;
        bubble.value.scrollTop = 0;
    }
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
            <template #errand>
                <pre class="chat-inset max-h-64 overflow-auto px-2.5 py-1.5 text-2xs leading-relaxed whitespace-pre-wrap">{{ message.text }}</pre>
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
            <div class="flex items-center gap-1">
                <!-- Beside-prompt thumbnail once the panel is wide enough (attachmentsAside gates it): costs only the taller element. -->
                <ChatAttachmentStrip v-if="attachmentsAside" :attachments="attachmentThumbs" class="mr-1 hidden shrink-0 self-start @lg:flex" />
                <!-- The frame owns positioning for the fade and toggle chip. -->
                <div v-if="message.text" class="chat-surface relative rounded-lg" :class="{ 'chat-prompt-clamped': overflowing && !expanded }">
                    <div
                        ref="bubble"
                        class="chat-prompt-text whitespace-pre-wrap px-3 py-2 text-xs leading-relaxed text-content"
                        :class="{ 'cursor-pointer': overflowing && !expanded }"
                        @scroll="onBubbleScroll"
                        @click="onBubbleClick"
                    >
                        {{ message.text }}
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
                v-tooltip.right="t(`chat.chatMessageView.editMessageReplacesEverything`)"
                :aria-label="t(`chat.chatMessageView.editMessage`)"
                @click.stop="startEdit"
            >
                <Icon name="pencil" class="text-2xs" />
            </button>
        </div>
        <div
            v-else-if="message.role === 'notice' && message.text !== ''"
            class="flex flex-wrap items-center justify-center gap-x-2 gap-y-0.5 self-center py-0.5 text-2xs"
            :class="watchGaveUp ? `text-danger` : `text-subtle`"
        >
            <!-- Mark, sentence and clock are one non-wrapping group inside the wrapping row: a sentence wider than the pane must wrap inside its own span. -->
            <span class="flex min-w-0 items-center gap-x-2">
                <!-- Spins and shows the wait's clock while it runs, then settles to a plain line (ChatMessage.noticeWait). -->
                <!-- A mark set at the row's own 11px has no counter left to read; both glyphs take a step up from the sentence. -->
                <Icon v-if="pendingWait" name="spinner" spin class="shrink-0 text-xs text-info" />
                <!-- The board's own watch glyph, so one conversation's watch reads the same in both places. -->
                <Icon v-else :name="message.watchWake ? `eye` : `info-circle`" class="shrink-0 text-xs" />
                <span class="min-w-0">{{ message.text }}</span>
                <span v-if="waitClock" class="shrink-0 tabular-nums">{{ waitClock }}</span>
            </span>
            <template v-if="watchStopOffer">
                <button type="button" class="shrink-0 font-medium text-link hover:underline" @click="stopThisWatch">
                    {{ t(`chat.chatMessageView.stopWatching`) }}
                </button>
                <span class="shrink-0">{{ t(`chat.chatMessageView.chatStaysPutInstead`) }}</span>
            </template>
            <!-- Nobody typed the wake, so what the model was told is one press away rather than taken on trust. -->
            <button
                v-if="message.watchWake"
                type="button"
                class="shrink-0 font-medium text-link hover:underline"
                :aria-expanded="watchEvidence"
                @click="watchEvidence = !watchEvidence"
            >
                {{ watchEvidence ? t(`chat.chatMessageView.hideCheck`) : t(`chat.chatMessageView.showCheck`) }}
            </button>
            <pre
                v-if="watchEvidence && message.watchWake"
                class="chat-inset max-h-64 w-full overflow-auto px-2.5 py-1.5 text-left text-2xs leading-relaxed whitespace-pre-wrap text-subtle"
                >{{ message.watchWake.sent }}</pre>
            <!-- Optional follow-up offer on a notice (see holdOffer): a link, not a button, stated as a trailing clause. -->
            <template v-if="holdOffer">
                <button type="button" class="shrink-0 font-medium text-link hover:underline" @click="holdFutureLands">
                    {{ t(`chat.chatMessageView.keepFutureWorkOn`) }}
                </button>
                <span class="shrink-0">{{ t(`chat.chatMessageView.waitsReadyToLand`) }}</span>
            </template>
            <template v-if="outageOptOutOffer">
                <button type="button" class="shrink-0 font-medium text-link hover:underline" @click="stopResumingOutages">
                    {{ t(`chat.chatMessageView.stopResumingChat`) }}
                </button>
                <span class="shrink-0">{{ t(`chat.chatMessageView.turnProviderKillsStops`) }}</span>
            </template>
            <template v-if="depsInstallOffer">
                <button type="button" class="shrink-0 font-medium text-link hover:underline" @click="watchDepsInstall">
                    {{ t(`chat.chatMessageView.watchInstall`) }}
                </button>
            </template>
        </div>
        <template v-else>
            <!-- Shared with the Subagents area: a delegated agent's reasoning and run read as this turn's own do. -->
            <!-- Live marks the bubble currently receiving streamed text. -->
            <ChatTurnAsides :thinking="message.thinking" :tools="message.tools" :live="streaming" />

            <ChatTodoList v-if="showsTodos" :todos="message.todos!" :live="streaming" :view="checklistView" />

            <!-- Markdown parts preserve settled DOM while the live tail updates. -->
            <div v-if="message.text" class="md-prose chat-markdown chat-surface-assistant w-full rounded-lg px-3.5 py-2.5">
                <template v-for="(part, index) in body" :key="index">
                    <div v-if="part.kind === `html`" class="md-part" v-html="part.html"></div>
                    <MarkdownFigure v-else :figure="part.figure" />
                </template>
            </div>
            <!-- Marks a message the user wrote in the agent's voice (composer "as agent"); the agent itself never sees this flag. -->
            <p
                v-if="message.placed"
                class="flex items-center gap-1 px-1 text-2xs text-subtle"
                v-tooltip.top="t(`chat.chatMessageView.wroteInAgentsVoice`)"
            >
                <Icon name="pencil" class="text-2xs" />{{ t(`chat.chatMessageView.placedBy`) }}
            </p>

            <!-- The plan's own heading, not prose; the body below repeats it. -->
            <ChatCard
                v-if="message.plan"
                icon="list-check"
                icon-class="text-link"
                :title="planTitle(message.plan)"
                :status="planStatus(message.plan)"
            >
                <div class="md-prose chat-markdown chat-markdown-compact chat-card-body">
                    <template v-for="(part, index) in plan" :key="index">
                        <div v-if="part.kind === `html`" class="md-part" v-html="part.html"></div>
                        <MarkdownFigure v-else :figure="part.figure" />
                    </template>
                </div>
                <!-- Shown only when the model wrote the plan to a file and summarized it in the adjacent prose (agent.ts). -->
                <ChatDocumentBody
                    v-if="message.plan.document"
                    :document="message.plan.document"
                    foldable
                    in-card
                    :open="!documentDrawn(message.plan.document)"
                    :titled="documentTitled(planTitle(message.plan), message.plan.document)"
                    max-height="min(58dvh, 40rem)"
                    class="chat-card-doc-top-rule chat-card-doc-bottom-rule"
                />
                <template v-if="message.plan.status === 'pending'" #actions>
                    <!-- Single approval, not a posture menu: approving a plan approves the work inside the isolation boundary. -->
                    <ChatDecisionButton tone="primary" icon="check" :disabled="settling" @click="decidePlan(message, true)">{{
                        t(`ui.action.approve`)
                    }}</ChatDecisionButton>
                    <ChatDecisionButton tone="secondary" icon="pencil" :disabled="settling" @click="decidePlan(message, false)">{{
                        t(`chat.chatMessageView.noKeepPlanning`)
                    }}</ChatDecisionButton>
                </template>
            </ChatCard>

            <!-- Its own component: the ask, its options and the answer being composed are a card's worth of state (ChatQuestionCard). -->
            <ChatQuestionCard
                v-if="message.question"
                :card="message.question"
                :document-open="!documentDrawn(message.question.document)"
                :settling="settling"
                @answer="(answers) => answerQuestion(message, answers)"
                @dismiss="cancelQuestion(message)"
            />

            <!-- The safety judge's own verdict sentence on this program, never from the gated agent's own words; wraps in full. -->
            <ChatCard v-if="message.permission" icon="shield" prose :title="permissionTitle" :status="permissionStatus(message.permission)">
                <div class="chat-card-body flex flex-col gap-2">
                    <!-- Shown only when it adds to the title (a hard-rule consequence, or a machine name); omitted otherwise. -->
                    <span v-if="message.permission.explain" class="text-xs leading-relaxed text-content/85">{{ message.permission.explain }}</span>
                    <span v-else-if="message.permission.description" class="text-xs text-content/85">{{ message.permission.description }}</span>

                    <template v-if="message.permission.program">
                        <!-- Click-to-reveal disclosure, not a hover or tab, so the command stays reachable on touch and keyboard. -->
                        <button
                            type="button"
                            :class="ui.textAction(`gap-1 text-2xs`)"
                            :aria-expanded="commandOpen"
                            @click="commandOpen = !commandOpen"
                        >
                            <Icon :name="commandOpen ? 'chevron-up' : 'chevron-down'" class="text-2xs" />
                            {{ commandOpen ? t(`chat.chatMessageView.hideCommand`) : t(`chat.chatMessageView.showCommand`) }}
                        </button>
                        <ChatCommandBlock v-if="commandOpen" :program="message.permission.program" />
                    </template>

                    <span v-if="message.permission.path" class="font-mono text-2xs leading-snug text-subtle">{{ message.permission.path }}</span>
                    <span v-if="message.permission.reason" class="text-2xs leading-snug text-subtle">{{
                        t(`chat.chatMessageView.requestedBecause`, { reason: message.permission.reason })
                    }}</span>
                </div>

                <template v-if="message.permission.status === 'pending'" #actions>
                    <ChatDecisionButton tone="primary" icon="check" :disabled="settling" @click="decidePermission(message, 'once')">{{
                        t(`chat.chatMessageView.allowOnce`)
                    }}</ChatDecisionButton>
                    <!-- Secondary tone, since a second filled button beside Allow once would read as a coin flip. -->
                    <ChatDecisionButton
                        v-if="message.permission.alwaysLabel"
                        tone="secondary"
                        icon="lock"
                        :disabled="settling"
                        @click="decidePermission(message, 'always')"
                        >{{ message.permission.alwaysLabel }}</ChatDecisionButton
                    >
                    <!-- Like the question card's Dismiss: a refusal with no redirect ends the turn. -->
                    <ChatDecisionButton
                        tone="secondary"
                        icon="times"
                        :disabled="settling"
                        v-tooltip.bottom="t(`chat.chatMessageView.alsoStopsTurn`)"
                        @click="decidePermission(message, 'deny')"
                        >{{ t(`chat.chatMessageView.no`) }}</ChatDecisionButton
                    >
                </template>
            </ChatCard>

            <!-- The agent's browser needs a person; the primary action navigates to /browsers, where the live stage and hand-back live. -->
            <ChatCard
                v-if="message.browserHelp"
                icon="desktop"
                icon-class="text-warning"
                :title="t(`chat.chatMessageView.agentsBrowserNeeds`, { account: message.browserHelp.account })"
                :status="helpStatus(message.browserHelp)"
            >
                <div class="chat-card-body text-xs text-content/85">{{ message.browserHelp.message }}</div>

                <template v-if="message.browserHelp.status === 'pending'" #actions>
                    <ChatDecisionButton tone="primary" icon="desktop" :to="helpBrowserAt(message.browserHelp.session)">{{
                        t(`chat.chatMessageView.openBrowser`)
                    }}</ChatDecisionButton>
                    <ChatDecisionButton tone="secondary" icon="times" :disabled="settling" @click="declineBrowserHelp(message)">{{
                        t(`chat.chatMessageView.cantHelpNow`)
                    }}</ChatDecisionButton>
                </template>
            </ChatCard>

            <!-- Terminal offers appear as cards that link to the terminal view. -->
            <ChatCard
                v-if="message.terminalHelp"
                icon="terminal"
                icon-class="text-warning"
                :title="t(`chat.chatMessageView.agentsTerminalNeeds`)"
                :status="helpStatus(message.terminalHelp)"
            >
                <div class="chat-card-body text-xs text-content/85">{{ message.terminalHelp.message }}</div>

                <template v-if="message.terminalHelp.status === 'pending'" #actions>
                    <ChatDecisionButton tone="primary" icon="terminal" @click="openHelpTerminal(message.terminalHelp)">{{
                        t(`chat.chatMessageView.openTerminal`)
                    }}</ChatDecisionButton>
                    <ChatDecisionButton tone="secondary" icon="times" :disabled="settling" @click="declineTerminalHelp(message)">{{
                        t(`chat.chatMessageView.cantHelpNow`)
                    }}</ChatDecisionButton>
                </template>
            </ChatCard>

            <!-- Payment figures come from the endpoint challenge and wallet ledger. -->
            <ChatCard
                v-if="message.paymentOffer"
                icon="credit-card"
                :title="
                    t(`chat.chatMessageView.pay`, {
                        amountUsd: message.paymentOffer.offer.amountUsd,
                        assetName: message.paymentOffer.offer.assetName,
                    })
                "
                :status="offerStatus(message.paymentOffer)"
            >
                <div class="chat-card-body flex flex-col gap-1">
                    <span v-if="message.paymentOffer.offer.description" class="text-xs text-content/85">{{
                        message.paymentOffer.offer.description
                    }}</span>
                    <!-- Full URL on hover, since a truncated host is exactly how a lookalike endpoint gets paid. -->
                    <span class="truncate font-mono text-2xs text-subtle" v-tooltip.left.overflow="message.paymentOffer.offer.url">{{
                        message.paymentOffer.offer.url
                    }}</span>
                    <span class="truncate font-mono text-2xs text-subtle" v-tooltip.left.overflow="message.paymentOffer.offer.payTo">{{
                        t(`chat.chatMessageView.to`, { payTo: message.paymentOffer.offer.payTo })
                    }}</span>
                    <span v-if="message.paymentOffer.offer.why" class="text-2xs text-subtle">{{
                        t(`chat.chatMessageView.agentsCase`, { why: message.paymentOffer.offer.why })
                    }}</span>
                    <span class="pt-1 font-mono text-xs text-content">{{
                        t(`chat.chatMessageView.spentToday`, {
                            amountUsd: message.paymentOffer.offer.amountUsd,
                            spentTodayUsd: message.paymentOffer.offer.spentTodayUsd,
                            dailyCapUsd: message.paymentOffer.offer.dailyCapUsd,
                        })
                    }}</span>
                </div>

                <!-- A receipt is shown only after the endpoint settles the payment. -->
                <div v-if="message.paymentOffer.receipt" class="chat-card-row">
                    <span v-if="message.paymentOffer.receipt.outcome === 'paid'" class="truncate text-2xs text-muted"
                        >{{ t(`chat.chatMessageView.paid`, { amount: message.paymentOffer.receipt.amountUsd })
                        }}<template v-if="message.paymentOffer.receipt.transaction"
                            ><span class="font-mono"> · {{ message.paymentOffer.receipt.transaction }}</span></template
                        ></span
                    >
                    <span v-else class="text-2xs text-muted">{{ t(`chat.chatMessageView.paymentDidntGoThrough`) }}</span>
                </div>

                <template v-if="message.paymentOffer.status === 'pending'" #actions>
                    <ChatDecisionButton tone="primary" icon="check" :disabled="settling" @click="decidePaymentOffer(message, true)">{{
                        t(`chat.chatMessageView.pay2`, { amountUsd: message.paymentOffer.offer.amountUsd })
                    }}</ChatDecisionButton>
                    <!-- Free and final: the agent is told to continue without it; nothing stops the turn. -->
                    <ChatDecisionButton tone="secondary" icon="times" :disabled="settling" @click="decidePaymentOffer(message, false)">{{
                        t(`chat.chatMessageView.skipFree`)
                    }}</ChatDecisionButton>
                </template>
            </ChatCard>

            <!-- The only card addressed to named approvers, not whoever's reading: the daemon verifies identity against that list (secrets/credential-gate.ts). -->
            <ChatCard
                v-if="message.credentialOffer"
                icon="key"
                :title="t(`chat.chatMessageView.releaseToAgent`, { subject: message.credentialOffer.offer.subject })"
                :status="offerStatus(message.credentialOffer)"
            >
                <div class="chat-card-body flex flex-col gap-1">
                    <!-- What's about to happen, phrased for the reader, not the daemon's internal terms. -->
                    <span class="text-xs text-content/85">{{ credentialLane(message.credentialOffer.offer) }}</span>
                    <!-- Reference-form, not yet substituted with the real value, which is what makes it safe to show. -->
                    <span
                        v-if="message.credentialOffer.offer.detail"
                        class="truncate font-mono text-2xs text-subtle"
                        v-tooltip.left.overflow="message.credentialOffer.offer.detail"
                        >{{ message.credentialOffer.offer.detail }}</span
                    >
                    <span v-if="message.credentialOffer.offer.why" class="text-2xs text-subtle">{{
                        t(`chat.chatMessageView.agentsCase`, { why: message.credentialOffer.offer.why })
                    }}</span>
                    <span class="truncate text-2xs text-subtle" v-tooltip.left.overflow="message.credentialOffer.offer.approvers.join(`, `)">{{
                        t(`chat.chatMessageView.approvers`, { approvers: message.credentialOffer.offer.approvers.join(`, `) })
                    }}</span>
                    <!-- Scope comes from policy, not the click, so the label never overstates what one yes covers. -->
                    <span class="pt-1 text-xs text-content">{{
                        message.credentialOffer.offer.scope === `conversation`
                            ? t(`chat.chatMessageView.releasingCoversRestConversation`)
                            : t(`chat.chatMessageView.releasingCoversOneUse`)
                    }}</span>
                </div>

                <!-- Nothing shown for an unanswered card; the header chip already says so. -->
                <div v-if="message.credentialOffer.receipt" class="chat-card-row">
                    <span v-if="message.credentialOffer.receipt.outcome === 'released'" class="truncate text-2xs text-muted">{{
                        t(`chat.chatMessageView.releasedBy`, { approvedBy: message.credentialOffer.receipt.approvedBy })
                    }}</span>
                    <span v-else class="text-2xs text-muted"
                        >{{ t(`chat.chatMessageView.refused`)
                        }}<template v-if="message.credentialOffer.receipt.approvedBy">{{
                            t(`chat.chatMessageView.by`, { approvedBy: message.credentialOffer.receipt.approvedBy })
                        }}</template
                        >{{ t(`chat.chatMessageView.agentToldToCarry`) }}</span
                    >
                </div>

                <template v-if="message.credentialOffer.status === 'pending'" #actions>
                    <ChatDecisionButton
                        tone="primary"
                        icon="check"
                        :disabled="settling || !mayRelease"
                        v-tooltip="
                            mayRelease
                                ? undefined
                                : t(`chat.chatMessageView.onlyCanRelease`, { approvers: message.credentialOffer.offer.approvers.join(`, `) })
                        "
                        @click="decideCredentialOffer(message, true)"
                        >{{ t(`chat.chatMessageView.release`) }}</ChatDecisionButton
                    >
                    <!-- Declining is approver-only too, or anyone with a session could stop someone else's turn. -->
                    <ChatDecisionButton
                        tone="secondary"
                        icon="times"
                        :disabled="settling || !mayRelease"
                        v-tooltip="
                            mayRelease
                                ? undefined
                                : t(`chat.chatMessageView.onlyCanAnswer`, { approvers: message.credentialOffer.offer.approvers.join(`, `) })
                        "
                        @click="decideCredentialOffer(message, false)"
                        >{{ t(`chat.chatMessageView.skip`) }}</ChatDecisionButton
                    >
                </template>
            </ChatCard>

            <!-- Title and id come from the daemon-validated catalog, never the model. -->
            <ChatCard
                v-if="message.capabilityOffer"
                icon="bolt"
                :title="t(`chat.chatMessageView.isntConnectedYet`, { name: message.capabilityOffer.offer.name })"
                :status="capabilityStatus(message.capabilityOffer)"
            >
                <div class="chat-card-body flex flex-col gap-1">
                    <span v-if="capabilityDescription" class="text-xs text-content/85">{{ capabilityDescription }}</span>
                    <span v-if="message.capabilityOffer.offer.why" class="text-2xs text-subtle">{{
                        t(`chat.chatMessageView.agentsCase`, { why: message.capabilityOffer.offer.why })
                    }}</span>
                </div>

                <!-- Shown while the agent waits on setup, with a way back to the form if it was closed mid-flow. -->
                <div
                    v-if="message.capabilityOffer.status === 'connecting' && !message.capabilityOffer.outcome"
                    class="chat-card-row flex items-center gap-2"
                >
                    <Icon name="spinner" class="text-2xs text-link" spin />
                    <span class="min-w-0 flex-1 truncate text-2xs text-muted">{{ t(`chat.chatMessageView.waitingToFinishSetup`) }}</span>
                    <ChatDecisionButton tone="secondary" icon="bolt" :to="capabilitySetupAt(message.capabilityOffer.offer.card)">{{
                        t(`chat.chatMessageView.openSetup`)
                    }}</ChatDecisionButton>
                </div>

                <!-- How the accepted ask resolved: what the agent did next. -->
                <div v-if="message.capabilityOffer.outcome" class="chat-card-row">
                    <span v-if="message.capabilityOffer.outcome.outcome === 'connected'" class="text-2xs text-muted"
                        >{{ t(`chat.chatMessageView.connected`)
                        }}<template v-if="message.capabilityOffer.outcome.id">{{
                            t(`chat.chatMessageView.as`, { id: message.capabilityOffer.outcome.id })
                        }}</template
                        >{{ t(`chat.chatMessageView.agentContinuing`) }}</span
                    >
                    <span v-else class="text-2xs text-muted">{{ t(`chat.chatMessageView.setupDidntFinishWhile`) }}</span>
                </div>

                <template v-if="message.capabilityOffer.status === 'pending'" #actions>
                    <ChatDecisionButton tone="primary" icon="check" :disabled="settling" @click="connectCapability(message)">{{
                        t(`chat.chatMessageView.connect`, { name: message.capabilityOffer.offer.name })
                    }}</ChatDecisionButton>
                    <!-- Final for this conversation: the agent continues without it and won't ask again. -->
                    <ChatDecisionButton tone="secondary" icon="times" :disabled="settling" @click="decideCapabilityOffer(message, false)">{{
                        t(`chat.chatMessageView.notNow`)
                    }}</ChatDecisionButton>
                </template>
            </ChatCard>

            <!-- Same component ChatPane mounts at the column's foot for a turn with no bubble yet — one spinner, one status line. -->
            <ChatTurnStatus v-if="showTyping" />
        </template>

        <!-- Trailer belongs to the turn's opener, whatever it turned out to be (prompt, errand, or restored assistant text). -->
        <span v-if="trailer" class="text-2xs text-subtle"
            >↳ {{ trailer.label }}<template v-if="trailer.count > 1"> ×{{ trailer.count }}</template></span
        >
    </div>

    <!-- Its own row, not part of the bubble above: a pinned prompt charges its whole height against reading room. -->
    <div v-if="message.notes?.length" class="chat-message chat-stack flex flex-col" :class="{ 'chat-doomed': doomed }">
        <ChatNotes :notes="message.notes" />
    </div>
</template>
