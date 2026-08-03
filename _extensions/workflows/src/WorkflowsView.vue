<script setup lang="ts">
import { Button, cmp, ConfirmDialog, Icon, InfoHint, Page, PageAction, PageHeader, RowGroup, timeAgo } from "@intentic/extension-ui";
import type { Workflow, WorkflowRun, WorkflowSummary } from "@intentic/sandbox-contract";
import { computed, ref, shallowRef } from "vue";
import WorkflowDesigner from "./WorkflowDesigner.vue";
import WorkflowRunPanel from "./WorkflowRunPanel.vue";
import { WORKFLOW_TEMPLATES, type WorkflowTemplate } from "./templates";
import { useWorkflows } from "./useWorkflows";

/* WORKFLOWS: designed graphs of agent sessions, each producing a declared output.
 *
 * The third driver, and the page says which by what it does NOT have. An automation has an enabled switch,
 * because something fires it. A loop has no page at all, because it is started against a conversation and then
 * it is history. A workflow has neither: it is a DESIGN you keep, edit and run — so this page is a list of
 * designs with a Run button, and everything about watching one lives behind that button.
 *
 * THE TEMPLATE GALLERY IS UNDER THE LIST, not in the create dialog, and that is the one deliberate difference
 * from the automations page. Automation recipes are prefill for a form whose shape you already understand;
 * workflow templates are the only way most people will learn what shapes are POSSIBLE — that a reviewer should
 * be a different session, that a step can be made to produce data the next one consumes. So they stay visible
 * on the page rather than hiding one level in, and each card sells its SHAPE rather than its topic.
 */

const { workflows, runs, error: listError, remove, start } = useWorkflows();

// shallowRef, not ref: this holds a document that is only ever read and handed to the designer, which takes
// its own copy. Deep reactivity would buy nothing and would wrap it in a proxy on the way out — see
// workflowDraft.ts for what that used to cost.
const designing = shallowRef<Workflow | undefined>();
const designerOpen = ref(false);
const watchingId = ref<string | undefined>();
const confirmRemoveId = ref<string | undefined>();
const actionError = ref<string | undefined>();

const topError = computed(() => actionError.value ?? listError.value);
const watching = computed(() => runs.value.find((run) => run.runId === watchingId.value));
const live = computed(() => runs.value.filter((run) => run.state === `running`));
const past = computed(() => runs.value.filter((run) => run.state !== `running`).slice(0, 12));
// A template already saved under its own id is not offered again — the gallery is for shapes you do not have.
const available = computed(() => WORKFLOW_TEMPLATES.filter((template) => !workflows.value.some((workflow) => workflow.id === template.workflow.id)));

const design = (workflow: Workflow): void => {
    designing.value = workflow;
    designerOpen.value = true;
};

// A template opens the designer PREFILLED rather than creating the workflow: a graph that costs money to run
// is not something to create by accident, and looking at the picture before saving is the whole point.
// Handed over uncloned — the designer copies whatever it is given, so the module constant is only ever read.
const fromTemplate = (template: WorkflowTemplate): void => design(template.workflow);

const blank = (): void =>
    design({
        id: `workflow-${workflows.value.length + 1}`,
        name: `New workflow`,
        steps: [
            {
                id: `step-1`,
                title: `First step`,
                goal: ``,
                prompt: ``,
                needs: [],
                handoff: `fresh`,
                output: { kind: `claim` },
                checks: [],
                context: `fresh`,
                maxIterations: 8,
                stallLimit: 2,
                maxSpendUsd: 5,
            },
        ],
        isolated: true,
        maxParallel: 2,
        maxSpendUsd: 15,
    });

/* Starting a run opens the run panel on the record the daemon just acked. That record is already a complete
 * graph — every step written down as `pending` — so the panel opens on the shape rather than on a spinner,
 * which is what makes "did it start?" answerable at a glance. */
const runNow = async (workflow: WorkflowSummary): Promise<void> => {
    actionError.value = undefined;
    try {
        const run = await start.mutateAsync(workflow.id);
        watchingId.value = run.runId;
    } catch (error) {
        actionError.value = error instanceof Error ? error.message : `The workflow could not be started.`;
    }
};

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
    return roots > 1 || widest > 1 ? `${workflow.steps.length} steps, branching` : `${workflow.steps.length} steps in a line`;
};
</script>

<template>
    <Page width="wide">
        <PageHeader title="Workflows" description="A designed run of agent sessions, each one handing a declared result to the next.">
            <template #info>
                <InfoHint label="How a workflow runs">
                    <span class="block text-sm font-medium text-content">Every step is a loop</span>
                    <span class="mt-1 block text-xs text-muted">
                        A step repeats until it meets its goal — its own iteration, spend and idle-round ceilings apply, exactly as a Ralph loop's do.
                        When it is done, whatever it declared as output is handed to the steps that wait on it.
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
                        @click="watchingId = run.runId"
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
                    <span v-if="workflow.isolated" class="shrink-0 text-2xs text-subtle">· on branches</span>
                    <span v-if="workflow.description" class="min-w-0 flex-1 truncate text-2xs text-subtle">{{ workflow.description }}</span>
                    <span v-else class="flex-1"></span>
                    <!-- The last run, as a state word and nothing else. The row is a design, not a run; clicking
                         through is how you read one. -->
                    <button
                        v-if="workflow.runs[0]"
                        type="button"
                        class="shrink-0 cursor-pointer text-2xs hover:underline"
                        :class="RUN_TONE[workflow.runs[0].state]"
                        @click="watchingId = workflow.runs[0].runId"
                    >
                        {{ workflow.runs[0].state }} {{ timeAgo(workflow.runs[0].startedAt) }}
                    </button>
                    <Button label="Run" size="small" :disabled="start.isPending.value" @click="runNow(workflow)">
                        <template #icon><Icon name="play" /></template>
                    </Button>
                    <button type="button" :class="cmp.iconButton()" aria-label="Edit" @click="design(workflow)"><Icon name="pencil" /></button>
                    <button type="button" :class="cmp.iconButton('text-danger')" aria-label="Delete" @click="confirmRemoveId = workflow.id">
                        <Icon name="trash" />
                    </button>
                </div>
            </RowGroup>

            <div v-else :class="cmp.emptyState('py-5')">No workflows yet — start from one of the shapes below.</div>

            <!-- The gallery. Each card sells a SHAPE, because the shapes are the part nobody invents unprompted. -->
            <section v-if="available.length > 0">
                <div class="mb-2 flex items-center gap-2 px-0.5">
                    <span :class="cmp.sectionLabel()">Start from</span>
                    <span class="text-2xs text-subtle"
                        >Opens the designer with a real workflow in it — nothing runs until you save and press Run.</span
                    >
                </div>
                <div class="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
                    <button
                        v-for="template in available"
                        :key="template.workflow.id"
                        type="button"
                        class="flex cursor-pointer flex-col gap-1 rounded-lg border border-line bg-card p-3 text-left hover:border-line-strong"
                        @click="fromTemplate(template)"
                    >
                        <span class="flex items-center gap-2">
                            <Icon :name="template.icon" class="shrink-0 text-xs text-subtle" />
                            <span class="text-xs font-medium text-content">{{ template.workflow.name }}</span>
                            <span class="ml-auto shrink-0 text-2xs text-subtle">{{ shapeOf(template.workflow) }}</span>
                        </span>
                        <span class="text-2xs leading-snug text-subtle">{{ template.summary }}</span>
                    </button>
                </div>
            </section>

            <RowGroup v-if="past.length > 0" label="Earlier runs" :count="past.length">
                <button
                    v-for="run in past"
                    :key="run.runId"
                    type="button"
                    class="flex w-full cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left hover:bg-canvas"
                    @click="watchingId = run.runId"
                >
                    <span class="shrink-0 truncate text-xs text-content">{{ run.workflow.name }}</span>
                    <span class="shrink-0 text-2xs font-medium" :class="RUN_TONE[run.state]">{{ run.state }}</span>
                    <span class="min-w-0 flex-1 truncate text-2xs text-subtle">{{ runLine(run) }}</span>
                    <Icon name="chevron-right" class="shrink-0 text-2xs text-subtle" />
                </button>
            </RowGroup>
        </div>

        <WorkflowDesigner v-if="designing" v-model="designerOpen" :initial="designing" />
        <WorkflowRunPanel
            v-if="watching"
            :key="watching.runId"
            :model-value="watchingId !== undefined"
            :run="watching"
            @update:model-value="watchingId = undefined"
        />
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
