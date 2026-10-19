<script setup lang="ts">
import { useAudience } from "../../../app/useAudience";
import { deliverableKindOf } from "@intentic/sandbox-contract/text/documents";
import {
    Avatar,
    Button,
    ConfirmDialog,
    ui,
    Modal,
    Notice,
    ResponsiveOverlay,
    type Tip,
    useDevice,
    useLoadingReveal,
} from "@intentic/ui";
import { createInlineRename } from "@intentic/ui/inline-rename";
import { computed, onMounted, onUnmounted, provide, ref, useTemplateRef, watch } from "vue";
import { RouterLink, useRoute, useRouter } from "vue-router";
import ChatPanel from "../../chat/panel/ChatPanel.vue";
import AgentLandFailure from "./AgentLandFailure.vue";
import { agentStatusMeta } from "../../../models/agent-status/agentStatus-meta";
import { unregistered, writingNow } from "../../../models/agent-status/agentStatus-standing";
import { agentWork, assignAgent, landRequestWork, requestLandAgent, startAgent } from "../../../models/fleet/agentActions";
import { useOperation } from "../../../workbench/operations/operations";
import { presenceOthers } from "../../../workbench/presence/usePresence";
import { identityHue } from "../../../lib/identityHue";
import { mobileChatPath } from "../../../lib/routes/phoneScreens";
import { afterPaint } from "../../../lib/afterPaint";
import { whenIdle } from "../../../lib/whenIdle";
import ChatSwitcherSheet from "../../chat/tabs/ChatSwitcherSheet.vue";
import { QUIET_TRANSCRIPT_WAIT } from "../../../models/conversations/transcript/transcriptWait";
import { boxNameOf, openInSandbox, otherFleet } from "../../../models/fleet/fleetScope";
import { otherBoxes, refreshAcross, subscribe as watchOtherBoxes } from "../../../models/sandbox/live/fleetAcross";
import { useAgentChanges } from "./useAgentChanges";
import { useAgents } from "../../../models/fleet/useAgents";
import { useSandbox } from "../../../client/sandbox/useSandbox";
import { useRole } from "../../../client/sandbox/useRole";
import { useVocabulary } from "../../../workbench/views/vocabulary";
import { useChat } from "../../../models/conversations/run/useChat";
import AgentReviewPanel from "./AgentReviewPanel.vue";
import AgentReviewOutline from "./AgentReviewOutline.vue";
import AgentLandPress from "./AgentLandPress.vue";
import ReviewFocusButton from "./ReviewFocusButton.vue";
import ChatChangesSwitch from "./pager/ChatChangesSwitch.vue";
import SwipePages from "./pager/SwipePages.vue";
import AgentReactions from "../board/cards/AgentReactions.vue";
import AgentSessionMenu from "../board/session/AgentSessionMenu.vue";
import SessionChip from "../board/session/SessionChip.vue";
import SessionIdentity from "../board/session/SessionIdentity.vue";
import { useT } from "@intentic/ui/i18n";

// Drill-in for one agent (/agents/:id): one canonical chat surface per form factor.
// - mobile: this IS the chat surface, Chat and Changes as two pages a finger turns, chat by default
// - desktop: the conversation lives only in the docked ChatPanel; this view is review-only (diff, Land, Discard)
//
// This row owns the session; the panel below owns the review.

const t = useT();

// Nothing on this page predicts its content while it waits: an agent's review and its transcript are each its own, so
// a remembered outline is a guess the answer contradicts. The phone's chat below waits on one line too.
provide(QUIET_TRANSCRIPT_WAIT, true);

const route = useRoute();
const router = useRouter();
const { mobile } = useDevice();
const { fleet, refresh, open, agentById, archived, loadArchived, rename, markSeen } = useAgents();
const { conversations, setActive, closeTabs, openConversation, active: activeChat } = useChat();

// The phone's chat switcher hangs off this screen's title: this is the only chat surface a phone has, so the open
// chats and the stored sessions have to be reachable from it. A pick is a navigation, since here a chat is a route.
const switcherOpen = ref(false);
const switchTo = (id: string): void => {
    setActive(id);
    void router.push(mobileChatPath(id));
};
// openConversation mints the tab and focuses it; the route follows whatever it made active.
const openPast = (sessionId: string): void => {
    openConversation(sessionId);
    void router.push(mobileChatPath(activeChat.value.conversationId));
};
const { activeSandboxId } = useSandbox();

const agentId = computed(() => (typeof route.params[`id`] === `string` ? route.params[`id`] : ``));

// Review of an agent in another sandbox, named by `?sandbox=`; every read and mutation below takes it, so work is
// readable and landable from anywhere. Dropped when it names the active sandbox, so crossing into that box
// returns this page to a local agent.
const routeBox = computed(() => (typeof route.query[`sandbox`] === `string` ? route.query[`sandbox`] : undefined));
const remoteBox = computed(() => (routeBox.value === activeSandboxId.value ? undefined : routeBox.value));
const remote = computed(() => remoteBox.value !== undefined);
const remoteName = computed(() => (remoteBox.value === undefined ? undefined : boxNameOf.value.get(remoteBox.value)));

// An archived agent keeps its branch/diff/transcript, so this page is still its destination. A remote agent is
// looked up in that box's own roster (fleetAcross), not `agentById`, since ids are minted per sandbox and could
// collide.
const fleetAgent = computed(() =>
    remoteBox.value === undefined
        ? agentById(agentId.value)
        : otherFleet.value.find((agent) => agent.id === agentId.value && agent.sandboxId === remoteBox.value),
);

// Keeps the cross-sandbox store alive for as long as a remote review is open, since this page can be reached
// without the board (bookmark, reload, new tab); disposed with the page, so a local review costs nothing.
let releaseBoxes: (() => void) | undefined;
watch(
    remote,
    (isRemote) => {
        if (isRemote) {
            releaseBoxes ??= watchOtherBoxes();
            return;
        }
        releaseBoxes?.();
        releaseBoxes = undefined;
    },
    { immediate: true },
);
onUnmounted(() => {
    releaseBoxes?.();
    releaseBoxes = undefined;
    sweepPeek();
});

// Neither half of the fleet is guaranteed loaded when the page opens (the roster streams in, the archive is read
// on demand), so an absent id is not necessarily a nonexistent one. Both halves are asked once per id before the
// page fills in or bounces.
const settling = ref(false);
let askedFor: string | undefined;
const settleLookup = (id: string): void => {
    if (askedFor === id) {
        return;
    }
    askedFor = id;
    settling.value = true;
    // A remote id is never in either local half; it means the poll hasn't answered, not a bad URL.
    if (remote.value) {
        refreshAcross();
        settling.value = false;
        return;
    }
    void Promise.all([refresh(), loadArchived()]).finally(() => (settling.value = false));
};
// Registered means it has run a turn; only a branch-backed registered conversation has a review.
const registered = computed(() => fleetAgent.value !== undefined && !unregistered(fleetAgent.value.status));
const reviewable = computed(() => registered.value && fleetAgent.value?.branch !== undefined);
const conversation = computed(() => conversations.value.find((candidate) => candidate.conversationId === agentId.value));

// Phone-only focus-leave sweep for a look (Conversation.peek): there's no dock or next card to close it here, so
// leaving the screen is the only event that can. Skipped once anything promotes it or it holds unsent words.
const sweepPeek = (): void => {
    const chat = conversation.value;
    if (mobile.value && chat?.peek.value === true && !chat.unsent.value) {
        closeTabs(new Set([chat.conversationId]));
    }
};

// Binds the chat singleton to this agent's tab: opens/creates from the fleet entry, or focuses the already-open
// conversation. Desktop also requires a registered agent (something to review); a draft or unknown id bounces to
// the board.
const bindLocalConversation = (id: string, previousId: string | undefined): void => {
    if (id === `` || (id === previousId && conversation.value !== undefined && (mobile.value || reviewable.value))) {
        return;
    }
    // The tab is already in front (a phone's board opened it as it walked here, cardSelection.ts, or /chat pointed at
    // the chat that was): re-revealing it is a second pass over the tab list and the pane layout, inside the
    // navigation the reader is waiting on. Arriving still stamps the read marker, which is all that open() adds.
    if (mobile.value && id !== previousId && activeChat.value.conversationId === id && conversation.value !== undefined) {
        if (fleetAgent.value !== undefined) {
            markSeen(id);
        }
        return;
    }
    if (fleetAgent.value !== undefined) {
        open(fleetAgent.value);
        if (!mobile.value && !reviewable.value) {
            void router.replace(`/agents`);
        }
        return;
    }
    // Unknown so far: ask both halves once, and wait for an answer before reading anything into the silence.
    settleLookup(id);
    // No fleet entry means no registry entry, so there's no read marker to stamp: just focus the tab.
    if (conversation.value !== undefined) {
        setActive(conversation.value.conversationId);
        return;
    }
    if (settling.value) {
        return;
    }
    void router.replace(`/agents`);
};

// Keyed on id + roster size, not the fleetAgent computed itself, whose per-recompute identity would refire this
// forever. Roster size includes the archive, since archiving the reviewed agent shifts one count and grows the other.
watch(
    [agentId, () => fleet.value.length + archived.value.length, settling],
    ([id], [previousId] = [undefined, 0, false]) => {
        // None of the local binding applies to a remote agent: `open()` would mint a tab against the wrong daemon, and
        // the local-absence bounce would wrongly read a remote agent as nonexistent. A remote review has no chat
        // surface
        // on either form factor by design.
        if (remote.value) {
            settleLookup(id);
            return;
        }
        bindLocalConversation(id, previousId);
    },
    { immediate: true },
);

// A PHONE DRAWS THIS PAGE IN TWO FRAMES: the header (whose agent was tapped, what it is doing) in the navigation's own,
// and the chat, the heaviest thing on the screen, in the next. In one task the header waits on every row of the
// transcript, and the tap that opened it reads as a tap that didn't land.
const chatMounted = ref(!mobile.value);
onMounted(() => {
    if (!chatMounted.value) {
        void afterPaint().then(() => (chatMounted.value = true));
    }
});

// Mode switch only exists on mobile; desktop always renders the review.
const view = ref<`chat` | `changes`>(mobile.value ? `chat` : `changes`);

// The name this page can honestly print: the roster's, or the open conversation's. Absent while the id is still a
// question, which the header draws as a bar rather than filling with the word "Agent".
const named = computed(() => fleetAgent.value?.title ?? conversation.value?.title.value);
const title = computed(() => named.value ?? t(`shared.agent`));

const edit = createInlineRename(
    () => fleetAgent.value?.title ?? conversation.value?.title.value ?? undefined,
    (name) => rename(agentId.value, name),
    t(`agents.agentCard.couldntRename`),
);

// Fleet's status glyph: what the review can't state (still writing), and the page's only "landed" signal.
const status = computed(() => (fleetAgent.value === undefined ? undefined : agentStatusMeta(fleetAgent.value.status)));

// Shared useAgentChanges instance: this row and the panel act on one busy/error state and one fetch.
// Empty until the agent is reviewable; the roster entry lets a land measure from the correct rung.
const changes = useAgentChanges(
    computed(() => (reviewable.value ? agentId.value : ``)),
    remoteBox,
    fleetAgent,
);
// A remote agent has no local conversation; `writing` reads its live state from the roster instead.
const streaming = computed(() => !remote.value && conversation.value?.turn.streaming.value === true);

// Land only reads the checkout, so it's live whenever anything is pending, unlike Discard (worktree-gated,
// refused mid-turn). `actionBusy` is the ledger's, so a land still running when this page is opened again holds it. `writing` (fleet status, not `streaming`) decides which press it is, since a parked turn
// still streams.
const writing = computed(() => fleetAgent.value !== undefined && writingNow(fleetAgent.value));
const canLand = computed(() => !changes.actionBusy.value && (changes.pending.value.length > 0 || pendingDocuments.value));
// A live turn that isn't writing: parked on a question, permission, or a Stop unwind; land is ordinary.
const parked = computed(() => streaming.value && !writing.value);
// What the Land button promises, across the three states it can be pressed in.
const landHint = computed((): Tip => {
    const rows = [{ label: t(`shared.changes`), value: changes.pending.value.length }];
    return writing.value
        ? { title: t(`agents.agentDetail.stillWriting`), tone: `warning`, rows, note: t(`agents.agentDetail.asksToConfirm`) }
        : { title: parked.value ? t(`agents.agentDetail.writtenSoFar`) : t(`agents.agentDetail.toWorkspace`), rows };
});
// The collaborator's press: who it waits on, and where the ask goes.
const requestLandHint = computed((): Tip => ({ title: t(`agents.agentDetail.needsMaintainer`), note: t(`agents.agentDetail.asksOnTheirBoard`) }));
// The only land that can carry half-finished work gets a modal, not a quiet press: the user needs to see why it's
// recoverable (uncommitted, rest lands later) before confirming. A parked or resting press just lands.
const pendingForceLand = ref(false);
const pressLand = (): void => {
    if (writing.value) {
        pendingForceLand.value = true;
        return;
    }
    void changes.land();
};
const confirmForceLand = async (): Promise<void> => {
    pendingForceLand.value = false;
    // The rung is the review's own decision (useAgentChanges.land); the modal only answers the mid-write warning.
    await changes.land(`check`, undefined, true);
};

// Role split on the primary action: maintainers land, collaborators ask (the daemon enforces the floor itself).
const { canDrive, canShip } = useRole();
const { maker } = useAudience();
// In plain words a document git ignores, or one the land would set aside as scratch, still waits on Accept, since that
// press carries the conversation's documents with it (landAgent); for a developer it stays out, as git says.
const pendingDocuments = computed(() => maker.value && [...changes.ignored.value, ...changes.scratch.value].some((group) => group.paths.some((file) => deliverableKindOf(file.path) !== undefined)));
// Whichever of the three land presses this reader gets, they all answer the same condition: in the header on a desktop,
// under the review on a phone, where the header's width is the title's and the thumb is at the bottom of the screen.
const landPending = computed(() => reviewable.value && (changes.pending.value.length > 0 || pendingDocuments.value) && (canShip.value || canDrive.value));
// In plain words the press is never the header's: it closes the review instead, under the documents it accepts and the
// sentence saying what accepting does, as on a phone.
const landOffered = computed(() => !mobile.value && !maker.value && landPending.value);
// A refused land the agent can clear turns the press into the fix: landing again would only be refused again, so the
// retry moves to the session menu. Local only, since the ask is a turn in this sandbox's conversation.
const fixPress = computed(() =>
    !remote.value && changes.fixable.value > 0
        ? {
              count: changes.fixable.value,
              state: changes.asked.value ? (`working` as const) : changes.fixQueued.value ? (`queued` as const) : (`ready` as const),
              busy: changes.actionBusy.value,
          }
        : undefined,
);
// `ready` says "ready to land", which the button beside it says in a stronger voice: the press IS the status, and two
// controls 60px apart stating one fact is what makes a header read as clutter. Every other status keeps its words —
// running, failed, conflict are things no button here says.
const statusShown = computed(() => status.value !== undefined && !(landOffered.value && fleetAgent.value?.status === `ready`));
const words = useVocabulary();
// Kept in the ledger under the card, shared with the card's own press: its refusal is said under this header (or as a
// receipt to a reader who already left), where it used to be thrown at nobody.
const landAsk = useOperation(() => landRequestWork(agentId.value, remoteBox.value));
const requestingLand = landAsk.busy;
const requestLand = async (): Promise<void> => {
    const id = agentId.value;
    const box = remoteBox.value;
    const name = title.value;
    await landAsk.run({
        what: t(`agents.agentDetail.requestingLand`, { name }),
        done: () => t(`agents.agentDetail.landRequestSent`, { name }),
        failed: t(`agents.agentCard.couldntSendLandRequest`),
        task: async () => {
            await requestLandAgent(id, box);
            await (box === undefined ? refresh() : Promise.resolve(refreshAcross()));
        },
    });
};

// What a remote review can't offer, gated in one place: rename/archive/auto-land address the fleet store (this
// daemon's roster only), and asking the agent needs a conversation. Absent rather than disabled, with the
// crossing offered instead.
const localOnly = computed(() => !remote.value);
// Whether the header draws the session menu (☰): a local agent with work to review. On a phone it also carries the
// session's marks, which is what frees the header's width for the title.
const sessionMenuShown = computed(() => reviewable.value && localOnly.value);

// A PHONE'S TWO PAGES. The chat and its changes lie side by side under this one header and a finger turns between
// them (SwipePages); the header's switch says which shows and how much is still to land, in the width of two glyphs
// rather than a row of tabs the transcript paid a line of its height for. Until the agent has a branch there is only
// the chat: nothing to turn to, and no switch.
const paged = computed(() => mobile.value && reviewable.value && localOnly.value);
const pageIds = computed((): readonly (`chat` | `changes`)[] => (paged.value ? [`chat`, `changes`] : [`chat`]));
const PAGE_IDS = `agent-page`;
const pageSwitch = useTemplateRef<InstanceType<typeof ChatChangesSwitch>>(`pageSwitch`);
watch(paged, (on) => {
    if (!on && mobile.value) {
        view.value = `chat`;
    }
});
// The review is drawn once the chat has painted and the phone is idle, so a swipe finds its page ready; a finger
// coming down before then, or a press on the switch, draws it at once.
const reviewDrawn = ref(view.value === `changes`);
const drawReview = (): void => {
    reviewDrawn.value = true;
};
watch(
    chatMounted,
    (on) => {
        if (on && mobile.value) {
            whenIdle(drawReview);
        }
    },
    { immediate: true },
);
watch(view, (shown) => {
    if (shown === `changes`) {
        drawReview();
    }
});

// `heardFrom` tells "not told yet" apart from "told, and this agent isn't in it" (fleetAcross's `readAt`), so a
// box that answered but lacks this id gets a sentence saying so, not a false "hasn't answered".
const heardFrom = computed(
    () => remoteBox.value !== undefined && otherBoxes.value.some((box) => box.sandbox.id === remoteBox.value && box.readAt !== undefined),
);
// A box whose last attempt failed is not a wait: nothing is on its way until it is reachable again, so it gets the
// sentence rather than an outline promising rows that can't arrive.
const remoteSilent = computed(
    () => remoteBox.value !== undefined && otherBoxes.value.some((box) => box.sandbox.id === remoteBox.value && box.state === `unreachable`),
);
const remoteUnavailable = computed(() => {
    const name = remoteName.value ?? t(`agents.agentDetail.thatSandbox`);
    if (fleetAgent.value !== undefined) {
        return t(`agents.agentDetail.noBranchToReview`);
    }
    return heardFrom.value
        ? t(`agents.agentDetail.agentGoneFrom`, { name })
        : t(`agents.agentDetail.notAnsweredYet`, { name });
});
const crossToAgent = (): void => {
    if (remoteBox.value !== undefined) {
        openInSandbox(remoteBox.value, agentId.value);
    }
};

// The page's own wait, before either panel below has anything to work with: locally, the roster and the archive
// answering for this id (`settling`); remotely, the box named by `?sandbox=` answering at all. Both used to leave the
// screen empty or, across sandboxes, print "hasn't answered yet" about a wait usually over in a blink.
const looking = computed(() => (remote.value ? !heardFrom.value && !remoteSilent.value && fleetAgent.value === undefined : settling.value));
// Drawn past the same thresholds as every other skeleton in the app, keyed on the agent so walking from one review to
// the next starts a fresh wait instead of inheriting the last one's hold.
const outline = useLoadingReveal(looking, agentId);
// The header's half of it: with no roster entry there is no status, so its place is held as a bar rather than left as
// a gap that fills in later and shifts everything beside it.
const headerOutline = computed(() => outline.value && fleetAgent.value === undefined);
// The title's, one step narrower: an open conversation can name the agent before the roster answers, and a name in
// hand beats a bar every time.
const unnamed = computed(() => headerOutline.value && named.value === undefined);

// Session name and session actions, each an anchored popover on desktop and a thumb-reachable sheet on a phone
// (ResponsiveOverlay), one open flag each instead of the old hand-written pair per surface.
const identityAnchor = ref<HTMLElement | null>(null);
const identityOpen = ref(false);

const menuAnchor = ref<HTMLButtonElement | null>(null);
const menuOpen = ref(false);
const closeMenu = (): void => {
    menuOpen.value = false;
};

// The marks people left on this session, in the row that names it rather than in a band of their own: a 👍 is worth a
// chip, never a third full-width strip above someone's code. AgentReactions in `dense` dress draws the marks and
// nothing else, and hands the press that adds one to whoever hosts it (`open`), which is this button.
const reactionChips = ref<InstanceType<typeof AgentReactions> | null>(null);
const reactTrigger = ref<HTMLButtonElement | null>(null);
const openReactions = (): void => {
    if (reactTrigger.value !== null) {
        reactionChips.value?.open(reactTrigger.value);
    }
};

// Destructive and unrecoverable (branch and worktree go); same confirm modal as other irreversible git actions.
const pendingDiscard = ref(false);
const confirmDiscard = async (): Promise<void> => {
    pendingDiscard.value = false;
    await changes.discard();
};
// Hand-over: a member from the presence roster, or an address typed for somebody not connected. The daemon decides
// whether the caller may and whether the address is a member's; a refusal is shown in its own words. The press is
// the card's, in the ledger: a dialog closed or a page left mid-press finds it still held, and its refusal kept.
const pendingHandOver = ref(false);
const handOverTo = ref(``);
const handOver = useOperation(() => `${agentWork(agentId.value, remoteBox.value)}/hand-over`);
const handOverBusy = handOver.busy;
const handOverError = computed(() => handOver.failure.value?.detail ?? handOver.failure.value?.title);
const openHandOver = (): void => {
    handOverTo.value = ``;
    handOver.dismiss();
    pendingHandOver.value = true;
};
const confirmHandOver = async (): Promise<void> => {
    const to = handOverTo.value.trim().toLowerCase();
    if (to === `` || handOverBusy.value) {
        return;
    }
    const id = agentId.value;
    const box = remoteBox.value;
    const outcome = await handOver.run({
        what: t(`agents.agentDetail.handingOver`, { name: title.value, to }),
        failed: t(`agents.agentDetail.handOverFailed`),
        // The card's owner moves on the board; nothing else to say.
        quiet: true,
        task: async () => {
            await assignAgent(id, to, box);
        },
    });
    if (outcome?.state === `done` && id === agentId.value) {
        pendingHandOver.value = false;
    }
};
</script>

<template>
    <div class="flex h-full min-h-0 flex-col">
        <!-- A @container: the header thins against its own width (the workspace pane's), not the window's. -->
        <!-- On a phone it is the screen's whole chrome, sized for a thumb: 56px tall, every press in it a 40-44px target
             you can see, rather than a 28px glyph whose larger target is invisible (`touch-target`). -->
        <div
            class="view-header @container flex items-center border-b border-line"
            :class="mobile ? `h-14 gap-1 pl-1 pr-2` : `gap-2.5 px-3.5 py-1`"
        >
            <!-- The board is a place, so the way back is a link: hoverable, copyable, openable in its own tab. -->
            <RouterLink
                to="/agents"
                class="touch-target flex shrink-0 items-center justify-center text-muted transition-colors hover:bg-overlay hover:text-content active:bg-overlay"
                :class="mobile ? `h-11 w-11 rounded-full` : `h-7 w-7 rounded-md`"
                :aria-label="t(`agents.agentDetail.backToAgents`)"
            >
                <Icon name="arrow-left" :class="mobile ? `text-lg` : `text-sm`" />
            </RouterLink>
            <input
                v-if="edit.editing"
                v-model="edit.draft"
                type="text"
                maxlength="80"
                :aria-label="t(`agents.words.agentTitle`)"
                class="ui-field-box ui-field-inline min-w-0 flex-1 px-1 text-xs font-medium"
                @keydown.enter.prevent="edit.commit()"
                @keydown.esc.prevent="edit.cancel()"
                @blur="edit.blurCommit()"
                @vue:mounted="edit.focusInput"
            />
            <template v-else>
                <!-- Nobody has named this agent yet: a bar in the title's own place, and no rename over a missing name. -->
                <!-- One bar, not a remembered title: the last agent's name says nothing about how long this one's is. -->
                <span v-if="unnamed" class="flex min-w-0 flex-1 items-center" :class="{ 'px-1.5': mobile }" aria-hidden="true">
                    <span class="skeleton block h-3 w-40 max-w-full"></span>
                </span>
                <!-- On a phone the title is the switcher's handle: the chats sheet opens from it, chevron and all. -->
                <button
                    v-else-if="mobile"
                    type="button"
                    class="flex h-11 min-w-0 flex-1 items-center gap-1.5 rounded-lg px-1.5 text-left active:bg-overlay"
                    :aria-expanded="switcherOpen"
                    @click="switcherOpen = true"
                >
                    <span class="min-w-0 truncate text-sm font-semibold text-content">{{ title }}</span>
                    <span class="sr-only">{{ t(`agents.agentDetail.switchChat`) }}</span>
                    <Icon name="chevron-down" class="shrink-0 text-xs text-subtle" aria-hidden="true" />
                </button>
                <span v-else class="min-w-0 flex-1 truncate text-xs font-medium text-content">{{
                    title
                }}</span>
            </template>
            <!-- Which sandbox this agent is in, not decoration: every number below (diff, file count, what Land applies) is about a workspace on another machine. -->
            <span
                v-if="remoteName !== undefined"
                class="ui-status-pill inline-flex shrink-0 items-center gap-1 bg-overlay text-2xs text-muted"
                v-tooltip.bottom="{ title: t(`agents.words.otherSandbox`), rows: [{ label: t(`agents.words.sandbox`), value: remoteName }] }"
            >
                <Icon name="server" class="text-2xs" />
                <span class="max-w-[10rem] truncate">{{ remoteName }}</span>
            </span>
            <!-- Session name, pasteable: replaces a truncated, unclickable chip that forced retyping the id by eye. -->
            <!-- Not in plain words: a branch is git's name for the copy, and the plain review says what it holds instead. -->
            <span
                v-if="fleetAgent?.branch !== undefined && !maker"
                ref="identityAnchor"
                class="ui-status-pill hidden max-w-[16rem] shrink-0 items-center bg-overlay @2xl:inline-flex"
            >
                <SessionChip :branch="fleetAgent.branch" reveal @reveal="identityOpen = !identityOpen" />
            </span>
            <!-- Status compresses to its glyph in a narrow header; words return once the header itself has room. -->
            <span
                v-if="statusShown && status !== undefined"
                v-tooltip.top="status.label"
                class="inline-flex shrink-0 items-center gap-1 text-2xs"
                :class="status.class"
                :aria-label="status.label"
            >
                <Icon :name="status.icon" :spin="status.spin" :class="mobile ? `text-sm` : `text-2xs`" />
                <span :class="mobile ? `hidden @md:inline` : ``">{{ status.label }}</span>
            </span>
            <!-- Its place, held: the status arrives with the roster entry, and a header that grows one on arrival jumps. -->
            <span v-else-if="headerOutline" class="skeleton block h-2.5 w-14 shrink-0" aria-hidden="true"></span>
            <!-- What people have made of this session, beside the name of it. The size comes from this wrapper, not a
                 class on the component: its template is a fragment, so anything passed to it is dropped. -->
            <!-- On a phone they lead the session menu instead (AgentSessionMenu): the header's width is the title's there. -->
            <template v-if="fleetAgent !== undefined && !(mobile && sessionMenuShown)">
                <span class="inline-flex shrink-0 items-center text-2xs">
                    <AgentReactions ref="reactionChips" :agent-id="fleetAgent.id" :reactions="fleetAgent.reactions" :sandbox-id="remoteBox" dense />
                </span>
                <button
                    ref="reactTrigger"
                    type="button"
                    :class="ui.iconButton()"
                    :aria-label="t(`agents.agentReactions.addReaction`)"
                    v-tooltip.bottom="t(`agents.agentReactions.addReaction`)"
                    @click="openReactions"
                >
                    <Icon name="plus" class="text-2xs" />
                </button>
            </template>
            <template v-if="reviewable">
                <!-- A phone's Chat | Changes, folded into this row: its thumb rides the pages as a finger turns them. -->
                <ChatChangesSwitch v-if="paged" ref="pageSwitch" v-model="view" :pending="changes.pending.value.length" :id-prefix="PAGE_IDS" />
                <Icon v-if="changes.actionBusy.value" name="spinner" class="shrink-0 text-xs text-muted" spin />
                <ReviewFocusButton v-if="!mobile" />
                <!-- The page's one primary action: appearing only when something is pending is itself the "not landed" signal, replacing the toolbar's old pill. A phone draws it under the review instead (below). -->
                <AgentLandPress
                    v-if="landOffered"
                    :can-ship="canShip"
                    :requested="fleetAgent?.landRequested !== undefined"
                    :land-disabled="!canLand"
                    :requesting="requestingLand"
                    :land-hint="landHint"
                    :request-hint="requestLandHint"
                    :fix="fixPress"
                    @land="pressLand"
                    @request="requestLand"
                    @fix="changes.fixConflicts()"
                />
                <button
                    v-if="sessionMenuShown"
                    ref="menuAnchor"
                    type="button"
                    :class="ui.iconButton({ size: mobile ? `xl` : `md`, round: mobile })"
                    :aria-expanded="menuOpen"
                    @click="menuOpen = !menuOpen"
                    v-tooltip.bottom="t(`agents.agentDetail.sessionActions`)"
                    :aria-label="t(`agents.agentDetail.sessionActions`)"
                >
                    <Icon name="bars" :class="mobile ? `text-base` : `text-xs`" />
                </button>
            </template>
            <!-- The one press that costs a window switch, and says so: everything else here reads or settles work in place. -->
            <Button
                v-if="remoteName !== undefined"
                size="small"
                tier="boring"
                class="shrink-0 whitespace-nowrap"
                @click="crossToAgent"
                v-tooltip.bottom="t(`agents.agentDetail.switchesWindow`)"
            >
                <Icon name="arrow-right" />{{ t(`agents.words.openIn`) }} {{ remoteName }}
            </Button>
        </div>
        <AgentLandFailure v-if="fleetAgent !== undefined" :agent="fleetAgent" :can-ship="canShip" :busy="changes.actionBusy.value" @retry="changes.land('check')" />
        <p v-if="edit.error !== undefined" class="border-b border-line px-3 py-1 text-2xs text-danger">{{ edit.error }}</p>
        <!-- Here rather than inside the review: the presses that raise it are this header's and the session menu's, and
             the review is not on screen for either a phone reading the chat or a land pressed from the menu over it. -->
        <Notice v-if="changes.actionError.value" :of="changes.actionError.value" class="mx-2 mt-2 shrink-0" />
        <Notice
            v-else-if="landAsk.failure.value"
            :of="landAsk.failure.value"
            :dismiss-label="t(`ui.action.dismiss`)"
            class="mx-2 mt-2 shrink-0"
            @dismiss="landAsk.dismiss()"
        />
        <!-- A phone's chat and changes, as pages a finger turns. Local-only: a remote conversation lives elsewhere, so a
             phone gets the full review below instead. -->
        <SwipePages
            v-if="mobile && localOnly"
            v-model="view"
            :pages="pageIds"
            :follower="pageSwitch?.thumb"
            :id-prefix="PAGE_IDS"
            @wake="drawReview"
        >
            <!-- `:tabs="false"`: this screen's header names the conversation, as does the panel's own mobile header. -->
            <template #chat>
                <ChatPanel v-if="chatMounted" :tabs="false" class="min-h-0 flex-1" />
            </template>
            <template #changes>
                <!-- `chat` is the review asking to swap for the conversation, raised when it hands a land conflict back to the agent. -->
                <AgentReviewPanel
                    v-if="reviewDrawn"
                    :agent-id="agentId"
                    :at="remoteBox"
                    :changes="changes"
                    :streaming="streaming"
                    :writing="writing"
                    class="min-h-0 flex-1"
                    @chat="view = 'chat'"
                />
                <!-- The review ends in its one press, full width at the thumb, and leaves with its page. -->
                <div v-if="landPending" class="shrink-0 border-t border-line bg-card px-4 py-3">
                    <AgentLandPress
                        block
                        :can-ship="canShip"
                        :requested="fleetAgent?.landRequested !== undefined"
                        :land-disabled="!canLand"
                        :requesting="requestingLand"
                        :land-hint="landHint"
                        :request-hint="requestLandHint"
                        :fix="fixPress"
                        @land="pressLand"
                        @request="requestLand"
                        @fix="changes.fixConflicts()"
                    />
                </div>
            </template>
        </SwipePages>
        <!-- Still asking about this id: the review's frame and one line saying so, never another agent's review replayed. -->
        <template v-else-if="looking">
            <AgentReviewOutline v-if="outline" :label="t(`agents.agentDetail.openingAgentsReview`)" />
        </template>
        <!-- A remote agent with no review has three distinct reasons, told apart rather than collapsed into one guess. -->
        <p v-else-if="remote && !reviewable" class="px-3.5 py-3 text-xs text-muted">
            {{ remoteUnavailable }}
        </p>
        <!-- The review alone: a desktop's (its chat is the docked panel) and any remote agent's. -->
        <template v-else-if="agentId !== '' && reviewable">
            <AgentReviewPanel
                :agent-id="agentId"
                :at="remoteBox"
                :changes="changes"
                :streaming="streaming"
                :writing="writing"
                class="min-h-0 flex-1"
                @chat="view = 'chat'"
            />
            <!-- In plain words the review ends in its press, where the header would have carried it (landOffered). -->
            <div v-if="maker && landPending" class="shrink-0 border-t border-line bg-card px-4 py-3">
                <AgentLandPress
                    :block="mobile"
                    :can-ship="canShip"
                    :requested="fleetAgent?.landRequested !== undefined"
                    :land-disabled="!canLand"
                    :requesting="requestingLand"
                    :land-hint="landHint"
                    :request-hint="requestLandHint"
                    :fix="fixPress"
                    @land="pressLand"
                    @request="requestLand"
                    @fix="changes.fixConflicts()"
                />
            </div>
        </template>

        <!-- The phone's switcher, from the title above; desktop switches chats on the docked panel's own strip. -->
        <ChatSwitcherSheet v-if="mobile" v-model="switcherOpen" @select="switchTo" @close="closeTabs" @open="openPast" @new="startAgent()" />

        <!-- Session menu: one body, anchored on desktop or a thumb sheet on a phone. -->
        <ResponsiveOverlay
            v-model="menuOpen"
            :anchor="menuAnchor ?? undefined"
            :header="t(`agents.agentDetail.session`)"
            side="bottom"
            cross="end"
            panel-class="w-72"
        >
            <AgentSessionMenu
                :agent-id="agentId"
                :changes="changes"
                :streaming="streaming"
                :phone="mobile"
                :retry-land="fixPress !== undefined"
                :renameable="localOnly && !unnamed"
                :session-name="fleetAgent?.branch"
                @selected="closeMenu"
                @rename="edit.begin()"
                @identity="identityOpen = true"
                @discard="pendingDiscard = true"
                @force-land="pendingForceLand = true"
                @hand-over="openHandOver"
            />
        </ResponsiveOverlay>

        <!-- Session identity, in the same two dresses (anchored popover / sheet) as the menu above. -->
        <ResponsiveOverlay
            v-model="identityOpen"
            :anchor="identityAnchor ?? undefined"
            :header="t(`agents.words.sessionName`)"
            side="bottom"
            cross="start"
            panel-class="w-96"
        >
            <SessionIdentity v-if="fleetAgent?.branch !== undefined" :agent-id="agentId" :branch="fleetAgent.branch" />
        </ResponsiveOverlay>

        <!-- Mid-write land warns about the recoverable overwrite risk. -->
        <ConfirmDialog
            :open="pendingForceLand"
            :header="words.landWhileWorking"
            :description="words.landWhileWorkingBody"
            :confirm-label="words.landAnyway"
            :confirm-disabled="changes.actionBusy.value"
            :destructive="false"
            tone="warning"
            @cancel="pendingForceLand = false"
            @confirm="confirmForceLand"
        >
            <p class="text-xs text-muted">{{ t(`agents.agentDetail.nothingFinalArrivesUncommitted`) }}</p>
        </ConfirmDialog>

        <ConfirmDialog
            :open="pendingDiscard"
            :header="words.discardHeader"
            :description="
                t(
                    `agents.agentDetail.discardBody`,
                    { lead: words.discardBodyLead, count: changes.count.value, tail: words.discardBodyTail },
                    changes.count.value,
                )
            "
            :confirm-label="words.discard"
            :confirm-disabled="changes.actionBusy.value"
            @cancel="pendingDiscard = false"
            @confirm="confirmDiscard"
        >
            <p v-if="changes.count.value > changes.pending.value.length" class="text-xs text-muted">
                {{ t(`agents.agentDetail.workAlreadyLandedStays`) }}
            </p>
        </ConfirmDialog>

        <Modal
            :open="pendingHandOver"
            size="sm"
            :header="t(`agents.agentDetail.handOverHeader`)"
            :description="t(`agents.agentDetail.handOverBody`)"
            @update:open="pendingHandOver = false"
        >
            <div class="flex flex-col gap-3">
                <!-- Whoever is connected is one press; anyone else is an address. Both write the same field, so there is one confirm. -->
                <div v-if="presenceOthers.length > 0" class="flex flex-col gap-1">
                    <span class="text-2xs font-medium text-muted">{{ t(`agents.agentDetail.handOverConnected`) }}</span>
                    <button
                        v-for="member in presenceOthers"
                        :key="member.email"
                        type="button"
                        class="flex items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition-colors hover:bg-overlay"
                        :class="handOverTo === member.email ? 'bg-overlay' : ''"
                        :aria-pressed="handOverTo === member.email"
                        @click="handOverTo = member.email"
                    >
                        <Avatar :size="18" :name="member.name ?? member.email" :src="member.picture" :hue="identityHue(member.email)" />
                        <span class="truncate text-content">{{ member.name ?? member.email }}</span>
                        <span v-if="member.name !== undefined" class="truncate text-2xs text-subtle">{{ member.email }}</span>
                    </button>
                </div>
                <form class="flex flex-col gap-1" @submit.prevent="confirmHandOver">
                    <label class="text-2xs font-medium text-muted" for="hand-over-address">{{ t(`agents.agentDetail.handOverAddress`) }}</label>
                    <input
                        id="hand-over-address"
                        v-model="handOverTo"
                        type="email"
                        autocomplete="off"
                        placeholder="teammate@example.com"
                        :class="ui.input({ size: `sm` }, 'min-w-0')"
                    />
                </form>
                <p v-if="handOverError !== undefined" class="text-xs text-danger">{{ handOverError }}</p>
            </div>
            <template #footer>
                <Button tier="quiet" :label="t(`ui.action.cancel`)" @click="pendingHandOver = false" />
                <Button
                    :label="t(`agents.agentDetail.handOverConfirm`)"
                    :disabled="handOverBusy || handOverTo.trim() === ''"
                    @click="confirmHandOver"
                />
            </template>
        </Modal>
    </div>
</template>
