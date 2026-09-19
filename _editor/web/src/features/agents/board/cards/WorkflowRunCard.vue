<script setup lang="ts">
import { Icon, timeAgo, ui } from "@intentic/ui";
import type { WorkflowRun } from "@intentic/sandbox-contract";
import { computed } from "vue";
import { laneOfRun, runningTitles, spentOn } from "../../fleet/useWorkflowRuns";
import { liveSessions } from "../../../chat/run/chatRun";
import { useT } from "@intentic/ui/i18n";

// A workflow run's row on the board, an agent card's sibling, not one: same shell (radius, border, lane bar, hover)
// since it shares the column, but no provider/branch/worktree/transcript, so Land/Archive/diff don't apply.
// Shows only what a run has: progress through the graph, what's burning right now, and Stop.
// Clicking opens its live sessions side by side, one pane per attempt; that's why it lives on this board and not only
// the workflows page.

// `dense` is the stacked, narrow board, exactly as AgentCard means it: it does not change what this row says, only
// that it is drawn at the ledger's weight, since a stacked board's lanes are told apart by their order.
const t = useT();

const { run, dense } = defineProps<{ run: WorkflowRun; dense?: boolean; selected?: boolean; needsYou?: boolean; stopping?: boolean }>();
const emit = defineEmits<{ open: []; stop: []; graph: []; archive: []; restore: [] }>();

const lane = computed(() => laneOfRun(run));
const live = computed(() => liveSessions(run));
const doing = computed(() => runningTitles(run));
const spent = computed(() => spentOn(run));
const done = computed(() => run.steps.filter((step) => step.state === `done`).length);

// State word in the board's own vocabulary.
// Only `running` gets its own color here; the other "look at this" states already have the lane bar.
// The board's lane weight, read the same way AgentCard reads it (`live` there): a run in Attention or Active is
// drawn at the live size, one in Finished at the ledger's. Named for the lane rather than for liveness because
// `live` is already this file's word for the run's running sessions.
// It has to agree with the agent cards or a lane draws two card sizes in one column, which reads as a bug rather
// than as a hierarchy.
const bigLane = computed(() => dense !== true && lane.value !== `finished`);

const TONE: Record<WorkflowRun["state"], string> = {
    running: `text-link`,
    done: `text-success`,
    failed: `text-danger`,
    stopped: `text-subtle`,
    overspent: `text-warning`,
    error: `text-danger`,
};
</script>

<template>
    <div
        role="button"
        tabindex="0"
        :aria-label="t(`agents.workflowRunCard.openSessions`, { name: run.workflow.name })"
        class="session-card group flex w-full select-none flex-col rounded-xl border border-dashed text-left outline-none focus-visible:ring-2 focus-visible:ring-primary-500/25"
        :class="[
            // Same step the agent cards take (AgentCard's `live`), so a lane draws one card size.
            bigLane ? 'gap-2.5 p-4' : 'gap-2 p-3.5',
            /* Dashed, and that is the whole visual claim: this is a container of the solid cards around it rather than one of them. */
            lane === 'attention' ? 'session-card-attention' : '',
            // The agent card's selection, on the agent card's channel: the chat panel is showing THIS run, and
            // a board that says so about a session but not about a run makes the run look like a thing you
            // cannot point the chat at.
            selected ? 'session-card-on' : '',
            // Dimmed while the stop runs, and no more: its presses are pressed out one by one below, and the click
            // that opens the run's sessions is not one of them.
            stopping ? 'opacity-60' : '',
        ]"
        @click="emit(`open`)"
        @keydown.enter.self.prevent="emit(`open`)"
        @keydown.space.self.prevent="emit(`open`)"
    >
        <div class="flex items-center gap-2.5">
            <!-- Graph glyph where an agent card has its identity tile: one look says this row is a shape, not a session. -->
            <span class="flex h-7 w-7 shrink-0 items-center justify-center rounded-full ring-(length:--ring-track) ring-inset ring-content/12">
                <span class="flex h-5.5 w-5.5 shrink-0 items-center justify-center rounded-full bg-primary-600/15">
                    <Icon name="sitemap" class="text-2xs text-link" />
                </span>
            </span>
            <!-- `break-words` for the reason AgentCard's title states: a clamp only ellipsises a VERTICAL overrun. -->
            <span
                class="min-w-0 flex-1 font-semibold text-content"
                :class="bigLane ? 'line-clamp-2 break-words text-sm leading-snug' : 'truncate text-xs'"
                >{{ run.workflow.name }}</span
            >
            <!-- Waiting runs use the agent card's attention chip. -->
            <span
                v-if="needsYou"
                v-tooltip.top="t(`agents.workflowRunCard.stepWaitingOnOpen`)"
                class="ui-status-pill shrink-0 bg-warning/15 text-2xs font-semibold text-warning"
                >{{ t(`agents.workflowRunCard.needs`) }}</span
            >
            <button
                type="button"
                :aria-label="t(`agents.workflowRunCard.openRunsGraph`)"
                v-tooltip.top="t(`agents.workflowRunCard.openGraphEveryStep`)"
                class="shrink-0 rounded p-1 text-subtle opacity-0 transition-opacity hover:text-content focus-visible:opacity-100 group-hover:opacity-100"
                @click.stop="emit(`graph`)"
            >
                <Icon name="external-link" class="text-2xs" />
            </button>
            <!-- Ended runs use the action slot for archive. -->
            <button
                v-if="run.state !== `running` && run.archivedAt === undefined"
                type="button"
                :aria-label="t(`agents.workflowRunCard.archiveRun`)"
                v-tooltip.top="t(`agents.workflowRunCard.archiveTakesRunSessions`)"
                :disabled="stopping"
                class="shrink-0 rounded p-1 text-subtle opacity-0 transition-opacity hover:bg-content/10 hover:text-content focus-visible:opacity-100 group-hover:opacity-100"
                @click.stop="emit(`archive`)"
            >
                <Icon name="box" class="text-2xs" />
            </button>
            <!-- The way back, permanent and per-row, like the archived agent card's: an undo on the card can't expire. -->
            <button
                v-if="run.archivedAt !== undefined"
                type="button"
                :aria-label="t(`agents.workflowRunCard.restoreRun`)"
                v-tooltip.top="t(`agents.workflowRunCard.putRunSessionsBack`)"
                :disabled="stopping"
                class="shrink-0 rounded p-1 text-subtle opacity-0 transition-opacity hover:bg-content/10 hover:text-content focus-visible:opacity-100 group-hover:opacity-100"
                @click.stop="emit(`restore`)"
            >
                <Icon name="undo" class="text-2xs" />
            </button>
            <!-- Active runs keep their primary open action visible. -->
            <button
                v-if="run.state === `running`"
                type="button"
                :aria-label="t(`agents.workflowRunCard.stopWorkflowRun`)"
                v-tooltip.top="t(`agents.workflowRunCard.stopRunStepsCut`)"
                :disabled="stopping"
                :class="ui.iconButton(`h-auto w-auto shrink-0 rounded p-1 text-subtle hover:bg-danger/10 hover:text-danger`)"
                @click.stop="emit(`stop`)"
            >
                <Icon :name="stopping ? `spinner` : `stop`" :spin="stopping" class="text-2xs" />
            </button>
            <Icon v-else :name="run.state === `done` ? `check-circle` : `sitemap`" class="shrink-0 text-xs" :class="TONE[run.state]" />
        </div>

        <!-- What it was asked to do; absent for a run started on the workflows page, with no composer to read one from. -->
        <p v-if="run.request" class="line-clamp-2 text-2xs italic leading-4 text-muted">{{ run.request }}</p>

        <div class="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-2xs text-muted">
            <span :class="TONE[run.state]">{{ run.state === `running` ? t(`agents.workflowRunCard.live`, { count: live.length }) : run.state }}</span>
            <span>{{ t(`agents.workflowRunCard.steps`, { done, count: run.steps.length }) }}</span>
            <span v-if="spent > 0">${{ spent.toFixed(2) }}</span>
            <!-- Archived rows date by filing, not start, like the agent card: "when" means "when I put it away". -->
            <span v-if="run.archivedAt !== undefined">{{ t(`agents.workflowRunCard.archived`, { archivedAt: timeAgo(run.archivedAt) }) }}</span>
            <span v-else>{{ timeAgo(run.startedAt) }}</span>
        </div>

        <!-- Usage reports the active work, not only the completed step count. -->
        <p v-if="doing.length > 0" class="flex min-w-0 items-center gap-1.5 text-2xs text-subtle">
            <Icon name="spinner" spin class="shrink-0 text-2xs text-link" />
            <span class="truncate">{{ doing.join(` · `) }}</span>
        </p>
        <p v-else-if="run.detail" class="line-clamp-2 text-2xs leading-4" :class="lane === `attention` ? `text-warning` : `text-subtle`">
            {{ run.detail }}
        </p>
    </div>
</template>
