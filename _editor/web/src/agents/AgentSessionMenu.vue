<script setup lang="ts">
import { computed } from "vue";
import { effectiveAutoLand, effectiveLimitResume, landedAway, limited, writingNow } from "../composables/agents/agentStatus";
import type { useAgentChanges } from "../composables/agents/useAgentChanges";
import { useAgents } from "../composables/agents/useAgents";
import { useRole } from "../composables/sandbox/useRole";
import { landsByDefault } from "../composables/sandbox/rules";
import { useSandboxSettings } from "../composables/sandbox/useSandboxSettings";

/* What you do to a SESSION, as opposed to what you do to its diff: refresh, land, hold, archive, discard.
 * Width-agnostic body (Popover on desktop, BottomSheet on mobile), the same shape ChatModeMenu has.
 *
 * These five used to sit permanently in the review's toolbar, four of them competing with the diff for the
 * reader's attention on every file they scanned: with the destructive one a few pixels from the primary one.
 * They are once-per-session decisions: you archive an agent when you are done with it, not while reading its
 * third file. So they live behind one glyph next to the status chip that says which of them is even relevant,
 * and the toolbar goes back to being about the review.
 *
 * Land stays out on desktop, as a labelled button in the header: it is the reason this page exists. On a phone
 * there is no room for it beside the Chat|Changes switch, so it is the first item here instead. */

const { changes, agentId, landInMenu } = defineProps<{
    agentId: string;
    // The review's ONE state instance, owned by AgentDetail: a second useAgentChanges() would give this menu
    // its own busy/error flags, so a land fired here would leave the panel's spinners saying nothing happened.
    changes: ReturnType<typeof useAgentChanges>;
    // Mobile, where Land has no room in the header row: it becomes this menu's first item.
    landInMenu: boolean;
    streaming: boolean;
}>();
// `forceLand` goes up for the same reason `discard` does: the warning it raises is a modal, and modals live on
// the page rather than inside a menu that closes on every press.
const emit = defineEmits<{ selected: []; discard: []; forceLand: [] }>();

const { agentById, restore, busyIds, setResumeAfterLimit } = useAgents();
const archived = computed(() => agentById(agentId)?.archivedAt !== undefined);
/* WORK THIS SESSION LANDED THAT THE WORKSPACE NO LONGER HOLDS: the reason "Land now" above stands down.
 *
 * The menu item it replaces was the sharpest form of the problem: with everything recorded as landed, its
 * caption read "Already in your workspace" over a tree the user had emptied of it, and the item was greyed out
 * so there was nothing to press either. Read off the roster rather than off the diff, because the diff is the
 * agent's own branch and the branch is exactly what has NOT changed. */
const away = computed(() => {
    const agent = agentById(agentId);
    return agent === undefined || agent.archivedAt !== undefined ? undefined : landedAway(agent);
});
// Both directions claim the same per-id counter in the fleet store, so one flag covers the round trip either way.
const archiveBusy = computed(() => busyIds.value.includes(agentId));

/* THE HOLD TOGGLE: this agent's land-at-completion posture. It reads the EFFECTIVE value (the agent's
 * override, else the sandbox-wide setting: Sandbox ▸ Agent owns the default), and a click flips it FOR THIS
 * AGENT only. Flipping back to what the sandbox already says clears the override entirely (null), so agents
 * don't accumulate frozen overrides that quietly stop following the global toggle. Deliberately legal
 * mid-turn: the daemon reads the value at turn COMPLETION, so pressing hold while the agent works is exactly
 * "keep THIS turn's work on the branch": the press that matters most. */
const { settings: sandboxSettings } = useSandboxSettings();
const sandboxLands = computed(() => landsByDefault(sandboxSettings.value?.rules ?? []));
const autoLandOn = computed(() => effectiveAutoLand(agentById(agentId), sandboxLands.value));
const toggleAutoLand = async (): Promise<void> => {
    const next = !autoLandOn.value;
    emit(`selected`);
    await changes.setAutoLand(next === sandboxLands.value ? null : next);
};

/* THE OTHER POSTURE THIS CARD OWNS, and the only one that is not always worth a row: whether the turn a spent
 * allowance refused goes again by itself when the window reopens.
 *
 * OFFERED ONLY ON A CARD IT APPLIES TO, unlike the hold toggle above. Auto-land is a standing property of every
 * agent, so its row is always true; this one describes a wait that most cards are not in, and a menu row about
 * an allowance nobody hit is a row that teaches people to stop reading the menu.
 *
 * SAME THREE-STATE GRAMMAR as the hold toggle, including the clear: flipping back to what the sandbox already
 * says drops the override entirely, so a card cannot sit holding a frozen copy of a default it has quietly
 * stopped following. */
const limitedCard = computed(() => {
    const agent = agentById(agentId);
    return agent !== undefined && limited(agent) ? agent : undefined;
});
const sandboxSendsAgain = computed(() => sandboxSettings.value?.resumeAfterLimit ?? false);
const sendsAgainOn = computed(() => effectiveLimitResume(agentById(agentId), sandboxSendsAgain.value));
const toggleSendsAgain = async (): Promise<void> => {
    const next = !sendsAgainOn.value;
    emit(`selected`);
    await setResumeAfterLimit(agentId, next === sandboxSendsAgain.value ? null : next);
};

// The ship-tier items (land, re-land, auto-land posture, discard) leave the menu below maintainer rather
// than sit disabled in it: a collaborator's asking press lives on the card as "Request land", and a menu of
// grey rows teaches people the menu is broken, not that a tier exists.
const { canShip } = useRole();

const run = (action: () => void): void => {
    action();
    emit(`selected`);
};

/* WHETHER A LAND HERE NEEDS THE WARNING FIRST: the same split the header button makes (AgentDetail), and it
 * has to be made in both places because either one can be the press.
 *
 * `streaming` still disables archive and discard below: those take the worktree away and the daemon refuses
 * them for any live turn. A land only reads it, so the two land items follow `writing` instead: a turn parked
 * on a question is not writing anything, and that is precisely when someone wants this menu. */
const writing = computed(() => {
    const agent = agentById(agentId);
    return agent !== undefined && writingNow(agent);
});
// Every land in this menu goes through here: warn while the agent writes, otherwise just land.
const pressLand = (land: () => void): void => {
    if (writing.value) {
        emit(`forceLand`);
        emit(`selected`);
        return;
    }
    run(land);
};
// The cumulative land: "Land again" (see `away`). Through `run` like every other item, so the menu closes on
// the press and the panel's own busy/error line owns the round trip.
const relandNow = (): void => pressLand(() => changes.land(`check`, `cumulative`));

const ITEM = `flex w-full items-start gap-2 rounded-lg px-2.5 py-1.5 text-left transition-colors hover:bg-overlay disabled:opacity-40 disabled:hover:bg-transparent max-md:py-3`;
</script>

<template>
    <div class="flex flex-col p-1">
        <button
            v-if="landInMenu && away === undefined && canShip"
            type="button"
            :class="ITEM"
            :disabled="changes.actionBusy.value || changes.pending.value.length === 0"
            @click="pressLand(() => changes.land())"
        >
            <Icon name="check" class="mt-0.5 text-xs text-success" />
            <span class="flex min-w-0 flex-col">
                <span class="text-sm text-content md:text-xs">Land now</span>
                <span class="text-2xs text-subtle">
                    {{
                        writing
                            ? `The agent is still writing: you'll be asked to confirm`
                            : changes.pending.value.length === 0
                              ? `Already in your workspace`
                              : streaming
                                ? `Applies what the agent has written so far`
                                : `Applies ${changes.pending.value.length} change(s) to your workspace`
                    }}
                </span>
            </span>
        </button>
        <!-- THE WAY BACK, where the session's own decisions live. It replaces "Land now" rather than joining
             it, because the two are never both the honest offer: with landed work missing from the tree, a
             plain land carries the remainder and leaves the missing part exactly as missing, which is the one
             outcome that looks like it worked. Quiet like everything else in this menu: the card is where the
             fact is announced; this is just the second place the press can be found. -->
        <button v-if="away !== undefined && canShip" type="button" :class="ITEM" :disabled="changes.actionBusy.value" @click="relandNow">
            <Icon name="undo" class="mt-0.5 text-xs text-warning" />
            <span class="flex min-w-0 flex-col">
                <span class="text-sm text-content md:text-xs">Land again</span>
                <span class="text-2xs text-subtle">{{ writing ? `The agent is still writing, you'll be asked to confirm` : away.text }}</span>
            </span>
        </button>
        <button type="button" :class="ITEM" @click="run(() => changes.refresh())">
            <Icon name="refresh" class="mt-0.5 text-xs text-subtle" :spin="changes.loading.value" />
            <span class="text-sm text-content md:text-xs">Refresh</span>
        </button>
        <button v-if="canShip" type="button" :class="ITEM" :disabled="changes.actionBusy.value || archived" @click="toggleAutoLand">
            <Icon :name="autoLandOn ? 'lock' : 'unlock'" class="mt-0.5 text-xs" :class="autoLandOn ? 'text-subtle' : 'text-link'" />
            <span class="flex min-w-0 flex-col">
                <span class="text-sm text-content md:text-xs">{{ autoLandOn ? `Hold work on the branch` : `Land automatically` }}</span>
                <span class="text-2xs text-subtle">
                    {{
                        autoLandOn
                            ? `Finished turns land into your workspace by themselves. Hold keeps this agent's future work on its branch until you press Land now.`
                            : `Holding: finished work waits on this agent's branch. Switch back to landing at turn completion.`
                    }}
                </span>
            </span>
        </button>
        <!-- The allowance posture, on the one card in ten that is waiting on one. It is what the card's own
             readout promises when it says nothing is sending this for you, and the reason that promise is kept
             here rather than on the card itself: the card already carries a press that spends money now, and a
             second control beside it, arming something that spends money later, is two decisions in one line. -->
        <button v-if="limitedCard !== undefined" type="button" :class="ITEM" :disabled="archived" @click="toggleSendsAgain">
            <Icon :name="sendsAgainOn ? 'clock' : 'refresh'" class="mt-0.5 text-xs" :class="sendsAgainOn ? 'text-link' : 'text-subtle'" />
            <span class="flex min-w-0 flex-col">
                <span class="text-sm text-content md:text-xs">{{
                    sendsAgainOn ? `Stop sending this again by itself` : `Send again when the allowance is back`
                }}</span>
                <span class="text-2xs text-subtle">
                    {{
                        sendsAgainOn
                            ? `This turn goes again by itself at the reset. Stopping leaves it here to send by hand.`
                            : `Nothing sends it for you. Arm it and this turn goes once, at the hour the provider named.`
                    }}
                </span>
            </span>
        </button>
        <!-- Two endings, and the copy is what keeps them apart: archive KEEPS everything and only takes the
             agent off the board, discard is the one that throws work away. -->
        <button
            v-if="!archived"
            type="button"
            :class="ITEM"
            :disabled="changes.actionBusy.value || archiveBusy || streaming"
            @click="run(() => changes.archive())"
        >
            <Icon name="box" class="mt-0.5 text-xs text-subtle" />
            <span class="flex min-w-0 flex-col">
                <span class="text-sm text-content md:text-xs">Archive</span>
                <span class="text-2xs text-subtle">
                    {{ streaming ? `Wait for the agent turn to finish` : `The branch, diff and conversation are kept` }}
                </span>
            </span>
        </button>
        <button v-else type="button" :class="ITEM" :disabled="archiveBusy" @click="run(() => restore([agentId]))">
            <Icon name="history" class="mt-0.5 text-xs text-link" />
            <span class="flex min-w-0 flex-col">
                <span class="text-sm text-link md:text-xs">Restore</span>
                <span class="text-2xs text-subtle">Puts it back on the board</span>
            </span>
        </button>
        <button v-if="canShip" type="button" :class="ITEM" :disabled="changes.actionBusy.value || streaming" @click="run(() => emit(`discard`))">
            <Icon name="trash" class="mt-0.5 text-xs text-danger" />
            <span class="flex min-w-0 flex-col">
                <span class="text-sm text-danger md:text-xs">Discard</span>
                <span class="text-2xs text-subtle">
                    {{ streaming ? `Wait for the agent turn to finish` : `Drops this agent's branch and worktree` }}
                </span>
            </span>
        </button>
    </div>
</template>
