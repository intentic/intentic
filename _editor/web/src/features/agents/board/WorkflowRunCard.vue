<script setup lang="ts">
import { Icon, timeAgo, ui } from "@intentic/ui";
import type { WorkflowRun } from "@intentic/sandbox-contract";
import { computed } from "vue";
import { laneOfRun, runningTitles, spentOn } from "../fleet/useWorkflowRuns";
import { liveSessions } from "../../chat/run/chatRun";

// A workflow run's row on the board, an agent card's sibling, not one: same shell (radius, border, lane bar, hover)
// since it shares the column, but no provider/branch/worktree/transcript, so Land/Archive/diff don't apply.
// Shows only what a run has: progress through the graph, what's burning right now, and Stop.
// Clicking opens its live sessions side by side, one pane per attempt; that's why it lives on this board and not only
// the workflows page.

// `dense` is the stacked, narrow board, exactly as AgentCard means it: it does not change what this row says, only
// that it is drawn at the ledger's weight, since a stacked board's lanes are told apart by their order.
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
        :aria-label="`Open the sessions of ${run.workflow.name}`"
        class="session-card group flex w-full select-none flex-col rounded-xl border border-dashed text-left outline-none focus-visible:ring-2 focus-visible:ring-primary-500/25"
        :class="[
            // Same step the agent cards take (AgentCard's `live`), so a lane draws one card size.
            bigLane ? 'gap-2.5 p-4' : 'gap-2 p-3.5',
            /* Dashed, and that is the whole visual claim: this is a container of the solid cards around it
               rather than one of them. Everything else — fill, border, hover, the selection ring and the
               attention bar — is the session card's shared surface (.session-card in styles.css), the same one
               the agent cards beside it and the chat rail's rows wear. The bar is an inset shadow there, so
               nothing about it is dashed and the two rhythms can no longer argue. */
            lane === 'attention' ? 'session-card-attention' : '',
            // The agent card's selection, on the agent card's channel: the chat panel is showing THIS run, and
            // a board that says so about a session but not about a run makes the run look like a thing you
            // cannot point the chat at.
            selected ? 'session-card-on' : '',
            stopping ? 'pointer-events-none opacity-60' : '',
        ]"
        @click="emit(`open`)"
        @keydown.enter.self.prevent="emit(`open`)"
        @keydown.space.self.prevent="emit(`open`)"
    >
        <div class="flex items-center gap-2.5">
            <!--
                Graph glyph where an agent card has its identity tile: one look says this row is a shape, not a
                session. Two boxes, not one, so it lands on the agent tile's geometry exactly: a 22px disc centred in
                the 28px slot the tile's context ring occupies (AgentCard, which argues the proportion). A run has no
                context of its own to ring, but its title still has to start on the same axis as the titles under it,
                and its mark has to be the same shape AND size as theirs, or the lane draws two vocabularies.
                It wears the empty rim for that reason: without it a run's bare disc reads a size smaller than the
                ringed cards beside it. The inset ring is ProgressRing's own track, restated (AgentCard argues it).
            -->
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
            <!-- Wears the agent card's own attention chip, since the waiting step has no card of its own to wear it: the run answers on its behalf. -->
            <span
                v-if="needsYou"
                v-tooltip.top="`A step is waiting on you: open the run to answer it`"
                class="shrink-0 rounded-full bg-warning/15 px-1.5 py-px text-2xs font-semibold text-warning"
                >needs you</span
            >
            <button
                type="button"
                aria-label="Open the run's graph"
                v-tooltip.top="`Open the graph: every step, and what each one decided`"
                class="shrink-0 rounded p-1 text-subtle opacity-0 transition-opacity hover:text-content focus-visible:opacity-100 group-hover:opacity-100"
                @click.stop="emit(`graph`)"
            >
                <Icon name="external-link" class="text-2xs" />
            </button>
            <!--
                The ended run's exit, in the slot Stop occupies while running: it's the agent card's Archive, aimed at a whole graph, needed since
                nothing transitions a run automatically off the lane.
                Takes the run's sessions with it (their only cards), unlike the old dismissal, which just scattered a finished job's conversations
                back onto the lanes.
                Lossless like the agent card's Archive: branches, transcripts and counters stay, and Restore is permanent, which is what lets this
                skip a confirmation dialog.
            -->
            <button
                v-if="run.state !== `running` && run.archivedAt === undefined"
                type="button"
                aria-label="Archive this run"
                v-tooltip.top="`Archive: takes the run and its sessions off the board. Branches and transcripts are kept.`"
                class="shrink-0 rounded p-1 text-subtle opacity-0 transition-opacity hover:bg-content/10 hover:text-content focus-visible:opacity-100 group-hover:opacity-100"
                @click.stop="emit(`archive`)"
            >
                <Icon name="box" class="text-2xs" />
            </button>
            <!-- The way back, permanent and per-row, like the archived agent card's: an undo on the card can't expire. -->
            <button
                v-if="run.archivedAt !== undefined"
                type="button"
                aria-label="Restore this run"
                v-tooltip.top="`Put the run and its sessions back on the board`"
                class="shrink-0 rounded p-1 text-subtle opacity-0 transition-opacity hover:bg-content/10 hover:text-content focus-visible:opacity-100 group-hover:opacity-100"
                @click.stop="emit(`restore`)"
            >
                <Icon name="undo" class="text-2xs" />
            </button>
            <!--
                On the card, not behind hover, unlike Archive: it's the one thing a person opens this board to do to a run going wrong, and a
                hover-only control isn't there at 2am.
            -->
            <button
                v-if="run.state === `running`"
                type="button"
                aria-label="Stop this workflow run"
                v-tooltip.top="`Stop the run: its steps are cut off where they are and nothing new starts.`"
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
            <span :class="TONE[run.state]">{{ run.state === `running` ? `${live.length} live` : run.state }}</span>
            <span>{{ done }}/{{ run.steps.length }} steps</span>
            <span v-if="spent > 0">${{ spent.toFixed(2) }}</span>
            <!-- Archived rows date by filing, not start, like the agent card: "when" means "when I put it away". -->
            <span v-if="run.archivedAt !== undefined">Archived {{ timeAgo(run.archivedAt) }}</span>
            <span v-else>{{ timeAgo(run.startedAt) }}</span>
        </div>

        <!--
            What's actually burning money right now, distinct from the step count's "how far"; on a fan-out this is the line that shows both attempts
            are live.
        -->
        <p v-if="doing.length > 0" class="flex min-w-0 items-center gap-1.5 text-2xs text-subtle">
            <Icon name="spinner" spin class="shrink-0 text-2xs text-link" />
            <span class="truncate">{{ doing.join(` · `) }}</span>
        </p>
        <p v-else-if="run.detail" class="line-clamp-2 text-2xs leading-4" :class="lane === `attention` ? `text-warning` : `text-subtle`">
            {{ run.detail }}
        </p>
    </div>
</template>
