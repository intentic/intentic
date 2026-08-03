<script setup lang="ts">
import { Icon, timeAgo } from "@intentic/ui";
import type { WorkflowRun } from "@intentic/sandbox-contract";
import { computed } from "vue";
import { laneOfRun, runningTitles, spentOn } from "../composables/agents/useWorkflowRuns";
import { liveSessions } from "../composables/chat/chatRun";

/* A WORKFLOW RUN, ON THE BOARD — the row that was missing while a five-step run arrived as five unrelated
 * agents that happened to start together.
 *
 * IT IS AN AGENT CARD'S SIBLING, NOT AN AGENT CARD. It borrows the shell (same radius, border, lane bar,
 * hover) because it stands in the same column and a second visual language there would read as a bug. What it
 * does NOT borrow is the body: a run has no provider, no branch, no worktree and no transcript, so the model
 * line, the diff stat, Land and Archive would every one of them be a control over something that does not
 * exist. What it has instead is the only thing a run has: how far through the graph it is, what is burning
 * right now, and a Stop.
 *
 * CLICKING IT OPENS THE SESSIONS IT IS RUNNING, side by side — which is the answer to "what is my workflow
 * doing" that no single navigation could give before. A run of two attempts becomes two panes; a run with one
 * live step becomes one. That is why the card exists on this board rather than only on the workflows page:
 * this board is where the panes are.
 */

const { run } = defineProps<{ run: WorkflowRun; selected?: boolean; stopping?: boolean }>();
const emit = defineEmits<{ open: []; stop: []; graph: [] }>();

const lane = computed(() => laneOfRun(run));
const live = computed(() => liveSessions(run));
const doing = computed(() => runningTitles(run));
const spent = computed(() => spentOn(run));
const done = computed(() => run.steps.filter((step) => step.state === `done`).length);

// The state word, in the vocabulary the rest of the board uses. `running` is the only one that earns a colour
// of its own here — the three that mean "you have to look at this" are already saying so with the lane bar.
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
        :aria-label="`Open the sessions of ${run.workflow.name}`"
        class="group flex w-full cursor-pointer select-none flex-col gap-1.5 rounded-lg border border-dashed p-3 text-left outline-none transition-colors hover:bg-overlay focus-visible:ring-2 focus-visible:ring-primary-500/25"
        :class="[
            // Dashed, and that is the whole visual claim: this is a container of the solid cards around it
            // rather than one of them. The lane bar is the agent card's, unchanged — attention means the same
            // thing whatever kind of row is carrying it.
            lane === 'attention' ? 'border-l-[3px] border-l-warning' : '',
            // The agent card's selection, on the agent card's channel: the chat panel is showing THIS run, and
            // a board that says so about a session but not about a run makes the run look like a thing you
            // cannot point the chat at.
            selected ? 'border-primary-500 bg-overlay ring-2 ring-primary-500/50' : 'border-line bg-card hover:border-line-strong',
            stopping ? 'pointer-events-none opacity-60' : '',
        ]"
        @click="emit(`open`)"
        @keydown.enter.self.prevent="emit(`open`)"
        @keydown.space.self.prevent="emit(`open`)"
    >
        <div class="flex items-center gap-2">
            <!-- The graph glyph, where an agent card carries its identity tile: one look says "this row is a
                 shape, not a session". -->
            <span class="flex h-5 w-5 shrink-0 items-center justify-center rounded bg-primary-600/15">
                <Icon name="sitemap" class="text-2xs text-link" />
            </span>
            <span class="min-w-0 flex-1 truncate text-xs font-semibold text-content">{{ run.workflow.name }}</span>
            <button
                type="button"
                aria-label="Open the run's graph"
                v-tooltip.top="`Open the graph — every step, and what each one decided`"
                class="shrink-0 rounded p-1 text-subtle opacity-0 transition-opacity hover:text-content focus-visible:opacity-100 group-hover:opacity-100"
                @click.stop="emit(`graph`)"
            >
                <Icon name="external-link" class="text-2xs" />
            </button>
            <!-- Stop is on the card and not behind a hover, unlike the agent card's Archive: it is the one
                 thing a person opens this board to do to a run that is going wrong, and a control you have to
                 discover by hovering is one that is not there at 2am. -->
            <button
                v-if="run.state === `running`"
                type="button"
                aria-label="Stop this workflow run"
                v-tooltip.top="`Stop the run. Steps in flight finish the round they are on; nothing new starts.`"
                :disabled="stopping"
                class="shrink-0 rounded p-1 text-subtle transition-colors hover:bg-danger/10 hover:text-danger disabled:opacity-40"
                @click.stop="emit(`stop`)"
            >
                <Icon :name="stopping ? `spinner` : `stop`" :spin="stopping" class="text-2xs" />
            </button>
            <Icon v-else :name="run.state === `done` ? `check-circle` : `sitemap`" class="shrink-0 text-xs" :class="TONE[run.state]" />
        </div>

        <!-- What it was asked to do. The first thing anybody wants off a run they did not start themselves,
             and absent for a run started from the workflows page, which had no composer to read one from. -->
        <p v-if="run.request" class="line-clamp-2 text-2xs italic leading-4 text-muted">{{ run.request }}</p>

        <div class="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-2xs text-muted">
            <span :class="TONE[run.state]">{{ run.state === `running` ? `${live.length} live` : run.state }}</span>
            <span>{{ done }}/{{ run.steps.length }} steps</span>
            <span v-if="spent > 0">${{ spent.toFixed(2) }}</span>
            <span>{{ timeAgo(run.startedAt) }}</span>
        </div>

        <!-- Which part of the design is actually burning money right now. The step COUNT above answers "how
             far"; this answers "at what", and on a fan-out it is the line that says both attempts are up. -->
        <p v-if="doing.length > 0" class="flex min-w-0 items-center gap-1.5 text-2xs text-subtle">
            <Icon name="spinner" spin class="shrink-0 text-2xs text-link" />
            <span class="truncate">{{ doing.join(` · `) }}</span>
        </p>
        <p v-else-if="run.detail" class="line-clamp-2 text-2xs leading-4" :class="lane === `attention` ? `text-warning` : `text-subtle`">
            {{ run.detail }}
        </p>
    </div>
</template>
