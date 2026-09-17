<script setup lang="ts">
import type { LandConflict } from "@intentic/sandbox-contract";
import { Button, useDevice } from "@intentic/ui";
import { useVocabulary } from "../../../core-views/vocabulary";
import { computed } from "vue";
import { agentBlockers, type Blocker, blockerLabel, blockersOf, reasonCopy, userBlockers } from "./conflictResolution";
import { useT } from "@intentic/ui/i18n";

// Shows what a refused land is blocking: counts blocked vs. clean, groups blockers by cause, and ends on an
// action ladder ordered by who can act (agent, then user, then a manual merge). Cause copy lives in
// conflictResolution's reasonCopy(), shared with the file list below.

const t = useT();

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
const words = useVocabulary();

const blockers = computed(() => blockersOf(props.conflicts));
const blockedCount = computed(() => blockers.value.length);
// What the atomic refusal holds hostage: how much would land cleanly if not for the blockers.
const cleanCount = computed(() => props.conflicts.reduce((total, conflict) => total + conflict.clean, 0));
// Grouped by cause; kept as {repo, path} since a bare path can't identify a row in a multi-repo composition.
const groups = computed(() =>
    (Object.keys(reasonCopy()) as (keyof ReturnType<typeof reasonCopy>)[]).flatMap((reason) => {
        const blocked = blockers.value.filter((blocker) => blocker.reason === reason);
        return blocked.length === 0 ? [] : [{ reason, blocked, ...reasonCopy()[reason] }];
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
    <!-- Nothing was written yet: the worktree still holds every change, so this is a decision point, not a failure. -->
    <div class="flex shrink-0 flex-col gap-1.5 rounded-md border border-warning/40 bg-warning/10 px-2 py-1.5">
        <span class="text-2xs font-medium text-warning">
            <template v-if="blockedCount === 0">{{ t(`agents.agentConflictReport.couldntReachWorkspacesCopy`) }}</template>
            <template v-else>
                {{ t(`agents.agentConflictReport.filesCouldntApply`, { count: blockedCount }, blockedCount)
                }}<template v-if="cleanCount > 0">{{ t(`agents.agentConflictReport.holdingBack`, { count: cleanCount }, cleanCount) }}</template>
            </template>
        </span>
        <!-- Grouped by cause, since that decides who acts next. -->
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
                    v-tooltip.bottom="t(`agents.agentConflictReport.showFileInReview`)"
                >
                    {{ blockerLabel(blocker) }}
                </button>
            </div>
            <span class="text-2xs text-subtle">{{ group.fix }}</span>
        </div>
        <p v-if="blockedCount === 0" class="text-2xs text-muted">
            {{ t(`agents.agentConflictReport.nothingAppliedNothingLost`) }}
        </p>

        <!-- Replaces the ladder rather than sitting beside it: while the rebase runs, re-asking or landing over it is not a real choice. -->
        <div v-if="working" :class="ROW">
            <span class="inline-flex items-center gap-1.5 text-2xs text-link">
                <Icon name="spinner" spin class="text-2xs" />{{ t(`agents.agentConflictReport.resolvingAgentBringingBranch`) }}
            </span>
            <span class="text-2xs text-subtle">{{ t(`agents.agentConflictReport.landsOnOwnTurn`) }}</span>
            <span class="flex-1"></span>
            <!-- Desktop already shows the conversation in the docked chat; only mobile needs a mode switch to watch it. -->
            <Button v-if="mobile" size="small" :text="true" class="whitespace-nowrap" @click="emit('chat')">
                {{ t(`agents.agentConflictReport.watch`) }}
            </Button>
            <Button v-if="streaming" size="small" severity="secondary" :label="t(`ui.action.stop`)" :class="INLINE" @click="emit('stop')" />
            <span v-if="streaming" class="text-2xs text-subtle">{{ t(`agents.agentConflictReport.conflictStaysExactly`) }}</span>
        </div>

        <template v-else>
            <!-- Both conflict rows need the agent's conversation to resolve them. -->
            <div v-if="box !== undefined && (mine.length > 0 || theirs.length > 0)" :class="ROW">
                <Button size="small" :class="INLINE" @click="emit('cross')">
                    <Icon name="arrow-right" />{{ t(`agents.agentConflictReport.openIn`) }} {{ box }}
                </Button>
                <!-- Gated on `mergeable`, since git refuses a three-way apply while any path is held by uncommitted work. -->
                <span class="text-2xs text-subtle">
                    <template v-if="mine.length > 0">{{ t(`agents.agentConflictReport.askingAgentToRebase`) }}</template
                    ><template v-if="mine.length > 0 && theirs.length > 0">{{ t(`agents.agentConflictReport.and`) }} </template
                    ><template v-if="theirs.length > 0">{{
                        t(`agents.agentConflictReport.yourEditsAreThere`, { count: theirs.length }, theirs.length)
                    }}</template
                    >.<template v-if="mergeable"> {{ t(`agents.agentConflictReport.landingConflictMarkersStill`) }}</template>
                </span>
            </div>

            <!-- First: the one action costing the user nothing, the agent redoing its own merge. -->
            <div v-if="box === undefined && mine.length > 0" :class="ROW">
                <Button
                    size="small"
                    :class="INLINE"
                    :disabled="busy || streaming"
                    @click="emit('resolve')"
                    v-tooltip.bottom="streaming ? t(`agents.agentConflictReport.waitAgentTurnTo`) : undefined"
                >
                    <Icon name="sparkles" />{{ words.resolveConflict }}
                </Button>
                <span class="text-2xs text-subtle">
                    {{ words.resolveConflictHint
                    }}<template v-if="theirs.length > 0">
                        {{ t(`agents.agentConflictReport.yourEditsStillNeedYou`, { count: theirs.length }, theirs.length) }}</template
                    >
                </span>
            </div>

            <!-- The user's own half, which nothing else here can do for them; primary only when it's the sole thing left blocking. -->
            <div v-if="box === undefined && theirs.length > 0" :class="ROW">
                <Button size="small" :severity="mine.length === 0 ? undefined : `secondary`" :class="INLINE" @click="emit('commit')">
                    <Icon name="file-edit" />{{ t(`agents.agentConflictReport.commitStashYours`) }}
                </Button>
                <!-- Says what the button does inline instead of behind a pointer-only tooltip. -->
                <span class="text-2xs text-subtle">{{ t(`agents.agentConflictReport.opensChangesPanelLand`) }}</span>
            </div>

            <!-- Last and quiet: the only option here that writes to the user's tree on failure. -->
            <div v-if="mergeable" :class="ROW">
                <Button
                    size="small"
                    severity="secondary"
                    :class="INLINE"
                    :disabled="busy || writing"
                    @click="emit('merge')"
                    v-tooltip.bottom="writing ? t(`agents.agentConflictReport.waitUntilAgentStops`) : undefined"
                >
                    <Icon name="check" />{{ t(`agents.agentConflictReport.landConflictMarkers`) }}
                </Button>
                <span class="text-2xs text-subtle">{{ t(`agents.agentConflictReport.finishMergeYourselfIn`) }}</span>
            </div>
        </template>
    </div>
</template>
