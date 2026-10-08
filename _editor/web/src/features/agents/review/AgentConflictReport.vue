<script setup lang="ts">
import type { LandConflict } from "@intentic/sandbox-contract";
import { Button, toneTint, useDevice } from "@intentic/ui";
import { computed } from "vue";
import { agentBlockers, blockersOf, causeLine, settingsOrigin, settingsPageName, userBlockers } from "./conflictResolution";
import { useT } from "@intentic/ui/i18n";

// What a refused land is blocking, as one decision bar: how many files conflict, why in one line, and what happens
// next. The fix itself is the header's press (AgentLandPress), so this bar never offers it a second time; it carries
// what that press cannot say: the fix in progress or queued, the user's own half, and the manual fallback.
// The paths are not listed here: "Show" narrows the file list below to them, where each row says its own cause.

const t = useT();

const props = defineProps<{
    conflicts: readonly LandConflict[];
    // Agent has a turn in flight in this window: what Stop can end.
    streaming: boolean;
    // Agent is mid-write; the merge only avoids catching the checkout half-written (a parked turn is fine).
    writing: boolean;
    // A land / ask this panel itself has in flight.
    busy: boolean;
    // The user has already handed this conflict back to the agent (useAgentChanges.asked).
    asked: boolean;
    // The fix was pressed during a turn and waits for it to end (useAgentChanges.fixQueued).
    queued: boolean;
    // Agent is in another sandbox; fixing and committing happen there, but merge stays offerable.
    box?: string;
}>();

// `saveSettings`: the held paths, to save before landing again.
const emit = defineEmits<{ merge: []; commit: []; saveSettings: [readonly string[]]; stop: []; chat: []; cancel: []; show: []; cross: [] }>();

const { mobile } = useDevice();

const blockers = computed(() => blockersOf(props.conflicts));
const blockedCount = computed(() => blockers.value.length);
// The agent's half (a rebase clears it) and the user's (only a commit does).
const mine = computed(() => agentBlockers(blockers.value));
const theirs = computed(() => userBlockers(blockers.value));
// The user's half when a Sandbox page wrote all of it: saved in one press rather than sent to Changes.
const settingsPages = computed(() => settingsOrigin(theirs.value)?.map(settingsPageName).join(`, `));
const why = computed(() => causeLine(blockers.value, settingsPages.value));
const saveSettings = (): void => emit(`saveSettings`, theirs.value.map((blocker) => blocker.path));
// A three-way apply goes through the index, so git refuses it outright on any unstaged path.
const mergeable = computed(() => blockedCount.value > 0 && theirs.value.length === 0);

const ROW = `flex flex-wrap items-center gap-x-2 gap-y-1`;
</script>

<template>
    <!-- Nothing was written yet: the agent's copy still holds every change, so this is a decision point, not a failure. -->
    <div class="flex shrink-0 flex-col gap-1 rounded-md border px-2 py-1.5" :class="toneTint(`warning`, `strong`)">
        <div :class="ROW">
            <Icon name="exclamation-triangle" class="shrink-0 text-2xs text-warning" />
            <span class="text-2xs font-medium text-content">
                {{
                    blockedCount === 0
                        ? t(`agents.agentConflictReport.couldntReachWorkspacesCopy`)
                        : t(`agents.agentConflictReport.filesConflict`, { count: blockedCount }, blockedCount)
                }}
            </span>
            <span class="text-2xs text-muted">{{ t(`agents.agentConflictReport.nothingLanded`) }}</span>
            <button
                v-if="blockedCount > 0"
                type="button"
                class="text-2xs text-link underline-offset-2 hover:underline"
                @click="emit('show')"
            >
                {{ t(`agents.agentConflictReport.show`) }}
            </button>
        </div>
        <p v-if="why !== undefined" class="text-2xs text-muted">{{ why }}</p>

        <!-- The fix running: re-asking or landing over it is not a real choice, so the bar says so and offers only Stop. -->
        <div v-if="asked" :class="ROW">
            <span class="inline-flex items-center gap-1.5 text-2xs text-link">
                <Icon name="spinner" spin class="text-2xs" />{{ t(`agents.agentConflictReport.fixing`) }}
            </span>
            <span class="flex-1"></span>
            <!-- Desktop already shows the conversation in the docked chat; only mobile needs a mode switch to watch it. -->
            <Button v-if="mobile" size="small" tier="quiet" tone="accent" class="whitespace-nowrap" @click="emit('chat')">
                {{ t(`agents.agentConflictReport.watch`) }}
            </Button>
            <Button v-if="streaming" size="small" tier="boring" class="whitespace-nowrap" :label="t(`ui.action.stop`)" @click="emit('stop')" />
        </div>

        <div v-else-if="queued" :class="ROW">
            <span class="inline-flex items-center gap-1.5 text-2xs text-muted">
                <Icon name="clock" class="text-2xs" />{{ t(`agents.agentConflictReport.queued`) }}
            </span>
            <span class="flex-1"></span>
            <Button size="small" tier="quiet" class="whitespace-nowrap" :label="t(`ui.action.cancel`)" @click="emit('cancel')" />
        </div>

        <div v-else-if="blockedCount > 0" :class="ROW">
            <!-- The fix is a turn over there: the crossing is the whole offer. -->
            <Button v-if="box !== undefined" size="small" tier="boring" class="whitespace-nowrap" @click="emit('cross')">
                <Icon name="arrow-right" />{{ t(`agents.words.openIn`) }} {{ box }}
            </Button>
            <!-- Written by a Sandbox page, not typed: one press saves exactly those files and lands again. -->
            <Button
                v-else-if="theirs.length > 0 && settingsPages !== undefined"
                size="small"
                :tier="mine.length === 0 ? `accent` : `boring`"
                class="whitespace-nowrap"
                :disabled="busy"
                @click="saveSettings"
            >
                <Icon name="check" />{{ t(`agents.agentConflictReport.saveSettingsAndLand`) }}
            </Button>
            <!-- The user's own half, which nothing else here can do for them. -->
            <template v-else-if="theirs.length > 0">
                <Button size="small" :tier="mine.length === 0 ? `accent` : `boring`" class="whitespace-nowrap" @click="emit('commit')">
                    <Icon name="file-edit" />{{ t(`agents.agentConflictReport.openChanges`) }}
                </Button>
                <span class="text-2xs text-muted">{{ t(`agents.agentConflictReport.commitThenLand`) }}</span>
            </template>
            <span class="flex-1"></span>
            <!-- Last and quiet: the only option here that writes conflict markers into the user's tree. -->
            <Button
                v-if="mergeable"
                size="small"
                tier="quiet"
                class="whitespace-nowrap"
                :disabled="busy || writing"
                @click="emit('merge')"
                v-tooltip.bottom="writing ? t(`agents.agentConflictReport.agentWriting`) : t(`agents.agentConflictReport.markersHint`)"
            >
                {{ t(`agents.agentConflictReport.landConflictMarkers`) }}
            </Button>
        </div>
    </div>
</template>
