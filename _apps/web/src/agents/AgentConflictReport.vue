<script setup lang="ts">
import type { LandConflict } from "@intentic/sandbox-contract";
import { cmp, useDevice } from "@intentic-app/ui";
import { computed } from "vue";
import { agentBlockers, blockerLabel, blockersOf, userBlockers } from "../composables/agents/conflictResolution";

/* THE CONFLICT REPORT — what the review panel says when a land is refused.
 *
 * What it replaced named every path in the delta and said "your workspace's copy of these paths differs",
 * which was wrong twice over: `git apply` is atomic, so a handful of real conflicts held back everything and
 * the report listed the lot; and the stated cause was the rarest of the three. A user reading it had no way
 * to tell four blocked files from fourteen, no idea which of their own edits was implicated, and — since the
 * only buttons were Archive, Discard and a Land that would fail identically forever — nothing to do about it.
 *
 * So: count what is actually blocked against what would land anyway, group the blockers by CAUSE, and end on
 * a LADDER OF ACTIONS ORDERED BY WHO CAN TAKE THEM — which is the only thing the three causes really disagree
 * about (see conflictResolution.ts):
 *
 *   1. THE AGENT, for `diverged` and `binary`. It rebases onto the moved main line and resolves in its own
 *      worktree, where a wrong answer costs nobody anything, and the auto-land at turn completion finishes the
 *      job. This is the primary action, and it used not to exist at all — the report's own copy said "a
 *      three-way merge can reconcile these" while the only button performed that merge in the USER's tree.
 *   2. THE USER, for `workspace`. Their uncommitted edits are invisible from the agent's checkout and a
 *      three-way apply goes through the main index, so no amount of rebasing clears it: commit or stash.
 *      Previously prose, with the Changes panel left to be found.
 *   3. THE USER'S EDITOR — `merge`, which lands what fits and leaves the rest carrying markers. Kept, because
 *      someone who wants the merge in their own hands should have it, but demoted out of the primary slot it
 *      had no business holding: it is the only option here that WRITES to the workspace on failure.
 *
 * A component of its own, rather than a fourth of the review panel's template, because it is the one part of
 * that panel with a decision tree in it — five states over three causes, and the pair (asked, streaming) —
 * which is exactly the part worth being able to mount on its own and look at. */

const props = defineProps<{
    conflicts: readonly LandConflict[];
    // The agent has a turn in flight; every action here would be refused daemon-side until it settles.
    streaming: boolean;
    // A land / ask this panel itself has in flight.
    busy: boolean;
    // The user has already handed this conflict back to the agent (useAgentChanges.asked).
    asked: boolean;
}>();

const emit = defineEmits<{ resolve: []; merge: []; commit: []; stop: []; chat: [] }>();

const { mobile } = useDevice();

const REASON_COPY = {
    diverged: {
        title: `your workspace moved on since the agent branched`,
        fix: `The agent can rebase onto it and merge these itself.`,
    },
    workspace: {
        title: `you have uncommitted edits to these`,
        fix: `Only you can clear this — git cannot merge through unstaged work, and the agent's checkout cannot see it.`,
    },
    binary: {
        title: `binary files, which have no automatic merge`,
        fix: `The agent can re-create them against the current file, or pick a side.`,
    },
} as const;

const blockers = computed(() => blockersOf(props.conflicts));
const blockedCount = computed(() => blockers.value.length);
// What the atomic refusal is holding hostage — the number that tells the user how little is actually wrong.
const cleanCount = computed(() => props.conflicts.reduce((total, conflict) => total + conflict.clean, 0));
// Grouped by cause, because the three want different things from different people. Paths are repo-qualified:
// in a multi-repo composition a bare `README.md` names as many files as the workspace has repos.
const groups = computed(() =>
    (Object.keys(REASON_COPY) as (keyof typeof REASON_COPY)[]).flatMap((reason) => {
        const paths = blockers.value.filter((blocker) => blocker.reason === reason).map(blockerLabel);
        return paths.length === 0 ? [] : [{ reason, paths, ...REASON_COPY[reason] }];
    }),
);
// The two halves of the ladder. `mine` is what asking the agent would actually fix; `theirs` is what stays
// blocked until the user commits or stashes, whatever the agent does.
const mine = computed(() => agentBlockers(blockers.value));
const theirs = computed(() => userBlockers(blockers.value));
// A three-way apply goes through the index, so git refuses it outright on an unstaged path. Offering the
// button in that case would promise something the daemon has to decline.
const mergeable = computed(() => blockedCount.value > 0 && theirs.value.length === 0);
// The agent is on it. `busy` covers the click's own round trip, so the primary button never flickers back to
// armed in the gap between the send returning and the turn's first frame.
const working = computed(() => props.asked && (props.streaming || props.busy));

const QUIET_BUTTON = `inline-flex items-center whitespace-nowrap rounded border border-line px-2 py-0.5 text-2xs text-muted transition-colors hover:bg-overlay hover:text-content disabled:opacity-40`;
const ROW = `mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1`;
</script>

<template>
    <!-- Nothing was written: the worktree still holds every change, so this is a decision point rather than a
         failure — hence the count of what is being held back by how little, the cause of each blocker, and a
         ladder of actions ordered by who can actually take them. -->
    <div class="flex shrink-0 flex-col gap-1.5 rounded-md border border-warning/40 bg-warning/10 px-2 py-1.5">
        <span class="text-2xs font-medium text-warning">
            <template v-if="blockedCount === 0">Couldn't reach your workspace's copy of this repo</template>
            <template v-else>
                {{ blockedCount }} file{{ blockedCount === 1 ? "" : "s" }} couldn't be applied<template v-if="cleanCount > 0">
                    — holding back {{ cleanCount }} that {{ cleanCount === 1 ? "would" : "would all" }} land cleanly</template
                >
            </template>
        </span>
        <!-- Grouped by cause: which of the three is in play decides who does something next. -->
        <div v-for="group in groups" :key="group.reason" class="flex flex-col">
            <span class="text-2xs text-content">{{ group.title }}</span>
            <span class="break-all font-mono text-2xs text-muted">{{ group.paths.join(", ") }}</span>
            <span class="text-2xs text-subtle">{{ group.fix }}</span>
        </div>
        <p v-if="blockedCount === 0" class="text-2xs text-muted">Nothing was applied and nothing was lost — the agent's work is still on its branch.</p>

        <!-- Handed back to the agent, and still with it. This REPLACES the ladder rather than sitting beside
             it: while the rebase runs, re-asking or landing on top of it is not a choice worth offering, and a
             report that keeps offering them reads as though nothing was asked. -->
        <div v-if="working" :class="ROW">
            <span class="inline-flex items-center gap-1.5 text-2xs text-link">
                <Icon name="spinner" spin class="text-2xs" />Resolving — the agent is bringing its branch up to date
            </span>
            <span class="text-2xs text-subtle">It lands on its own when the turn ends.</span>
            <span class="flex-1"></span>
            <!-- Desktop already has the conversation on screen in the docked chat; only on mobile is it a mode
                 this view has to be switched into. -->
            <button
                v-if="mobile"
                type="button"
                class="whitespace-nowrap rounded px-1.5 py-0.5 text-2xs font-medium text-link transition-colors hover:bg-overlay"
                @click="emit('chat')"
            >
                Watch
            </button>
            <button
                v-if="streaming"
                type="button"
                :class="QUIET_BUTTON"
                @click="emit('stop')"
                v-tooltip.bottom="'The conflict stays exactly as it is'"
            >
                Stop
            </button>
        </div>

        <template v-else>
            <!-- First, the one action that costs the user nothing: the agent redoing its own merge in its own
                 worktree. `mine` is empty only when every blocker is the user's own uncommitted work, which no
                 rebase can reach — then the primary slot belongs to them instead. -->
            <div v-if="mine.length > 0" :class="ROW">
                <button
                    type="button"
                    :class="cmp.buttonPrimary('gap-0 whitespace-nowrap px-2.5 py-1 text-2xs')"
                    :disabled="busy || streaming"
                    @click="emit('resolve')"
                    v-tooltip.bottom="streaming ? 'Wait for the agent turn to finish' : undefined"
                >
                    <Icon name="sparkles" class="mr-1 text-2xs" />Have the agent resolve it
                </button>
                <span class="text-2xs text-subtle">
                    It merges in its own worktree — nothing is written to your workspace until it succeeds.<template v-if="theirs.length > 0">
                        The {{ theirs.length === 1 ? "file" : `${theirs.length} files` }} with your own edits still
                        {{ theirs.length === 1 ? "needs" : "need" }} you.</template
                    >
                </span>
            </div>

            <!-- The user's own half, which nothing else here can do for them. Primary when it is the ONLY
                 thing standing in the way, so the block always ends on somebody's next move. -->
            <div v-if="theirs.length > 0" :class="ROW">
                <button
                    type="button"
                    :class="mine.length === 0 ? cmp.buttonPrimary('gap-0 whitespace-nowrap px-2.5 py-1 text-2xs') : QUIET_BUTTON"
                    @click="emit('commit')"
                    v-tooltip.bottom="'Opens the Changes panel'"
                >
                    <Icon name="file-edit" class="mr-1 text-2xs" />Commit or stash yours
                </button>
                <span class="text-2xs text-subtle">Then land again — git cannot merge through unstaged work.</span>
            </div>

            <!-- Last, and quiet: the only option in this block that writes to the user's tree on failure. -->
            <div v-if="mergeable" :class="ROW">
                <button
                    type="button"
                    :class="QUIET_BUTTON"
                    :disabled="busy || streaming"
                    @click="emit('merge')"
                    v-tooltip.bottom="streaming ? 'Wait for the agent turn to finish' : undefined"
                >
                    <Icon name="check" class="mr-1 text-2xs" />Land with conflict markers
                </button>
                <span class="text-2xs text-subtle">You finish the merge yourself, in your workspace.</span>
            </div>
        </template>
    </div>
</template>
