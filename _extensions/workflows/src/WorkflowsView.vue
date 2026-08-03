<script setup lang="ts">
import { Button, cmp, ConfirmDialog, Icon, InfoHint, Page, PageAction, PageHeader, RowGroup, timeAgo } from "@intentic/extension-ui";
import type { Workflow, WorkflowRun, WorkflowSummary } from "@intentic/sandbox-contract";
import { computed, ref, shallowRef } from "vue";
import WorkflowDesigner from "./WorkflowDesigner.vue";
import WorkflowRunPage from "./WorkflowRunPage.vue";
import { host } from "./host";
import { WORKFLOW_TEMPLATES, type WorkflowTemplate } from "./templates";
import { useWorkflows } from "./useWorkflows";

/* WORKFLOWS: designed graphs of agent sessions, each producing a declared output.
 *
 * The third driver, and the page says which by what it does NOT have. An automation has an enabled switch,
 * because something fires it. A loop has no page at all, because it is started against a conversation and then
 * it is history. A workflow has neither: it is a DESIGN you keep, edit and run — so this page is a list of
 * designs with a Run button, and everything about watching one lives behind that button.
 *
 * THE TEMPLATE IS UNDER THE LIST, not in the create dialog, and that is the one deliberate difference from the
 * automations page. Automation recipes are prefill for a form whose shape you already understand; a workflow
 * template is the only way most people will learn what shapes are POSSIBLE — that a reviewer should be a
 * different session, that two steps can run on two different models, that a step can be made to produce data
 * the next one consumes. So it stays visible on the page rather than hiding one level in, and it sells its
 * SHAPE rather than its topic.
 */

const { workflows, runs, runsLoaded, error: listError, remove, start } = useWorkflows();

/* WHICH OF THE THREE SCREENS THIS IS, and it is read from the URL rather than held in a ref.
 *
 * `?edit=<id>` is the designer, `?run=<runId>` is a run, neither is the list. The query is an extension view's
 * whole route space (IntenticApi.route), so this buys Back, reload and a linkable address for free — and it is
 * why the designer stopped being a dialog: a modal cannot be any of those things, and a graph needs a page.
 *
 * A DRAFT IS NOT IN THE URL. `?edit=new` names an unsaved workflow whose content is held here, because a
 * document nobody has saved has no address to link to. Held in a shallowRef: it is only read and handed to the
 * designer, which takes its own copy, and deep reactivity would wrap it in a proxy on the way out (see
 * workflowDraft.ts for what that cost).
 */
const query = computed(() => host().route.query());
const editing = computed(() => query.value[`edit`]);
const watchingId = computed(() => query.value[`run`]);
const drafted = shallowRef<Workflow | undefined>();

const confirmRemoveId = ref<string | undefined>();
const actionError = ref<string | undefined>();

const topError = computed(() => actionError.value ?? listError.value);
const watching = computed(() => runs.value.find((run) => run.runId === watchingId.value));
/* `?run=` naming a run the ledger no longer holds. Reachable rather than theoretical: the workflow mark on a
 * fleet card is never cleared (which run a conversation came out of is what its card is read for a week later),
 * while the ledger keeps only the last 50 runs — so the card outlives the record it links to. Falling through
 * to the list silently reads as the link having done nothing, which is the one thing it must not look like.
 * Gated on the ledger having actually been READ, so a slow first load cannot accuse a good link. */
const lostRunId = computed(() => (watchingId.value !== undefined && watching.value === undefined && runsLoaded.value ? watchingId.value : undefined));
/* The workflow the designer is on: a saved one by id, or the draft that `?edit=new` stands for.
 *
 * The draft ALSO answers for its own id once it has been saved, and that is not belt-and-braces — it closes a
 * real gap. Saving navigates to `?edit=<id>` the moment the POST resolves, but the list query is only
 * invalidated then, so for one refetch there is no saved workflow under that id yet. Without this the designer
 * would unmount and flick back to the list at the exact moment the user pressed Save. Scoped by id rather than
 * left as a general fallback, so `?edit=<something-deleted>` cannot quietly open a stale draft instead. */
const designing = computed<Workflow | undefined>(() => {
    if (editing.value === undefined) {
        return undefined;
    }
    const saved = workflows.value.find((workflow) => workflow.id === editing.value);
    return saved ?? (editing.value === `new` || drafted.value?.id === editing.value ? drafted.value : undefined);
});
const live = computed(() => runs.value.filter((run) => run.state === `running`));
const past = computed(() => runs.value.filter((run) => run.state !== `running`).slice(0, 12));
/* THE GALLERY OFFERS EVERY TEMPLATE, INCLUDING ONE ALREADY SAVED under its own id — which it used to hide, on
 * the reasoning that the gallery is for shapes you do not have.
 *
 * That reasoning had a hole, and it is the one people fall down: a template is PREFILL, so a saved copy is a
 * fork taken at the moment it was picked. When the template moves on — a step removed, a prompt rewritten —
 * the saved workflow does not, and hiding the card left no way to take the new version short of deleting the
 * old one first. Somebody watching the template change and their own run not change has no way to connect the
 * two. Picking it still costs nothing: it opens the DESIGNER prefilled, and nothing is written until Save.
 */
const available = computed(() => WORKFLOW_TEMPLATES);
const savedAlready = (template: WorkflowTemplate): boolean => workflows.value.some((workflow) => workflow.id === template.workflow.id);

// A saved workflow opens by id; anything unsaved is parked in `drafted` first and opens as `new`.
const openSaved = (id: string): void => host().route.setQuery({ edit: id, run: undefined }, { push: true });
const openDraft = (workflow: Workflow): void => {
    drafted.value = workflow;
    host().route.setQuery({ edit: `new`, run: undefined }, { push: true });
};
const watchRun = (runId: string): void => host().route.setQuery({ run: runId, edit: undefined }, { push: true });
const backToList = (): void => host().route.setQuery({ edit: undefined, run: undefined });

// A template opens the designer PREFILLED rather than creating the workflow: a graph that costs money to run
// is not something to create by accident, and looking at the picture before saving is the whole point.
// Handed over uncloned — the designer copies whatever it is given, so the module constant is only ever read.
const fromTemplate = (template: WorkflowTemplate): void => openDraft(template.workflow);

const blank = (): void =>
    openDraft({
        id: `workflow-${workflows.value.length + 1}`,
        name: `New workflow`,
        // No goal and no prompt: the step does whatever the run is asked to do and is measured against it. A
        // blank workflow is therefore RUNNABLE the moment it is named, which is the point — the author adds
        // structure (a second step, a check, a declared output) rather than filling in boilerplate to begin.
        steps: [
            {
                id: `step-1`,
                title: `First step`,
                needs: [],
                handoff: `fresh`,
                output: { kind: `none` },
                checks: [],
                context: `fresh`,
            },
        ],
        maxParallel: 2,
    });

/* RUN HANDS THE START OVER RATHER THAN PERFORMING IT. Pressing it opens a new agent session with this design
 * named on the composer's workflow badge — and that is where the run begins, when the user types what they
 * want and presses send.
 *
 * It used to start the run here, behind a dialog with its own prompt box, and that was two ways to begin agent
 * work: the one everybody knows (a composer) and this one, which looked like nothing else in the product and
 * put a text box inside a modal on a list page. Starting a workflow is starting agent work; the difference is
 * only that the message fans out. So the composer is the place, and this button's job is to get you there
 * with the design already picked. Nothing is spent until the send.
 */
const runNow = (workflow: WorkflowSummary): void => host().chat.composeWorkflow(workflow.id);

const removeWorkflow = async (): Promise<void> => {
    const id = confirmRemoveId.value;
    if (id === undefined) {
        return;
    }
    actionError.value = undefined;
    try {
        await remove.mutateAsync(id);
        confirmRemoveId.value = undefined;
    } catch (error) {
        actionError.value = error instanceof Error ? error.message : `The workflow could not be removed.`;
    }
};

// A run's headline: how far it got, and what it cost. Both numbers, because "3 of 7" and "$4.10" answer the
// two different questions a person has about a run they were not watching.
const runLine = (run: WorkflowRun): string =>
    [
        `${run.steps.filter((step) => step.state === `done`).length}/${run.steps.length} steps`,
        run.steps.reduce((total, step) => total + (step.costUsd ?? 0), 0) > 0
            ? `$${run.steps.reduce((total, step) => total + (step.costUsd ?? 0), 0).toFixed(2)}`
            : ``,
        timeAgo(run.startedAt),
    ]
        .filter((part) => part !== ``)
        .join(` · `);

const RUN_TONE: Record<WorkflowRun["state"], string> = {
    running: `text-link`,
    done: `text-success`,
    failed: `text-danger`,
    stopped: `text-subtle`,
    overspent: `text-warning`,
    error: `text-danger`,
};

const shapeOf = (workflow: Workflow): string => {
    const roots = workflow.steps.filter((step) => step.needs.length === 0).length;
    const widest = Math.max(1, ...workflow.steps.map((step) => workflow.steps.filter((other) => other.needs.includes(step.id)).length));
    const count = `${workflow.steps.length} step${workflow.steps.length === 1 ? `` : `s`}`;
    // A single step has no shape to describe — "1 step in a line" is a sentence about nothing.
    if (workflow.steps.length === 1) {
        return count;
    }
    return roots > 1 || widest > 1 ? `${count}, branching` : `${count} in a line`;
};
</script>

<template>
    <!-- THREE SCREENS, ONE VIEW. The designer and a run each need the whole page (a graph does not fit in a
         dialog), and an extension's route space is the query — so this switches on it rather than layering
         modals over the list. `h-full` because both of those are canvas pages that must not scroll. -->
    <!-- SAVING GOES BACK TO THE LIST. It used to navigate `?edit=new` → `?edit=<id>`, which is the same
         screen at a different address — and since `editing` is this component's `:key`, the designer was torn
         down and rebuilt in place: a flicker, then the form you were already looking at. Nothing about the
         press was legible as having worked. A save is finishing with the document, so it closes it. -->
    <WorkflowDesigner v-if="designing" :key="editing" :initial="designing" @close="backToList()" @saved="backToList()" />
    <WorkflowRunPage v-else-if="watching" :key="watching.runId" :run="watching" @close="backToList()" />

    <Page v-else width="wide">
        <PageHeader title="Workflows" description="A designed run of agent sessions, each one handing a declared result to the next.">
            <template #info>
                <InfoHint label="How a workflow runs">
                    <span class="block text-sm font-medium text-content">Every step is an agent session</span>
                    <span class="mt-1 block text-xs text-muted">
                        A step is one session with one job, and it is finished when that session is. What it was told is exactly what you typed,
                        unless the step was given instructions of its own — and what it concluded is handed to the steps waiting on it.
                    </span>
                    <span class="mt-2 block text-xs text-muted">
                        Ask a step for a declared output or a check and it becomes a loop instead: it repeats until that holds, or until a runaway
                        backstop stops it. That is worth having when a step has a bar you can state; it is a cost when it does not.
                    </span>
                    <span class="mt-2 block text-xs text-muted">
                        A step can carry on the previous session or start a new one. New is what makes a review worth having; carrying on is what lets
                        a chain build on itself.
                    </span>
                    <span class="mt-2 block text-xs text-muted">The daemon runs it — closing this tab, or your laptop, changes nothing.</span>
                </InfoHint>
            </template>
            <template #actions>
                <PageAction icon="plus" label="New workflow" primary @click="blank()" />
            </template>
        </PageHeader>

        <div v-if="topError" :class="cmp.alertDanger('mb-4')">{{ topError }}</div>

        <!-- A link to a run that has rolled off the ledger. Not an error — nothing failed and nothing is wrong
             with the card that sent you here — so it states the fact and leaves the page usable beneath it. -->
        <div v-if="lostRunId !== undefined" :class="cmp.alertInfo('mb-4')">
            Run <span class="font-mono">{{ lostRunId }}</span> is no longer on the record — the ledger keeps the last 50 runs.
        </div>

        <div class="flex flex-col gap-6">
            <!-- Runs in flight sit at the top, above the designs: while something is going, that is the page. -->
            <section v-if="live.length > 0">
                <div class="mb-2 flex items-center gap-2 px-0.5">
                    <Icon name="spinner" class="animate-spin text-2xs text-link" />
                    <span :class="cmp.sectionLabel('text-link')">Running now</span>
                </div>
                <div class="divide-y divide-line overflow-hidden rounded-lg border border-link/40 bg-card">
                    <button
                        v-for="run in live"
                        :key="run.runId"
                        type="button"
                        class="flex w-full cursor-pointer items-center gap-2 px-2.5 py-2 text-left hover:bg-canvas"
                        @click="watchRun(run.runId)"
                    >
                        <span class="truncate text-xs font-medium text-content">{{ run.workflow.name }}</span>
                        <span class="flex-1 truncate text-2xs text-subtle">{{ runLine(run) }}</span>
                        <Icon name="chevron-right" class="shrink-0 text-2xs text-subtle" />
                    </button>
                </div>
            </section>

            <RowGroup v-if="workflows.length > 0" label="Your workflows" :count="workflows.length">
                <div v-for="workflow in workflows" :key="workflow.id" class="flex flex-wrap items-center gap-x-2 gap-y-1 px-2.5 py-2">
                    <span class="shrink-0 text-xs font-medium text-content">{{ workflow.name }}</span>
                    <span class="shrink-0 text-2xs text-subtle">{{ shapeOf(workflow) }}</span>
                    <span v-if="workflow.description" class="min-w-0 flex-1 truncate text-2xs text-subtle">{{ workflow.description }}</span>
                    <span v-else class="flex-1"></span>
                    <!-- The last run, as a state word and nothing else. The row is a design, not a run; clicking
                         through is how you read one. -->
                    <button
                        v-if="workflow.runs[0]"
                        type="button"
                        class="shrink-0 cursor-pointer text-2xs hover:underline"
                        :class="RUN_TONE[workflow.runs[0].state]"
                        @click="watchRun(workflow.runs[0].runId)"
                    >
                        {{ workflow.runs[0].state }} {{ timeAgo(workflow.runs[0].startedAt) }}
                    </button>
                    <Button label="Run" size="small" :disabled="start.isPending.value" @click="runNow(workflow)">
                        <template #icon><Icon name="play" /></template>
                    </Button>
                    <button type="button" :class="cmp.iconButton()" aria-label="Edit" @click="openSaved(workflow.id)"><Icon name="pencil" /></button>
                    <button type="button" :class="cmp.iconButton('text-danger')" aria-label="Delete" @click="confirmRemoveId = workflow.id">
                        <Icon name="trash" />
                    </button>
                </div>
            </RowGroup>

            <div v-else :class="cmp.emptyState('py-5')">No workflows yet — start from the shape below.</div>

            <!-- The gallery, which is one card wide on purpose (templates.ts says why). So it is laid out as a
                 full-width row rather than as a lonely cell in a grid of three: a card sized for a set it is
                 not part of reads as a gallery that failed to load, and the summary it has to sell its SHAPE
                 with is a sentence that wants the measure. -->
            <section v-if="available.length > 0">
                <div class="mb-2 flex items-center gap-2 px-0.5">
                    <span :class="cmp.sectionLabel()">Start from</span>
                    <span class="text-2xs text-subtle"
                        >Opens the designer with a real workflow in it — nothing runs until you save and press Run.</span
                    >
                </div>
                <button
                    v-for="template in available"
                    :key="template.workflow.id"
                    type="button"
                    class="flex w-full cursor-pointer flex-col gap-1 rounded-lg border border-line bg-card p-3 text-left hover:border-line-strong"
                    @click="fromTemplate(template)"
                >
                    <span class="flex items-center gap-2">
                        <Icon :name="template.icon" class="shrink-0 text-xs text-subtle" />
                        <span class="text-xs font-medium text-content">{{ template.workflow.name }}</span>
                        <!-- You already have one of these. Said plainly, because a card that looks like "add a
                             new thing" while it is really "take the current version of a thing you forked" is
                             the difference between a save you meant and one you did not. -->
                        <span v-if="savedAlready(template)" class="shrink-0 rounded-full bg-overlay px-1.5 py-px text-2xs text-muted">saved</span>
                        <span class="ml-auto shrink-0 text-2xs text-subtle">{{ shapeOf(template.workflow) }}</span>
                    </span>
                    <span class="text-2xs leading-snug text-subtle">{{ template.summary }}</span>
                    <span v-if="savedAlready(template)" class="text-2xs leading-snug text-muted">
                        Your saved copy was forked from an older version of this. Opening it here shows the current one — saving replaces yours.
                    </span>
                </button>
            </section>

            <RowGroup v-if="past.length > 0" label="Earlier runs" :count="past.length">
                <button
                    v-for="run in past"
                    :key="run.runId"
                    type="button"
                    class="flex w-full cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left hover:bg-canvas"
                    @click="watchRun(run.runId)"
                >
                    <span class="shrink-0 truncate text-xs text-content">{{ run.workflow.name }}</span>
                    <span class="shrink-0 text-2xs font-medium" :class="RUN_TONE[run.state]">{{ run.state }}</span>
                    <span class="min-w-0 flex-1 truncate text-2xs text-subtle">{{ runLine(run) }}</span>
                    <Icon name="chevron-right" class="shrink-0 text-2xs text-subtle" />
                </button>
            </RowGroup>
        </div>

        <ConfirmDialog
            :open="confirmRemoveId !== undefined"
            header="Delete this workflow?"
            confirm-label="Delete"
            confirm-icon="trash"
            :loading="remove.isPending.value"
            @confirm="removeWorkflow()"
            @cancel="confirmRemoveId = undefined"
        >
            <p class="text-sm text-subtle">Its run history stays — every run kept its own copy of the design. A run already going is not stopped.</p>
        </ConfirmDialog>
    </Page>
</template>
