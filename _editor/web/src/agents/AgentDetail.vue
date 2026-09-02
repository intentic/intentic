<script setup lang="ts">
import { Button, ui, Modal, ResponsiveOverlay, SegmentedControl, useDevice } from "@intentic/ui";
import { computed, onUnmounted, ref, watch } from "vue";
import { RouterLink, useRoute, useRouter } from "vue-router";
import ChatPanel from "../chat/ChatPanel.vue";
import { agentStatusMeta, unregistered, writingNow } from "../composables/agents/agentStatus";
import { createInlineRename } from "../composables/inlineRename";
import { requestLandAgent } from "../composables/agents/agentActions";
import { boxNameOf, openInSandbox, otherFleet } from "../composables/agents/fleetScope";
import { otherBoxes, refreshAcross, subscribe as watchOtherBoxes } from "../composables/sandbox/fleetAcross";
import { useAgentChanges } from "../composables/agents/useAgentChanges";
import { useAgents } from "../composables/agents/useAgents";
import { useSandbox } from "../composables/sandbox/useSandbox";
import { useRole } from "../composables/sandbox/useRole";
import { useChat } from "../composables/chat/useChat";
import AgentReviewPanel from "./AgentReviewPanel.vue";
import AgentSessionMenu from "./AgentSessionMenu.vue";
import SessionChip from "./SessionChip.vue";
import SessionIdentity from "./SessionIdentity.vue";

/* Drill-in for one agent (/agents/:id): one canonical chat surface per form factor (the fleet-UX rule that
 * kills the duplicated-conversation problem):
 * - MOBILE: this IS the chat surface (no dock exists), Chat | Changes segmented, chat default.
 * - DESKTOP: the conversation lives ONLY in the docked ChatPanel (focused by the binding below); this view is
 *   review-only: the isolated diff + Land/Discard, the one job the dock can't host. A draft/unknown id has
 *   nothing to review → back to the board.
 *
 * THIS ROW OWNS THE SESSION; the panel below owns the review. That split is the whole point of the header:
 * everything here answers "what is this agent, and what do I want to happen to it": the title, the branch, the
 * one status chip, Land, and the ⋯ that holds the rest, while the panel's bars answer "what did it write".
 * They used to be interleaved across three stacked bars, which is how the page came to state its file count
 * four times and the word "landed" twice, in two different senses, twenty-four pixels apart. */

const route = useRoute();
const router = useRouter();
const { mobile } = useDevice();
const { fleet, refresh, open, agentById, archived, loadArchived, rename } = useAgents();
const { conversations, setActive } = useChat();
const { activeSandboxId } = useSandbox();

const agentId = computed(() => (typeof route.params[`id`] === `string` ? route.params[`id`] : ``));

/* THE REVIEW OF AN AGENT IN ANOTHER SANDBOX, named by `?sandbox=`.
 *
 * A query parameter rather than a second route, because it is the same page about the same kind of thing: one
 * agent's work, its diff, and the two presses that settle it. What the parameter changes is which daemon
 * answers, and every read and mutation below takes it (useAgentChanges, agentActions), so the page is the
 * board's promise kept: work is readable and landable from wherever you are standing.
 *
 * IT IS DROPPED WHEN IT NAMES THE ACTIVE SANDBOX, which is what makes the URL survive a switch. Cross to that
 * box (the "Open in" press below, or the switcher) and this page is looking at a local agent again, through
 * the local roster, the local chat and the local review, with no stale aim left pointing at a daemon that is
 * now simply "here". */
const routeBox = computed(() => (typeof route.query[`sandbox`] === `string` ? route.query[`sandbox`] : undefined));
const remoteBox = computed(() => (routeBox.value === activeSandboxId.value ? undefined : routeBox.value));
const remote = computed(() => remoteBox.value !== undefined);
const remoteName = computed(() => (remoteBox.value === undefined ? undefined : boxNameOf.value.get(remoteBox.value)));

/* Across both halves of the fleet: an ARCHIVED agent is off the board's roster but keeps its branch, diff and
 * transcript, so this page is still its destination: from the board's archive, from a bookmarked URL, and
 * from the moment the review panel's own Archive button fires under the user's cursor.
 *
 * A remote agent is looked up in the box's own roster instead (fleetAcross), which is the store that read it.
 * Deliberately not in `agentById`: agent ids are minted per sandbox, so an id that exists in both boxes would
 * otherwise render this box's agent under the other one's URL. */
const fleetAgent = computed(() =>
    remoteBox.value === undefined
        ? agentById(agentId.value)
        : otherFleet.value.find((agent) => agent.id === agentId.value && agent.sandboxId === remoteBox.value),
);

/* A REMOTE REVIEW KEEPS THE CROSS-SANDBOX STORE ALIVE FOR AS LONG AS IT IS OPEN, because this page can be
 * arrived at without the board: a bookmarked URL, a reload, a link opened in a tab of its own. Without it the
 * roster this page reads its agent's title and status out of would be whatever the board happened to leave
 * behind, and empty on a cold load. Disposed with the page, so an ordinary local review costs nothing. */
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
});

/* AN ID THIS TAB HAS NOT BEEN TOLD ABOUT IS NOT AN ID THAT DOESN'T EXIST, and the difference is the whole of
 * this block. Neither half of the fleet is guaranteed to be here when the page opens: the live roster arrives
 * on the events stream, so a reconnect, a restarted daemon or an agent created in another window can leave
 * this tab a roster behind, and the archive is not read at all until something asks for it.
 *
 * Read as absence, that produced two failures a reload "fixed", which is exactly how it was reported. With no
 * tab open for the id the page bounced back to the board. With one open (the usual case: the chat was just
 * pointed at this agent) it stayed and went HOLLOW: no fleet entry means not registered, not registered means
 * not reviewable, and the review query is keyed on that, so the header rendered over a review area that was
 * empty for good, fetching nothing, explaining nothing.
 *
 * So both halves are asked, once per id, and the decisions below wait for the answer. Then the page either
 * fills in or bounces on something the daemon actually said. */
const settling = ref(false);
let askedFor: string | undefined;
const settleLookup = (id: string): void => {
    if (askedFor === id) {
        return;
    }
    askedFor = id;
    settling.value = true;
    // A remote id is not in either local half and never will be: the read that can name it is that box's own
    // roster, so a "we haven't been told yet" here means the poll has not come back rather than a bad URL.
    if (remote.value) {
        refreshAcross();
        settling.value = false;
        return;
    }
    void Promise.all([refresh(), loadArchived()]).finally(() => (settling.value = false));
};
// Registered = has run a turn. Only a branch-backed registered conversation has a Changes review.
const registered = computed(() => fleetAgent.value !== undefined && !unregistered(fleetAgent.value.status));
const reviewable = computed(() => registered.value && fleetAgent.value?.branch !== undefined);
const conversation = computed(() => conversations.value.find((candidate) => candidate.conversationId === agentId.value));

// Bind the shared chat singleton to this agent's tab: open/create from the fleet entry, else focus the
// already-open conversation. Desktop additionally requires a REGISTERED agent (there must be a diff to
// review); a draft or unknown id bounces back to the board.
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
    // Unknown so far: ask both halves for it (once), and let the reads land before reading anything into
    // the silence. Either they name it, and this watch runs again on a roster that has it, or they don't.
    settleLookup(id);
    // No fleet entry means no registry entry, so there is no read marker to stamp: just focus the tab.
    if (conversation.value !== undefined) {
        setActive(conversation.value.conversationId);
        return;
    }
    if (settling.value) {
        return;
    }
    void router.replace(`/agents`);
};

// Keyed on the id + the roster SIZE, not the fleetAgent computed: its per-recompute object identity (and
// markSeen's write into the fleet source) would refire this watch forever. The archive counts toward that
// size: archiving the agent under review shrinks the roster by one and grows the archive by one, and only
// watching the first would bounce the user off the page they are reading.
watch(
    [agentId, () => fleet.value.length + archived.value.length, settling],
    ([id], [previousId] = [undefined, 0, false]) => {
        /* NONE OF THE BINDING ABOVE APPLIES TO AN AGENT IN ANOTHER BOX, and running it would do real damage
         * rather than merely nothing. `open()` files a conversation into the chat singleton, which is pointed
         * at THIS daemon: it would mint a tab for an agent that daemon has never heard of, whose first message
         * would start a turn in the wrong sandbox. The bounce at the end is the other half: a remote agent is
         * legitimately absent from both local halves, which that path reads as "no such agent" and answers by
         * sending the reader back to the board.
         *
         * A remote review has no chat surface at all, on either form factor. That is the design's line rather
         * than an omission: read and land from anywhere, converse where the agent lives, and the header offers
         * the crossing that gets you there. */
        if (remote.value) {
            settleLookup(id);
            return;
        }
        bindLocalConversation(id, previousId);
    },
    { immediate: true },
);

// Mobile-only mode switch; desktop always renders the review.
const view = ref<`chat` | `changes`>(mobile.value ? `chat` : `changes`);
const viewOptions: { label: string; value: `chat` | `changes` }[] = [
    { label: `Chat`, value: `chat` },
    { label: `Changes`, value: `changes` },
];

const title = computed(() => fleetAgent.value?.title ?? conversation.value?.title.value ?? `Agent`);

const edit = createInlineRename(
    () => fleetAgent.value?.title ?? conversation.value?.title.value ?? undefined,
    (name) => rename(agentId.value, name),
    `Couldn't rename the agent.`,
);

// The card's own status glyph, carried into the header: the one piece of fleet state the review below can't
// tell you (it reports the work, not whether the agent is still writing it). It is also the page's ONLY
// statement of whether the work landed: the review's toolbar used to carry a second "✓ landed" chip a line
// below this one, meaning "every file reached the workspace" where this one means "the last turn landed":
// two scopes, one word, stacked.
const status = computed(() => (fleetAgent.value === undefined ? undefined : agentStatusMeta(fleetAgent.value.status)));

/* THE REVIEW'S STATE, owned here and handed to the panel. One instance, because the actions are split across
 * the two components now: Land and the ⋯ menu fire from this row, the conflict report's merge/resolve fire
 * from the panel, and a second useAgentChanges() would give each its own busy and error flags. The query
 * behind it is keyed by agent id, so this is also the only fetch. */
// Empty until the agent is known to HAVE a review (registered, branch-backed), see useAgentChanges: this is
// created for the page, which outlives the panel, so a draft agent must not send it looking for a diff.
const changes = useAgentChanges(
    computed(() => (reviewable.value ? agentId.value : ``)),
    remoteBox,
);
// A remote agent has no conversation in this browser by construction, so nothing here is streaming its turn.
// That is what the review's own offers read to decide whether a land would catch the agent mid-sentence, and
// `writing` below answers it from the roster instead, which is a fact about the agent rather than about us.
const streaming = computed(() => !remote.value && conversation.value?.streaming.value === true);

/* Discard stays gated on the turn: it takes the worktree away and the daemon refuses it outright while one
 * runs. Land does not, any more: it only READS that checkout, so the daemon lets it through whenever nobody is
 * mid-sentence and asks for an explicit override when someone is (agents.routes.ts landable).
 *
 * So the button is live in every state that has something to apply, and `writing` decides which of the two
 * presses it is: a plain land, or the one that opens the warning first. Read off the FLEET status rather than
 * off `streaming`: this browser's stream is open for a parked turn exactly as it is for a working one, which
 * is what made "wait for the agent turn to finish" the answer to a card that was waiting for the user. */
const writing = computed(() => fleetAgent.value !== undefined && writingNow(fleetAgent.value));
const canLand = computed(() => !changes.actionBusy.value && changes.pending.value.length > 0);
// A live turn that is NOT writing: parked on a question or a permission card, or unwinding a Stop. Its land is
// an ordinary one, and saying so is the point: this is the state the old copy called "running".
const parked = computed(() => streaming.value && !writing.value);
// What the button says it will do, in the three states it can be pressed in.
const landHint = computed(() =>
    writing.value
        ? `The agent is still writing: you'll be asked to confirm`
        : parked.value
          ? `Applies what the agent has written so far`
          : `Applies ${changes.pending.value.length} change(s) to your workspace`,
);
/* The mid-write land, behind the one modal it warrants. Not a tooltip and not a quiet press: this is the only
 * land that can carry half-finished work, and the two facts that make it recoverable (it arrives uncommitted,
 * and the rest of the turn lands on top at completion) are exactly what the user needs in front of them to
 * judge it. A press on a parked or resting agent skips all of this and just lands. */
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
    await changes.land(`check`, `outstanding`, true);
};

// The role split on the toolbar's primary action: maintainers land, collaborators ask (the daemon floors the
// land itself: see AgentCard for the same split on the board).
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

/* WHAT A REMOTE REVIEW DOES NOT OFFER, in one place rather than as a condition repeated down the template.
 *
 * Renaming, archiving and the auto-land toggle all go through the fleet store, which IS the active daemon's
 * roster: it holds no entry for another box's agent, so those presses would address the wrong sandbox or
 * nothing at all. Handing the conflict back to the agent is the same line drawn one step further along, since
 * it sends a message and a message needs a conversation.
 *
 * They are ABSENT rather than disabled, and the crossing is offered in their place. A disabled button that
 * would work perfectly well one press away is a worse answer than a button that says where to press. */
const localOnly = computed(() => !remote.value);

/* WHY THERE IS NOTHING TO REVIEW, when the agent is in another box and the page has nothing to draw.
 *
 * `heardFrom` is the difference between "we have not been told" and "we were told, and this agent is not in
 * it": the store records when each box last answered, whatever that answer contained (fleetAcross's `readAt`),
 * so a box with a roster that simply lacks this id is a positive answer and gets a sentence that says so. A
 * bookmarked URL for a discarded agent lands there, which is the case the old wording described as a sandbox
 * failing to answer. */
const heardFrom = computed(() => remoteBox.value !== undefined && otherBoxes.value.some((box) => box.sandbox.id === remoteBox.value && box.readAt !== undefined));
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

/* The session's name and the session's actions, each in the app's standard touch swap: anchored beside their
 * trigger on desktop, a thumb-reachable sheet on a phone. Both were the hand-written pair <ResponsiveOverlay>
 * exists to replace: a <BottomSheet> under `v-if="mobile"`, a PrimeVue <Popover> under `v-else`, and TWO open
 * flags between them (a `*Sheet` boolean plus the popover's own internal state), which is the drift that
 * component's header comment names. One flag each now, and the desktop half is measured against the window its
 * anchor is in rather than the module-scope one. */
const identityAnchor = ref<HTMLElement | null>(null);
const identityOpen = ref(false);

const menuAnchor = ref<HTMLButtonElement | null>(null);
const menuOpen = ref(false);
const closeMenu = (): void => {
    menuOpen.value = false;
};

// Destructive and unrecoverable (the branch and worktree go), so it asks in the same modal every other
// irreversible git action in this app uses.
const pendingDiscard = ref(false);
const confirmDiscard = async (): Promise<void> => {
    pendingDiscard.value = false;
    await changes.discard();
};
</script>

<template>
    <div class="flex h-full min-h-0 flex-col">
        <!-- A @container: the header thins out against ITS OWN width, which is the workspace pane's and not
             the window's: with the chat panel open the two are nowhere near each other. -->
        <div class="view-header @container flex items-center gap-2.5 border-b border-line px-3.5 py-1">
            <!-- The board is a place, so the way back to it is a link: hoverable, copyable, and openable in
                 a tab of its own beside the agent being read. -->
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
                <span class="min-w-0 flex-1 truncate text-xs font-medium text-content">{{ title }}</span>
                <button
                    v-if="localOnly"
                    type="button"
                    aria-label="Rename agent"
                    v-tooltip.bottom="'Rename'"
                    :class="ui.iconButton()"
                    @click="edit.begin()"
                >
                    <Icon name="pencil" class="text-xs" />
                </button>
            </template>
            <!-- WHICH SANDBOX THIS AGENT IS IN, on a page that is otherwise about one agent in the box you are
                 standing in. It is not decoration: every number below (the diff, the file count, what Land
                 would apply) is about a workspace on another machine, and a header that did not say so would be
                 the single most misreadable screen in the app. -->
            <span
                v-if="remoteName !== undefined"
                class="inline-flex shrink-0 items-center gap-1 rounded bg-overlay px-1.5 py-px text-2xs text-muted"
                v-tooltip.bottom="`This agent is in ${remoteName}, not in the sandbox you're in`"
            >
                <Icon name="server" class="text-2xs" />
                <span class="max-w-[10rem] truncate">{{ remoteName }}</span>
            </span>
            <!-- THE SESSION'S NAME, and the way to get hold of it. This chip used to be a picture of the name:
                 cut off at a fixed width, hoverable to see the rest, and impossible to put on a clipboard, so
                 the only route to the id every git command, worktree path and CLI verb needs was to read
                 thirty-six characters off the screen and retype them. Pressing it now opens the one panel that
                 states the name in all three forms anyone pastes it in.
                 It survives into a narrow header as the bare glyph rather than vanishing: this row has no width
                 for a branch name there, but hiding the chip made the identity of the thing on screen unreachable
                 exactly where retyping it is worst. -->
            <span
                v-if="fleetAgent?.branch !== undefined"
                ref="identityAnchor"
                class="hidden max-w-[16rem] shrink-0 items-center rounded bg-overlay px-1.5 py-px @2xl:inline-flex"
            >
                <SessionChip :branch="fleetAgent.branch" reveal @reveal="identityOpen = !identityOpen" />
            </span>
            <SessionChip v-if="fleetAgent?.branch !== undefined && mobile" :branch="fleetAgent.branch" reveal compact @reveal="identityOpen = true" />
            <!-- THE STATUS COMPRESSES TO ITS GLYPH IN A NARROW HEADER, and on mobile that is now the only
                 fixed-width thing left competing with the title: the Chat | Changes switch moved to a row of
                 its own below (see there for why). The words return the moment the HEADER, not the window, has
                 room for them, so a phone in landscape and a narrow desktop column both get the sentence. The
                 chip keeps its full accessible name at every width, so nothing is lost to a screen reader.
                 Kept on `mobile` rather than on `mobile && reviewable`: what makes the row tight is the phone,
                 and a draft chat's header carries the same back arrow, title, pencil and chip as any other. -->
            <span
                v-if="status !== undefined"
                class="inline-flex shrink-0 items-center gap-1 text-2xs"
                :class="status.class"
                :aria-label="status.label"
            >
                <Icon :name="status.icon" :spin="status.spin" class="text-2xs" aria-hidden="true" />
                <span :class="mobile ? `hidden @md:inline` : ``">{{ status.label }}</span>
            </span>
            <template v-if="reviewable">
                <Icon v-if="changes.actionBusy.value" name="spinner" class="shrink-0 text-xs text-muted" spin />
                <!-- The page's one primary action, beside the status chip that says whether it is even needed.
                     It appears only when there is something to apply, so the button's presence IS the "not
                     landed" signal the toolbar below used to spend a pill on. -->
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
                <!-- The collaborator's copy of the press above: same spot, quieter chrome, and once asked it
                     becomes the fact instead of the button (the daemon floors the land itself at maintainer). -->
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
            <!-- THE ONE PRESS THAT COSTS A SWITCH, and it says so. Everything else on this page reads or
                 settles the work where the reader stands; talking to the agent needs the chat pointed at its
                 daemon, so this is the door rather than a Reply box that would move the whole app under them. -->
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
        <!-- CHAT | CHANGES OWNS A ROW ON A PHONE, instead of riding the header above.
             It was the single biggest thing in that row: a two-word switch is ~120px, and the row also
             carries a back arrow, the title, a rename pencil, the session chip, the status and the actions
             menu. Measured at 390px the title was left 55px for a string that needs 250: "Add Stripe checkout
             to the pricing page" rendered as "Add St…", which is not a title, it is a shrug.
             The `stretch` variant is the one built for this: SegmentedControl's own note calls it right when
             "the choice is a step of the task on a narrow screen", so the two views become equal halves of a
             full-width track at a thumb's height, and the header gets its width back. It costs ~36px and the
             header stops needing the second line it was effectively wrapping onto. -->
        <!-- The switch is local-only for the same reason the chat below is: there is no Chat half to switch to
             for an agent whose conversation lives on another machine, so a phone gets the review full-width. -->
        <div v-if="mobile && reviewable && localOnly" class="shrink-0 border-b border-line px-2 py-1.5">
            <SegmentedControl v-model="view" :options="viewOptions" stretch />
        </div>
        <!-- `:tabs="false"`: this screen's header already names the conversation, and the panel's own mobile
             header named it again directly beneath (see ChatPanel for the full reasoning). -->
        <ChatPanel v-if="mobile && localOnly && (view === 'chat' || !reviewable)" :tabs="false" class="min-h-0 flex-1" />
        <!-- A remote agent with no review to draw, and the THREE reasons that can be true, told apart rather
             than collapsed into one guess. Drawing an empty review for any of them would read as "this agent
             changed nothing", which is a claim, and two of the three are the absence of an answer rather than
             an answer. The first version of this said "hasn't answered yet" for all of them, and said it over a
             box that had answered perfectly well and simply did not have this id: the same mistake this design
             keeps catching, an unknown rendered as a fact. -->
        <p v-else-if="remote && !reviewable" class="px-3.5 py-3 text-xs text-muted">
            {{ remoteUnavailable }}
        </p>
        <!-- `chat` is the review asking to be swapped for the conversation: raised when it hands a land
             conflict back to the agent and offers to show the turn. Desktop never sees it: the docked chat is
             already on screen there, so the review has nothing to swap itself for. -->
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

        <!-- The session menu: anchored beside its button on desktop, a thumb-reachable sheet on a phone, one
             body either way. `land-in-menu` is the one thing that differs, and it tracks the FORM rather than
             the surface: landing has its own button in the header on desktop, and no room for one on a phone. -->
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

        <!-- The session's identity, in the same two dresses as the menu above it. -->
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

        <!-- THE MID-WRITE LAND'S WARNING. It states the one real risk and both reasons it is survivable,
             because a warning that only says "are you sure" teaches people to click through it. -->
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
