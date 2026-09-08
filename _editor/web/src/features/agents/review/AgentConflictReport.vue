<script setup lang="ts">
import type { LandConflict } from "@intentic/sandbox-contract";
import { Button, useDevice } from "@intentic/ui";
import { computed } from "vue";
import { agentBlockers, type Blocker, blockerLabel, blockersOf, REASON_COPY, userBlockers } from "./conflictResolution";

// Shows what a refused land is blocking: counts blocked vs. clean, groups blockers by cause, and ends on an
// action ladder ordered by who can act (agent, then user, then a manual merge). Cause copy lives in
// conflictResolution's REASON_COPY, shared with the file list below.

const props = defineProps<{
    conflicts: readonly LandConflict[];
    // Agent has a turn in flight; asking it to resolve waits for this one to end first.
    streaming: boolean;
    // Agent is mid-write; the merge only avoids catching the checkout half-written (a parked turn is fine).
    writing: boolean;
    // A land / ask this panel itself has in flight.
    busy: boolean;
    // The user has already handed this conflict back to the agent (useAgentChanges.asked).
    asked: boolean;
    // Agent is in another sandbox; resolve and commit collapse into `cross` there, but merge stays offerable.
    box?: string;
}>();

const emit = defineEmits<{ resolve: []; merge: []; commit: []; stop: []; chat: []; cross: []; select: [Blocker] }>();

const { mobile } = useDevice();

const blockers = computed(() => blockersOf(props.conflicts));
const blockedCount = computed(() => blockers.value.length);
// What the atomic refusal holds hostage: how much would land cleanly if not for the blockers.
const cleanCount = computed(() => props.conflicts.reduce((total, conflict) => total + conflict.clean, 0));
// Grouped by cause; kept as {repo, path} since a bare path can't identify a row in a multi-repo composition.
const groups = computed(() =>
    (Object.keys(REASON_COPY) as (keyof typeof REASON_COPY)[]).flatMap((reason) => {
        const blocked = blockers.value.filter((blocker) => blocker.reason === reason);
        return blocked.length === 0 ? [] : [{ reason, blocked, ...REASON_COPY[reason] }];
    }),
);
// Ladder's two halves: `mine` is what asking the agent fixes; `theirs` needs a commit or stash regardless.
const mine = computed(() => agentBlockers(blockers.value));
const theirs = computed(() => userBlockers(blockers.value));
// A three-way apply goes through the index, so git refuses it outright on any unstaged path.
const mergeable = computed(() => blockedCount.value > 0 && theirs.value.length === 0);
// `busy` covers the click's round trip so the button doesn't flicker back to armed before the turn starts.
const working = computed(() => props.asked && (props.streaming || props.busy));

// Shared geometry for this block's inline actions: small, quiet, narrow enough beside a sentence.
const INLINE = `whitespace-nowrap`;
const ROW = `mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1`;
</script>

<template>
    <!--
        Nothing was written yet: the worktree still holds every change, so this is a decision point, not a failure.
        Shows how much is actually being held back, the cause of each blocker, and a ladder ordered by who can act.
    -->
    <div class="flex shrink-0 flex-col gap-1.5 rounded-md border border-warning/40 bg-warning/10 px-2 py-1.5">
        <span class="text-2xs font-medium text-warning">
            <template v-if="blockedCount === 0">Couldn't reach your workspace's copy of this repo</template>
            <template v-else>
                {{ blockedCount }} file{{ blockedCount === 1 ? "" : "s" }} couldn't be applied<template v-if="cleanCount > 0">
                    , holding back {{ cleanCount }} that {{ cleanCount === 1 ? "would" : "would all" }} land cleanly</template
                >
            </template>
        </span>
        <!--
            Grouped by cause, since that decides who acts next. The heading shares the file list's glyph so the group
            reads
            as a pointer at those rows; each path is a button that selects one.
        -->
        <div v-for="group in groups" :key="group.reason" class="flex flex-col">
            <span class="inline-flex items-center gap-1 text-2xs text-content">
                <Icon :name="group.icon" class="shrink-0 text-2xs text-warning" />{{ group.title }}
            </span>
            <div class="flex flex-wrap gap-x-2">
                <button
                    v-for="blocker in group.blocked"
                    :key="`${blocker.repo}:${blocker.path}`"
                    type="button"
                    class="break-all text-left font-mono text-2xs text-muted underline decoration-dotted underline-offset-2 transition-colors hover:text-content"
                    @click="emit('select', blocker)"
                    v-tooltip.bottom="'Show this file in the review'"
                >
                    {{ blockerLabel(blocker) }}
                </button>
            </div>
            <span class="text-2xs text-subtle">{{ group.fix }}</span>
        </div>
        <p v-if="blockedCount === 0" class="text-2xs text-muted">
            Nothing was applied and nothing was lost: the agent's work is still on its branch.
        </p>

        <!--
            Replaces the ladder rather than sitting beside it: while the rebase runs, re-asking or landing over it is
            not a
            real choice.
        -->
        <div v-if="working" :class="ROW">
            <span class="inline-flex items-center gap-1.5 text-2xs text-link">
                <Icon name="spinner" spin class="text-2xs" />Resolving: the agent is bringing its branch up to date
            </span>
            <span class="text-2xs text-subtle">It lands on its own when the turn ends.</span>
            <span class="flex-1"></span>
            <!-- Desktop already shows the conversation in the docked chat; only mobile needs a mode switch to watch it. -->
            <Button v-if="mobile" size="small" :text="true" class="whitespace-nowrap" @click="emit('chat')"> Watch </Button>
            <Button v-if="streaming" size="small" severity="secondary" label="Stop" :class="INLINE" @click="emit('stop')" />
            <span v-if="streaming" class="text-2xs text-subtle">The conflict stays exactly as it is.</span>
        </div>

        <template v-else>
            <!--
                Both rungs needing the agent's own box (resolving needs its conversation, committing needs its
                workspace)
                collapse into one cross-sandbox button instead of two that would address the wrong box.
            -->
            <div v-if="box !== undefined && (mine.length > 0 || theirs.length > 0)" :class="ROW">
                <Button size="small" :class="INLINE" @click="emit('cross')"> <Icon name="arrow-right" />Open in {{ box }} </Button>
                <!--
                    Gated on `mergeable`, since git refuses a three-way apply while any path is held by uncommitted
                    work; the
                    promise must not appear where the surface can't honor it.
                -->
                <span class="text-2xs text-subtle">
                    <template v-if="mine.length > 0">Asking the agent to rebase needs its conversation</template
                    ><template v-if="mine.length > 0 && theirs.length > 0">, and </template
                    ><template v-if="theirs.length > 0"
                        >the {{ theirs.length === 1 ? "file" : `${theirs.length} files` }} with your own edits
                        {{ theirs.length === 1 ? "is" : "are" }} in that workspace</template
                    >.<template v-if="mergeable"> Landing with conflict markers still works from here.</template>
                </span>
            </div>

            <!--
                First: the one action costing the user nothing, the agent redoing its own merge. `mine` is empty only
                when
                every blocker is the user's own uncommitted work, which no rebase reaches.
            -->
            <div v-if="box === undefined && mine.length > 0" :class="ROW">
                <Button
                    size="small"
                    :class="INLINE"
                    :disabled="busy || streaming"
                    @click="emit('resolve')"
                    v-tooltip.bottom="streaming ? 'Wait for the agent turn to finish' : undefined"
                >
                    <Icon name="sparkles" />Have the agent resolve it
                </Button>
                <span class="text-2xs text-subtle">
                    It merges in its own worktree: nothing is written to your workspace until it succeeds.<template v-if="theirs.length > 0">
                        The {{ theirs.length === 1 ? "file" : `${theirs.length} files` }} with your own edits still
                        {{ theirs.length === 1 ? "needs" : "need" }} you.</template
                    >
                </span>
            </div>

            <!--
                The user's own half, which nothing else here can do for them; primary only when it's the sole thing
                left
                blocking, so the block always ends on somebody's next move.
            -->
            <div v-if="box === undefined && theirs.length > 0" :class="ROW">
                <Button size="small" :severity="mine.length === 0 ? undefined : `secondary`" :class="INLINE" @click="emit('commit')">
                    <Icon name="file-edit" />Commit or stash yours
                </Button>
                <!-- Says what the button does inline instead of behind a pointer-only tooltip. -->
                <span class="text-2xs text-subtle">Opens the Changes panel. Then land again: git cannot merge through unstaged work.</span>
            </div>

            <!-- Last and quiet: the only option here that writes to the user's tree on failure. -->
            <div v-if="mergeable" :class="ROW">
                <Button
                    size="small"
                    severity="secondary"
                    :class="INLINE"
                    :disabled="busy || writing"
                    @click="emit('merge')"
                    v-tooltip.bottom="writing ? 'Wait until the agent stops writing' : undefined"
                >
                    <Icon name="check" />Land with conflict markers
                </Button>
                <span class="text-2xs text-subtle">You finish the merge yourself, in your workspace.</span>
            </div>
        </template>
    </div>
</template>
