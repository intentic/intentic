<script setup lang="ts">
import Button from "primevue/button";
import { BottomSheet, cmp, Segmented, useDevice } from "@intentic/ui";
import Dialog from "primevue/dialog";
import Popover from "primevue/popover";
import { computed, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import ChatPanel from "../chat/ChatPanel.vue";
import { agentStatusMeta, unregistered, writingNow } from "../composables/agents/agentStatus";
import { createTitleEdit } from "../composables/agents/titleEdit";
import { requestLandAgent } from "../composables/agents/agentActions";
import { useAgentChanges } from "../composables/agents/useAgentChanges";
import { useAgents } from "../composables/agents/useAgents";
import { useRole } from "../composables/sandbox/useRole";
import { useChat } from "../composables/chat/useChat";
import AgentReviewPanel from "./AgentReviewPanel.vue";
import AgentSessionMenu from "./AgentSessionMenu.vue";
import SessionChip from "./SessionChip.vue";
import SessionIdentity from "./SessionIdentity.vue";

/* Drill-in for one agent (/agents/:id) — one canonical chat surface per form factor (the fleet-UX rule that
 * kills the duplicated-conversation problem):
 * - MOBILE: this IS the chat surface (no dock exists) — Chat | Changes segmented, chat default.
 * - DESKTOP: the conversation lives ONLY in the docked ChatPanel (focused by the binding below); this view is
 *   review-only — the isolated diff + Land/Discard, the one job the dock can't host. A draft/unknown id has
 *   nothing to review → back to the board.
 *
 * THIS ROW OWNS THE SESSION; the panel below owns the review. That split is the whole point of the header:
 * everything here answers "what is this agent, and what do I want to happen to it" — the title, the branch, the
 * one status chip, Land, and the ⋯ that holds the rest — while the panel's bars answer "what did it write".
 * They used to be interleaved across three stacked bars, which is how the page came to state its file count
 * four times and the word "landed" twice, in two different senses, twenty-four pixels apart. */

const route = useRoute();
const router = useRouter();
const { mobile } = useDevice();
const { fleet, refresh, open, agentById, archived, loadArchived } = useAgents();
const { conversations, setActive } = useChat();

const agentId = computed(() => (typeof route.params[`id`] === `string` ? route.params[`id`] : ``));
// Across both halves of the fleet: an ARCHIVED agent is off the board's roster but keeps its branch, diff and
// transcript, so this page is still its destination — from the board's archive, from a bookmarked URL, and
// from the moment the review panel's own Archive button fires under the user's cursor.
const fleetAgent = computed(() => agentById(agentId.value));

/* AN ID THIS TAB HAS NOT BEEN TOLD ABOUT IS NOT AN ID THAT DOESN'T EXIST, and the difference is the whole of
 * this block. Neither half of the fleet is guaranteed to be here when the page opens: the live roster arrives
 * on the events stream, so a reconnect, a restarted daemon or an agent created in another window can leave
 * this tab a roster behind, and the archive is not read at all until something asks for it.
 *
 * Read as absence, that produced two failures a reload "fixed" — which is exactly how it was reported. With no
 * tab open for the id the page bounced back to the board. With one open (the usual case: the chat was just
 * pointed at this agent) it stayed and went HOLLOW: no fleet entry means not registered, not registered means
 * not reviewable, and the review query is keyed on that — so the header rendered over a review area that was
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
    void Promise.all([refresh(), loadArchived()]).finally(() => (settling.value = false));
};
// Registered = has run a turn. Only a branch-backed registered conversation has a Changes review.
const registered = computed(() => fleetAgent.value !== undefined && !unregistered(fleetAgent.value.status));
const reviewable = computed(() => registered.value && fleetAgent.value?.branch !== undefined);
const conversation = computed(() => conversations.value.find((candidate) => candidate.conversationId === agentId.value));

// Bind the shared chat singleton to this agent's tab: open/create from the fleet entry, else focus the
// already-open conversation. Desktop additionally requires a REGISTERED agent (there must be a diff to
// review); a draft or unknown id bounces back to the board. Keyed on the id + the roster SIZE, not the
// fleetAgent computed — its per-recompute object identity (and markSeen's write into the fleet source)
// would refire this watch forever. The archive counts toward that size: archiving the agent under review
// shrinks the roster by one and grows the archive by one, and only watching the first would bounce the user
// off the page they are reading.
watch(
    [agentId, () => fleet.value.length + archived.value.length, settling],
    ([id], [previousId] = [undefined, 0, false]) => {
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
        // Unknown so far — ask both halves for it (once), and let the reads land before reading anything into
        // the silence. Either they name it, and this watch runs again on a roster that has it, or they don't.
        settleLookup(id);
        // No fleet entry means no registry entry, so there is no read marker to stamp — just focus the tab.
        if (conversation.value !== undefined) {
            setActive(conversation.value.conversationId);
            return;
        }
        if (settling.value) {
            return;
        }
        void router.replace(`/agents`);
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

const edit = createTitleEdit(
    () => agentId.value,
    () => fleetAgent.value?.title ?? conversation.value?.title.value ?? undefined,
);

// The card's own status glyph, carried into the header — the one piece of fleet state the review below can't
// tell you (it reports the work, not whether the agent is still writing it). It is also the page's ONLY
// statement of whether the work landed: the review's toolbar used to carry a second "✓ landed" chip a line
// below this one, meaning "every file reached the workspace" where this one means "the last turn landed" —
// two scopes, one word, stacked.
const status = computed(() => (fleetAgent.value === undefined ? undefined : agentStatusMeta(fleetAgent.value.status)));

/* THE REVIEW'S STATE, owned here and handed to the panel. One instance, because the actions are split across
 * the two components now — Land and the ⋯ menu fire from this row, the conflict report's merge/resolve fire
 * from the panel — and a second useAgentChanges() would give each its own busy and error flags. The query
 * behind it is keyed by agent id, so this is also the only fetch. */
// Empty until the agent is known to HAVE a review (registered, branch-backed) — see useAgentChanges: this is
// created for the page, which outlives the panel, so a draft agent must not send it looking for a diff.
const changes = useAgentChanges(computed(() => (reviewable.value ? agentId.value : ``)));
const streaming = computed(() => conversation.value?.streaming.value === true);

/* Discard stays gated on the turn — it takes the worktree away and the daemon refuses it outright while one
 * runs. Land does not, any more: it only READS that checkout, so the daemon lets it through whenever nobody is
 * mid-sentence and asks for an explicit override when someone is (agents.routes.ts landable).
 *
 * So the button is live in every state that has something to apply, and `writing` decides which of the two
 * presses it is: a plain land, or the one that opens the warning first. Read off the FLEET status rather than
 * off `streaming` — this browser's stream is open for a parked turn exactly as it is for a working one, which
 * is what made "wait for the agent turn to finish" the answer to a card that was waiting for the user. */
const writing = computed(() => fleetAgent.value !== undefined && writingNow(fleetAgent.value));
const canLand = computed(() => !changes.actionBusy.value && changes.pending.value.length > 0);
// A live turn that is NOT writing: parked on a question or a permission card, or unwinding a Stop. Its land is
// an ordinary one, and saying so is the point — this is the state the old copy called "running".
const parked = computed(() => streaming.value && !writing.value);
// What the button says it will do, in the three states it can be pressed in.
const landHint = computed(() =>
    writing.value
        ? `The agent is still writing — you'll be asked to confirm`
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
const confirmForceLand = (): void => {
    pendingForceLand.value = false;
    void changes.land(`check`, `outstanding`, true);
};

// The role split on the toolbar's primary action: maintainers land, collaborators ask (the daemon floors the
// land itself — see AgentCard for the same split on the board).
const { canDrive, canShip } = useRole();
const requestingLand = ref(false);
const requestLand = async (): Promise<void> => {
    if (requestingLand.value) {
        return;
    }
    requestingLand.value = true;
    try {
        await requestLandAgent(agentId.value);
        await refresh();
    } finally {
        requestingLand.value = false;
    }
};

// The session's name, in every form anyone pastes it in — beside the chip on desktop, a sheet on a phone.
const identity = ref<InstanceType<typeof Popover> | null>(null);
const identitySheet = ref(false);
const openIdentity = (event: MouseEvent): void => identity.value?.toggle(event);

const menu = ref<InstanceType<typeof Popover> | null>(null);
const menuSheet = ref(false);
const openMenu = (event: MouseEvent): void => {
    if (mobile.value) {
        menuSheet.value = true;
        return;
    }
    menu.value?.toggle(event);
};
const closeMenu = (): void => {
    menuSheet.value = false;
    menu.value?.hide();
};

// Destructive and unrecoverable (the branch and worktree go), so it asks in the same modal every other
// irreversible git action in this app uses.
const pendingDiscard = ref(false);
const confirmDiscard = (): void => {
    pendingDiscard.value = false;
    void changes.discard();
};
</script>

<template>
    <div class="flex h-full min-h-0 flex-col">
        <!-- A @container: the header thins out against ITS OWN width, which is the workspace pane's and not
             the window's — with the chat panel open the two are nowhere near each other. -->
        <div class="view-header @container flex items-center gap-2 border-b border-line px-3">
            <button
                type="button"
                class="flex h-7 w-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-overlay hover:text-content"
                @click="router.push('/agents')"
                aria-label="Back to agents"
            >
                <Icon name="arrow-left" class="text-sm" />
            </button>
            <input
                v-if="edit.editing"
                v-model="edit.draft"
                type="text"
                maxlength="80"
                aria-label="Agent title"
                class="min-w-0 flex-1 rounded bg-overlay px-1 text-xs font-medium text-content outline-none ring-1 ring-primary-500/50"
                @keydown.enter.prevent="edit.commit()"
                @keydown.esc.prevent="edit.cancel()"
                @blur="edit.blurCommit()"
                @vue:mounted="edit.focusInput"
            />
            <template v-else>
                <span class="min-w-0 flex-1 truncate text-xs font-medium text-content">{{ title }}</span>
                <button type="button" aria-label="Rename agent" v-tooltip.bottom="'Rename'" :class="cmp.iconButton()" @click="edit.begin()">
                    <Icon name="pencil" class="text-xs" />
                </button>
            </template>
            <!-- THE SESSION'S NAME, and the way to get hold of it. This chip used to be a picture of the name:
                 cut off at a fixed width, hoverable to see the rest, and impossible to put on a clipboard — so
                 the only route to the id every git command, worktree path and CLI verb needs was to read
                 thirty-six characters off the screen and retype them. Pressing it now opens the one panel that
                 states the name in all three forms anyone pastes it in.
                 It survives into a narrow header as the bare glyph rather than vanishing: this row has no width
                 for a branch name there, but hiding the chip made the identity of the thing on screen unreachable
                 exactly where retyping it is worst. -->
            <span
                v-if="fleetAgent?.branch !== undefined"
                class="hidden max-w-[16rem] shrink-0 items-center rounded bg-overlay px-1.5 py-px @2xl:inline-flex"
            >
                <SessionChip :branch="fleetAgent.branch" reveal @reveal="openIdentity" />
            </span>
            <SessionChip
                v-if="fleetAgent?.branch !== undefined && mobile"
                :branch="fleetAgent.branch"
                reveal
                compact
                @reveal="identitySheet = true"
            />
            <!-- No tooltip: the chip prints status.label already, and hovering it to be told the word you are
                 reading is the kind of hint that teaches people not to hover anything. -->
            <span v-if="status !== undefined" class="inline-flex shrink-0 items-center gap-1 text-2xs" :class="status.class">
                <Icon :name="status.icon" :spin="status.spin" class="text-2xs" />{{ status.label }}
            </span>
            <Segmented v-if="mobile && reviewable" v-model="view" :options="viewOptions" />
            <template v-if="reviewable">
                <Icon v-if="changes.actionBusy.value" name="spinner" class="shrink-0 text-xs text-muted" spin />
                <!-- The page's one primary action, beside the status chip that says whether it is even needed.
                     It appears only when there is something to apply, so the button's presence IS the "not
                     landed" signal the toolbar below used to spend a pill on. -->
                <Button
                    v-if="!mobile && changes.pending.value.length > 0 && canShip"
                    size="small"
                    severity="success"
                    class="shrink-0 gap-0 whitespace-nowrap px-2.5 py-1 text-2xs"
                    :disabled="!canLand"
                    @click="pressLand"
                    v-tooltip.bottom="landHint"
                >
                    <Icon name="check" class="mr-1 text-2xs" />Land now
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
                    :outlined="true"
                    class="shrink-0 gap-0 whitespace-nowrap px-2.5 py-1 text-2xs"
                    :disabled="requestingLand"
                    @click="requestLand"
                    v-tooltip.bottom="'Landing needs a maintainer — this puts the ask on their board'"
                >
                    <Icon :name="requestingLand ? 'spinner' : 'send'" :spin="requestingLand" class="mr-1 text-2xs" />Request land
                </Button>
                <button
                    type="button"
                    class="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-overlay hover:text-content"
                    @click="openMenu"
                    v-tooltip.bottom="'Session actions'"
                    aria-label="Session actions"
                >
                    <Icon name="bars" class="text-xs" />
                </button>
            </template>
        </div>
        <p v-if="edit.error !== undefined" class="border-b border-line px-3 py-1 text-2xs text-danger">{{ edit.error }}</p>
        <ChatPanel v-if="mobile && (view === 'chat' || !reviewable)" class="min-h-0 flex-1" />
        <!-- `chat` is the review asking to be swapped for the conversation — raised when it hands a land
             conflict back to the agent and offers to show the turn. Desktop never sees it: the docked chat is
             already on screen there, so the review has nothing to swap itself for. -->
        <AgentReviewPanel
            v-else-if="agentId !== '' && reviewable"
            :agent-id="agentId"
            :changes="changes"
            :streaming="streaming"
            :writing="writing"
            class="min-h-0 flex-1"
            @chat="view = 'chat'"
        />

        <!-- The session menu: anchored popover on desktop, bottom sheet on mobile — same body, the pattern the
             chat's pickers use. -->
        <BottomSheet v-if="mobile" v-model="menuSheet" header="Session">
            <AgentSessionMenu
                :agent-id="agentId"
                :changes="changes"
                :streaming="streaming"
                :land-in-menu="true"
                @selected="closeMenu"
                @discard="pendingDiscard = true"
                @force-land="pendingForceLand = true"
            />
        </BottomSheet>
        <Popover v-else ref="menu" :pt="{ content: { class: '!p-0' } }">
            <div class="w-72">
                <AgentSessionMenu
                    :agent-id="agentId"
                    :changes="changes"
                    :streaming="streaming"
                    :land-in-menu="false"
                    @selected="closeMenu"
                    @discard="pendingDiscard = true"
                    @force-land="pendingForceLand = true"
                />
            </div>
        </Popover>

        <!-- The session's identity, in the same two dresses as the menu above it. -->
        <BottomSheet v-if="mobile" v-model="identitySheet" header="Session name">
            <SessionIdentity v-if="fleetAgent?.branch !== undefined" :agent-id="agentId" :branch="fleetAgent.branch" />
        </BottomSheet>
        <Popover v-else ref="identity" :pt="{ content: { class: '!p-0' } }">
            <div class="w-96">
                <SessionIdentity v-if="fleetAgent?.branch !== undefined" :agent-id="agentId" :branch="fleetAgent.branch" />
            </div>
        </Popover>

        <!-- THE MID-WRITE LAND'S WARNING. It states the one real risk and both reasons it is survivable,
             because a warning that only says "are you sure" teaches people to click through it. -->
        <Dialog
            :visible="pendingForceLand"
            :modal="true"
            :draggable="false"
            :dismissable-mask="true"
            :style="{ width: '26rem' }"
            header="Land while the agent is working?"
            @update:visible="pendingForceLand = false"
        >
            <p class="text-xs text-content">
                The agent is still writing. Landing now takes its work exactly as it stands, which can mean half-finished changes — one side of a
                rename, or three files of a larger edit.
            </p>
            <p class="mt-2 text-xs text-muted">
                Nothing is final: this arrives as uncommitted changes for you to review, and the rest of the turn lands on top of it when the agent
                finishes.
            </p>
            <template #footer>
                <button type="button" class="rounded px-3 py-1 text-xs text-muted hover:text-content" @click="pendingForceLand = false">
                    Cancel
                </button>
                <Button
                    size="small"
                    severity="warning"
                    label="Land anyway"
                    class="px-3 py-1"
                    :disabled="changes.actionBusy.value"
                    @click="confirmForceLand"
                />
            </template>
        </Dialog>

        <Dialog
            :visible="pendingDiscard"
            :modal="true"
            :draggable="false"
            :dismissable-mask="true"
            :style="{ width: '24rem' }"
            header="Discard this agent's work"
            @update:visible="pendingDiscard = false"
        >
            <p class="text-xs text-content">
                Delete the agent's branch and worktree? Its {{ changes.count.value }} changed file{{ changes.count.value === 1 ? "" : "s" }} and the
                conversation's isolated history go with them.
            </p>
            <p v-if="changes.count.value > changes.pending.value.length" class="mt-2 text-xs text-muted">
                Work that already landed stays in your workspace — only what is still on the branch is lost.
            </p>
            <template #footer>
                <button type="button" class="rounded px-3 py-1 text-xs text-muted hover:text-content" @click="pendingDiscard = false">Cancel</button>
                <Button
                    size="small"
                    severity="danger"
                    label="Discard"
                    class="px-3 py-1"
                    :disabled="changes.actionBusy.value"
                    @click="confirmDiscard"
                />
            </template>
        </Dialog>
    </div>
</template>
