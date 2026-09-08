<script setup lang="ts">
import { Button, ui, Modal, ResponsiveOverlay, SegmentedControl, useDevice, useLoadingReveal } from "@intentic/ui";
import { computed, onUnmounted, ref, watch } from "vue";
import { RouterLink, useRoute, useRouter } from "vue-router";
import ChatPanel from "../../chat/panel/ChatPanel.vue";
import { agentStatusMeta, unregistered, writingNow } from "../fleet/agentStatus";
import { createInlineRename } from "../../../lib/inlineRename";
import { requestLandAgent } from "../fleet/agentActions";
import { boxNameOf, openInSandbox, otherFleet } from "../fleet/fleetScope";
import { otherBoxes, refreshAcross, subscribe as watchOtherBoxes } from "../../sandbox/live/fleetAcross";
import { useAgentChanges } from "./useAgentChanges";
import { useAgents } from "../fleet/useAgents";
import { useSandbox } from "../../sandbox/client/useSandbox";
import { useRole } from "../../sandbox/secrets/useRole";
import { useChat } from "../../chat/run/useChat";
import AgentReviewPanel from "./AgentReviewPanel.vue";
import AgentReviewOutline from "./AgentReviewOutline.vue";
import AgentSessionMenu from "../board/AgentSessionMenu.vue";
import SessionChip from "../board/SessionChip.vue";
import SessionIdentity from "../board/SessionIdentity.vue";

// Drill-in for one agent (/agents/:id): one canonical chat surface per form factor.
// - mobile: this IS the chat surface, Chat | Changes segmented, chat by default
// - desktop: the conversation lives only in the docked ChatPanel; this view is review-only (diff, Land, Discard)
//
// This row owns the session; the panel below owns the review.

const route = useRoute();
const router = useRouter();
const { mobile } = useDevice();
const { fleet, refresh, open, agentById, archived, loadArchived, rename } = useAgents();
const { conversations, setActive, closeTabs } = useChat();
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

// Mode switch only exists on mobile; desktop always renders the review.
const view = ref<`chat` | `changes`>(mobile.value ? `chat` : `changes`);
const viewOptions: { label: string; value: `chat` | `changes` }[] = [
    { label: `Chat`, value: `chat` },
    { label: `Changes`, value: `changes` },
];

// The name this page can honestly print: the roster's, or the open conversation's. Absent while the id is still a
// question, which the header draws as a bar rather than filling with the word "Agent".
const named = computed(() => fleetAgent.value?.title ?? conversation.value?.title.value);
const title = computed(() => named.value ?? `Agent`);

const edit = createInlineRename(
    () => fleetAgent.value?.title ?? conversation.value?.title.value ?? undefined,
    (name) => rename(agentId.value, name),
    `Couldn't rename the agent.`,
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
const streaming = computed(() => !remote.value && conversation.value?.streaming.value === true);

// Land only reads the checkout, so it's live whenever anything is pending, unlike Discard (worktree-gated,
// refused mid-turn). `writing` (fleet status, not `streaming`) decides which press it is, since a parked turn
// still streams.
const writing = computed(() => fleetAgent.value !== undefined && writingNow(fleetAgent.value));
const canLand = computed(() => !changes.actionBusy.value && changes.pending.value.length > 0);
// A live turn that isn't writing: parked on a question, permission, or a Stop unwind; land is ordinary.
const parked = computed(() => streaming.value && !writing.value);
// What the Land button promises, across the three states it can be pressed in.
const landHint = computed(() =>
    writing.value
        ? `The agent is still writing: you'll be asked to confirm`
        : parked.value
          ? `Applies what the agent has written so far`
          : `Applies ${changes.pending.value.length} change(s) to your workspace`,
);
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
const requestingLand = ref(false);
const requestLand = async (): Promise<void> => {
    if (requestingLand.value) {
        return;
    }
    requestingLand.value = true;
    try {
        await requestLandAgent(agentId.value, remoteBox.value);
        await (remote.value ? Promise.resolve(refreshAcross()) : refresh());
    } finally {
        requestingLand.value = false;
    }
};

// What a remote review can't offer, gated in one place: rename/archive/auto-land address the fleet store (this
// daemon's roster only), and asking the agent needs a conversation. Absent rather than disabled, with the
// crossing offered instead.
const localOnly = computed(() => !remote.value);

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
    const name = remoteName.value ?? `That sandbox`;
    if (fleetAgent.value !== undefined) {
        return `This agent has no branch to review.`;
    }
    return heardFrom.value
        ? `${name} doesn't have this agent any more: it may have been discarded, or its id belongs to another sandbox.`
        : `${name} hasn't answered yet, so there's nothing to show for this agent.`;
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

// Destructive and unrecoverable (branch and worktree go); same confirm modal as other irreversible git actions.
const pendingDiscard = ref(false);
const confirmDiscard = async (): Promise<void> => {
    pendingDiscard.value = false;
    await changes.discard();
};
</script>

<template>
    <div class="flex h-full min-h-0 flex-col">
        <!-- A @container: the header thins against its own width (the workspace pane's), not the window's. -->
        <div class="view-header @container flex items-center gap-2.5 border-b border-line px-3.5 py-1">
            <!-- The board is a place, so the way back is a link: hoverable, copyable, openable in its own tab. -->
            <RouterLink
                to="/agents"
                class="flex h-7 w-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-overlay hover:text-content"
                aria-label="Back to agents"
            >
                <Icon name="arrow-left" class="text-sm" />
            </RouterLink>
            <input
                v-if="edit.editing"
                v-model="edit.draft"
                type="text"
                maxlength="80"
                aria-label="Agent title"
                class="ui-field-box ui-field-inline min-w-0 flex-1 px-1 text-xs font-medium"
                @keydown.enter.prevent="edit.commit()"
                @keydown.esc.prevent="edit.cancel()"
                @blur="edit.blurCommit()"
                @vue:mounted="edit.focusInput"
            />
            <template v-else>
                <!-- Nobody has named this agent yet: a bar in the title's own place, and no rename over a missing name. -->
                <span v-if="unnamed" class="flex min-w-0 flex-1 items-center" aria-hidden="true">
                    <span class="skeleton block h-3 w-40 max-w-full"></span>
                </span>
                <span v-else class="min-w-0 flex-1 truncate text-xs font-medium text-content">{{ title }}</span>
                <button
                    v-if="localOnly && !unnamed"
                    type="button"
                    aria-label="Rename agent"
                    v-tooltip.bottom="'Rename'"
                    :class="ui.iconButton()"
                    @click="edit.begin()"
                >
                    <Icon name="pencil" class="text-xs" />
                </button>
            </template>
            <!--
                Which sandbox this agent is in, not decoration: every number below (diff, file count, what Land
                applies) is
                about a workspace on another machine.
            -->
            <span
                v-if="remoteName !== undefined"
                class="inline-flex shrink-0 items-center gap-1 rounded bg-overlay px-1.5 py-px text-2xs text-muted"
                v-tooltip.bottom="`This agent is in ${remoteName}, not in the sandbox you're in`"
            >
                <Icon name="server" class="text-2xs" />
                <span class="max-w-[10rem] truncate">{{ remoteName }}</span>
            </span>
            <!--
                Session name, pasteable: replaces a truncated, unclickable chip that forced retyping the id by eye.
                Survives
                into a narrow header as the bare glyph rather than vanishing, since that's exactly where retyping is
                worst.
            -->
            <span
                v-if="fleetAgent?.branch !== undefined"
                ref="identityAnchor"
                class="hidden max-w-[16rem] shrink-0 items-center rounded bg-overlay px-1.5 py-px @2xl:inline-flex"
            >
                <SessionChip :branch="fleetAgent.branch" reveal @reveal="identityOpen = !identityOpen" />
            </span>
            <SessionChip v-if="fleetAgent?.branch !== undefined && mobile" :branch="fleetAgent.branch" reveal compact @reveal="identityOpen = true" />
            <!--
                Status compresses to its glyph in a narrow header; words return once the header itself has room. Kept
                on
                `mobile` alone, since a draft's header is exactly as tight as any other's.
            -->
            <span
                v-if="status !== undefined"
                class="inline-flex shrink-0 items-center gap-1 text-2xs"
                :class="status.class"
                :aria-label="status.label"
            >
                <Icon :name="status.icon" :spin="status.spin" class="text-2xs" aria-hidden="true" />
                <span :class="mobile ? `hidden @md:inline` : ``">{{ status.label }}</span>
            </span>
            <!-- Its place, held: the status arrives with the roster entry, and a header that grows one on arrival jumps. -->
            <span v-else-if="headerOutline" class="skeleton block h-2.5 w-14 shrink-0" aria-hidden="true"></span>
            <template v-if="reviewable">
                <Icon v-if="changes.actionBusy.value" name="spinner" class="shrink-0 text-xs text-muted" spin />
                <!--
                    The page's one primary action: appearing only when something is pending is itself the "not landed"
                    signal,
                    replacing the toolbar's old pill.
                -->
                <Button
                    v-if="!mobile && changes.pending.value.length > 0 && canShip"
                    size="small"
                    severity="success"
                    class="shrink-0 whitespace-nowrap"
                    :disabled="!canLand"
                    @click="pressLand"
                    v-tooltip.bottom="landHint"
                >
                    <Icon name="check" />Land now
                </Button>
                <!-- The collaborator's copy of the button above; once asked it becomes a fact instead of a press. -->
                <span
                    v-else-if="!mobile && changes.pending.value.length > 0 && canDrive && fleetAgent?.landRequested !== undefined"
                    class="inline-flex shrink-0 items-center gap-1 text-2xs text-muted"
                >
                    <Icon name="clock" class="text-2xs" />Land requested
                </span>
                <Button
                    v-else-if="!mobile && changes.pending.value.length > 0 && canDrive"
                    size="small"
                    severity="secondary"
                    class="shrink-0 whitespace-nowrap"
                    :disabled="requestingLand"
                    @click="requestLand"
                    v-tooltip.bottom="'Landing needs a maintainer: this puts the ask on their board'"
                >
                    <Icon :name="requestingLand ? 'spinner' : 'send'" :spin="requestingLand" />Request land
                </Button>
                <button
                    v-if="localOnly"
                    ref="menuAnchor"
                    type="button"
                    :class="ui.iconButton(`h-7 w-7`)"
                    :aria-expanded="menuOpen"
                    @click="menuOpen = !menuOpen"
                    v-tooltip.bottom="'Session actions'"
                    aria-label="Session actions"
                >
                    <Icon name="bars" class="text-xs" />
                </button>
            </template>
            <!--
                The one press that costs a window switch, and says so: everything else here reads or settles work in
                place, but
                talking to the agent needs the chat pointed at its own daemon.
            -->
            <Button
                v-if="remoteName !== undefined"
                size="small"
                severity="secondary"
                class="shrink-0 whitespace-nowrap"
                @click="crossToAgent"
                v-tooltip.bottom="`Switches this window to ${remoteName}, where its conversation lives`"
            >
                <Icon name="arrow-right" />Open in {{ remoteName }}
            </Button>
        </div>
        <p v-if="edit.error !== undefined" class="border-b border-line px-3 py-1 text-2xs text-danger">{{ edit.error }}</p>
        <!--
            Chat|Changes gets its own row on a phone: crowding the header left too little width for the title.
            `stretch`
            fits a narrow-screen mode choice, costing ~36px to give the header its width back.
        -->
        <!-- Local-only like the chat below; a remote conversation lives elsewhere, so mobile gets the full review. -->
        <div v-if="mobile && reviewable && localOnly" class="shrink-0 border-b border-line px-2 py-1.5">
            <SegmentedControl v-model="view" :options="viewOptions" stretch />
        </div>
        <!-- `:tabs="false"`: this screen's header names the conversation, as does the panel's own mobile header. -->
        <ChatPanel v-if="mobile && localOnly && (view === 'chat' || !reviewable)" :tabs="false" class="min-h-0 flex-1" />
        <!--
            Still asking about this id: the review's own shape stands in, since an empty pane reads as an agent that
            changed nothing and the sentence below would be answering a question that hasn't come back yet. Claims the
            branch for the whole wait, drawing nothing under the reveal delay.
        -->
        <template v-else-if="looking">
            <AgentReviewOutline v-if="outline" label="Opening this agent's review…" />
        </template>
        <!--
            A remote agent with no review has three distinct reasons, told apart rather than collapsed into one guess:
            drawing an empty review would falsely read as "this agent changed nothing".
        -->
        <p v-else-if="remote && !reviewable" class="px-3.5 py-3 text-xs text-muted">
            {{ remoteUnavailable }}
        </p>
        <!--
            `chat` is the review asking to swap for the conversation, raised when it hands a land conflict back to the
            agent; desktop never sees it since the docked chat is already on screen.
        -->
        <AgentReviewPanel
            v-else-if="agentId !== '' && reviewable"
            :agent-id="agentId"
            :at="remoteBox"
            :changes="changes"
            :streaming="streaming"
            :writing="writing"
            class="min-h-0 flex-1"
            @chat="view = 'chat'"
        />

        <!--
            Session menu: one body, anchored on desktop or a thumb sheet on a phone. `land-in-menu` tracks form factor,
            since desktop has its own header Land button and a phone has no room for one.
        -->
        <ResponsiveOverlay v-model="menuOpen" :anchor="menuAnchor ?? undefined" header="Session" side="bottom" cross="end" panel-class="w-72">
            <AgentSessionMenu
                :agent-id="agentId"
                :changes="changes"
                :streaming="streaming"
                :land-in-menu="mobile"
                @selected="closeMenu"
                @discard="pendingDiscard = true"
                @force-land="pendingForceLand = true"
            />
        </ResponsiveOverlay>

        <!-- Session identity, in the same two dresses (anchored popover / sheet) as the menu above. -->
        <ResponsiveOverlay
            v-model="identityOpen"
            :anchor="identityAnchor ?? undefined"
            header="Session name"
            side="bottom"
            cross="start"
            panel-class="w-96"
        >
            <SessionIdentity v-if="fleetAgent?.branch !== undefined" :agent-id="agentId" :branch="fleetAgent.branch" />
        </ResponsiveOverlay>

        <!--
            The mid-write land's warning states the one real risk and both reasons it's recoverable, since a bare "are
            you
            sure" just teaches people to click through.
        -->
        <Modal :open="pendingForceLand" size="sm" header="Land while the agent is working?" @update:open="pendingForceLand = false">
            <p class="text-xs text-content">
                The agent is still writing. Landing now takes its work exactly as it stands, which can mean half-finished changes: one side of a
                rename, or three files of a larger edit.
            </p>
            <p class="mt-2 text-xs text-muted">
                Nothing is final: this arrives as uncommitted changes for you to review, and the rest of the turn lands on top of it when the agent
                finishes.
            </p>
            <template #footer>
                <Button size="small" severity="secondary" :text="true" label="Cancel" @click="pendingForceLand = false" />
                <Button size="small" severity="warn" label="Land anyway" :disabled="changes.actionBusy.value" @click="confirmForceLand" />
            </template>
        </Modal>

        <Modal :open="pendingDiscard" size="sm" header="Discard this agent's work" @update:open="pendingDiscard = false">
            <p class="text-xs text-content">
                Delete the agent's branch and worktree? Its {{ changes.count.value }} changed file{{ changes.count.value === 1 ? "" : "s" }} and the
                conversation's isolated history go with them.
            </p>
            <p v-if="changes.count.value > changes.pending.value.length" class="mt-2 text-xs text-muted">
                Work that already landed stays in your workspace: only what is still on the branch is lost.
            </p>
            <template #footer>
                <Button size="small" severity="secondary" :text="true" label="Cancel" @click="pendingDiscard = false" />
                <Button size="small" severity="danger" label="Discard" :disabled="changes.actionBusy.value" @click="confirmDiscard" />
            </template>
        </Modal>
    </div>
</template>
