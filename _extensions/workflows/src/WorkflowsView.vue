<script setup lang="ts">
import {
    AnchoredOverlay,
    Button,
    Card,
    ui,
    ConfirmDialog,
    Icon,
    Notice,
    noticeOf,
    Page,
    PageAction,
    PageHeader,
    Row,
    RowGroup,
    StatusBadge,
    timeAgo,
    useLoadingReveal,
    type StatusVariant,
} from "@intentic/extension-ui";
import { type LoopDesign, loopDesignLine, type Workflow, type WorkflowRun, type WorkflowSummary } from "@intentic/sandbox-contract";
import { computed, ref, shallowRef, watch } from "vue";
import GateAccess from "./GateAccess.vue";
import LoopForm from "./LoopForm.vue";
import WorkflowCard from "./WorkflowCard.vue";
import WorkflowDesigner from "./WorkflowDesigner.vue";
import WorkflowRunPage from "./WorkflowRunPage.vue";
import { host } from "./host";
import { WORKFLOW_TEMPLATES, type WorkflowTemplate } from "./templates";
import { STEP_TONE } from "./workflowDag";
import { loopIdFrom, useLoopDesigns } from "./useLoopDesigns";
import { useWorkflows } from "./useWorkflows";

// Workflows (a graph of sessions, each with a declared output) and loops (one session repeated until a stated bar
// clears) are the same kind of design, authored once and handed a job later; unlike an automation, nothing here fires
// on its own. Shown as cards, not rows, since a workflow's identity is its shape, and templates stay visible under the
// list as the same dashed card.

const { workflows, isLoading, runs, runsLoaded, error: listError, remove } = useWorkflows();
// Skeleton only appears once the wait has earned it (useLoadingReveal's thresholds).
const outline = useLoadingReveal(
    isLoading,
    computed(() => `workflows`),
);
// The page's second kind of design, alongside workflows.
const { loops, error: loopsError, save: saveLoop, remove: removeLoop } = useLoopDesigns();

// Screen is read from the URL query, not a ref: `?edit=<id>` opens the designer, `?run=<runId>` a run, giving Back,
// reload, and a linkable address for free. `?edit=new` names an unsaved draft with no address, held in a `shallowRef`
// so the designer's own copy isn't proxy-wrapped.
const query = computed(() => host().route.query());
const editing = computed(() => query.value[`edit`]);
const watchingId = computed(() => query.value[`run`]);
const drafted = shallowRef<Workflow | undefined>();

const confirmRemoveId = ref<string | undefined>();
const actionError = ref<string | undefined>();

const topError = computed(() => actionError.value ?? listError.value ?? loopsError.value);
const watching = computed(() => runs.value.find((run) => run.runId === watchingId.value));
// True when `?run=` outlives the ledger's last-50 window, gated on the ledger having actually loaded.
const lostRunId = computed(() => (watchingId.value !== undefined && watching.value === undefined && runsLoaded.value ? watchingId.value : undefined));
// Falls back to the draft by id even once saved, so the designer doesn't flicker to the list for the one refetch
// between the save resolving and the list query invalidating. Scoped by id, not a general fallback, so a deleted
// `?edit=<id>` can't reopen a stale draft.
const designing = computed<Workflow | undefined>(() => {
    if (editing.value === undefined) {
        return undefined;
    }
    const saved = workflows.value.find((workflow) => workflow.id === editing.value);
    return saved ?? (editing.value === `new` || drafted.value?.id === editing.value ? drafted.value : undefined);
});
const live = computed(() => runs.value.filter((run) => run.state === `running`));
const past = computed(() => runs.value.filter((run) => run.state !== `running`).slice(0, 12));
// True even for a template already saved under its own id: a saved copy is a fork that may have drifted, and picking it
// only opens the designer prefilled.
const savedAlready = (template: WorkflowTemplate): boolean => workflows.value.some((workflow) => workflow.id === template.workflow.id);

// A saved workflow opens by id; an unsaved one is parked in `drafted` first and opens as `new`.
const openSaved = (id: string): void => host().route.setQuery({ edit: id, run: undefined }, { push: true });
const openDraft = (workflow: Workflow): void => {
    drafted.value = workflow;
    host().route.setQuery({ edit: `new`, run: undefined }, { push: true });
};
const mintWorkflowId = (): string => `workflow-${crypto.randomUUID()}`;
const watchRun = (runId: string): void => host().route.setQuery({ run: runId, edit: undefined }, { push: true });
const backToList = (): void => host().route.setQuery({ edit: undefined, run: undefined });

// Opens the designer prefilled rather than creating the workflow outright. Handed over uncloned; the designer copies
// it, so the template constant is only ever read.
const fromTemplate = (template: WorkflowTemplate): void => openDraft({ ...template.workflow, id: mintWorkflowId() });

const blank = (): void =>
    openDraft({
        id: mintWorkflowId(),
        name: `New workflow`,
        // No goal or prompt, so a blank workflow is runnable the moment it's named.
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

// Opens a composer session with this design badged, rather than starting the run itself; nothing is spent until the
// user sends.
const runNow = (workflow: WorkflowSummary): void => host().chat.composeWorkflow(workflow.id);

// Gate badge's panel: the webhook URL and CI step, shown on the card via one overlay anchored to whichever badge was
// pressed.
const gateShown = ref<{ workflow: WorkflowSummary; anchor: HTMLElement }>();
const gateOpen = computed({
    get: () => gateShown.value !== undefined,
    set: (open: boolean) => {
        if (!open) {
            gateShown.value = undefined;
        }
    },
});
const showGate = (workflow: WorkflowSummary, event: MouseEvent): void => {
    gateShown.value = { workflow, anchor: event.currentTarget as HTMLElement };
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

// Saved loops: a deliberate neighbor to workflows, not a page of its own, since both are designs picked from the
// composer's badge row. The loop form lives here as a page rather than a composer dialog, so it no longer interrupts a
// message in progress.
const loopEditing = ref<LoopDesign | undefined>();
const loopFormOpen = ref(false);
const confirmRemoveLoopId = ref<string | undefined>();

// `?loop=new` opens the form on arrival; the query is cleared immediately so a reload doesn't reopen a closed dialog.
watch(
    () => query.value[`loop`],
    (want) => {
        if (want === undefined) {
            return;
        }
        if (want === `new`) {
            loopEditing.value = undefined;
            loopFormOpen.value = true;
        }
        host().route.setQuery({ loop: undefined });
    },
    { immediate: true },
);

const newLoop = (): void => {
    loopEditing.value = undefined;
    loopFormOpen.value = true;
};
const editLoop = (design: LoopDesign): void => {
    loopEditing.value = design;
    loopFormOpen.value = true;
};

const persistLoop = async (fields: Omit<LoopDesign, "id">): Promise<void> => {
    actionError.value = undefined;
    const existing = loopEditing.value;
    try {
        // Keeps the existing id on rename, so a composer badge pointing at this loop isn't orphaned.
        const design: LoopDesign = { ...fields, id: existing?.id ?? loopIdFrom(fields.name, loops.value) };
        await saveLoop.mutateAsync({ design, create: existing === undefined });
        loopFormOpen.value = false;
    } catch (error) {
        actionError.value = error instanceof Error ? error.message : `The loop could not be saved.`;
    }
};

const deleteLoop = async (): Promise<void> => {
    const id = confirmRemoveLoopId.value;
    if (id === undefined) {
        return;
    }
    actionError.value = undefined;
    try {
        await removeLoop.mutateAsync(id);
        confirmRemoveLoopId.value = undefined;
    } catch (error) {
        actionError.value = error instanceof Error ? error.message : `The loop could not be removed.`;
    }
};

// Same handover as a workflow's Run: opens the composer badged with this loop, nothing spent until send.
const loopNow = (design: LoopDesign): void => host().chat.composeLoop(design.id);

const doneSteps = (run: WorkflowRun): number => run.steps.filter((step) => step.state === `done`).length;
const spentOn = (run: WorkflowRun): number => run.steps.reduce((total, step) => total + (step.costUsd ?? 0), 0);

// Progress and cost, the two questions about a run you weren't watching; when it ran gets its own column instead.
const runLine = (run: WorkflowRun): string =>
    [`${doneSteps(run)}/${run.steps.length} steps`, spentOn(run) > 0 ? `$${spentOn(run).toFixed(2)}` : ``].filter((part) => part !== ``).join(` · `);

// `stopped` isn't an error color, the user chose it; `running` gets the brand tint, not a status color.
const RUN_VARIANT: Record<WorkflowRun["state"], StatusVariant> = {
    running: `primary`,
    done: `success`,
    failed: `danger`,
    stopped: `neutral`,
    overspent: `warning`,
    error: `danger`,
};
</script>

<template>
    <!-- Switches on the query rather than layering modals, since the designer and a run each need the whole page; `h-full` since neither scrolls. -->
    <!--
        Closes to the list on save rather than navigating `?edit=new` to `?edit=<id>`, which would remount the designer (`editing` is its `:key`) as
        a visible flicker.
    -->
    <WorkflowDesigner
        v-if="designing"
        :key="editing"
        :initial="designing"
        :creating="editing === `new`"
        @close="backToList()"
        @saved="backToList()"
    />
    <WorkflowRunPage v-else-if="watching" :key="watching.runId" :run="watching" @close="backToList()" />

    <Page v-else width="wide">
        <PageHeader title="Workflows">
            <template #actions>
                <!-- Loop is the secondary action, not lesser: most people come here for a workflow first. -->
                <PageAction icon="repeat" label="New loop" @click="newLoop()" />
                <PageAction icon="plus" label="New workflow" primary @click="blank()" />
            </template>
        </PageHeader>

        <Notice v-if="topError" :of="noticeOf(topError)" class="mb-4" />

        <!-- Link to a run that rolled off the ledger; not an error, just a fact, so the page stays usable underneath. -->
        <Notice v-if="lostRunId !== undefined" tone="info" class="mb-4">
            Run <span class="font-mono">{{ lostRunId }}</span> is no longer on the record: the ledger keeps the last 50 runs.
        </Notice>

        <div class="flex flex-col gap-6">
            <!-- Live runs sit above saved designs. A progress bar, not a sentence, per-step and tinted by the same table the canvas uses. -->
            <section v-if="live.length > 0">
                <div class="mb-2 flex items-center gap-2 px-0.5">
                    <Icon name="spinner" spin class="text-2xs text-link" />
                    <span :class="ui.sectionLabel('text-link')">Running now</span>
                </div>
                <div class="flex flex-col gap-2">
                    <button
                        v-for="run in live"
                        :key="run.runId"
                        type="button"
                        class="ui-row-select flex w-full flex-col gap-2 rounded-lg border border-link/40 bg-card px-3 py-2.5 text-left"
                        @click="watchRun(run.runId)"
                    >
                        <span class="flex w-full items-center gap-2">
                            <span class="min-w-0 truncate text-sm font-medium text-content">{{ run.workflow.name }}</span>
                            <span class="ml-auto shrink-0 text-2xs tabular-nums text-subtle">{{ runLine(run) }} · {{ timeAgo(run.startedAt) }}</span>
                            <Icon name="chevron-right" class="shrink-0 text-2xs text-subtle" />
                        </span>
                        <span class="flex w-full gap-0.5">
                            <span
                                v-for="step in run.steps"
                                :key="step.stepId"
                                class="h-1 flex-1 rounded-full"
                                :class="STEP_TONE[step.state].bar"
                            ></span>
                        </span>
                        <!-- What this run was asked to do; the only thing distinguishing two runs of the same design. -->
                        <span v-if="run.request" class="w-full truncate text-2xs text-muted">{{ run.request }}</span>
                    </button>
                </div>
            </section>

            <!-- Skeleton matches the real card's height (mostly the diagram frame), so nothing jumps down the page once it lands. -->
            <section v-if="isLoading && outline" role="status" aria-busy="true">
                <span class="sr-only">Reading your workflows…</span>
                <div class="mb-2 flex items-center gap-2 px-0.5" aria-hidden="true">
                    <span class="skeleton block h-2.5 w-24" />
                </div>
                <div class="flex flex-col gap-3" aria-hidden="true">
                    <Card v-for="card in 2" :key="card" class="flex flex-col gap-3">
                        <div class="flex items-start justify-between gap-3">
                            <div class="flex min-w-0 flex-col gap-1.5">
                                <span class="skeleton block h-3.5" :class="card === 1 ? `w-44` : `w-32`" />
                                <span class="skeleton block h-2.5" :class="card === 1 ? `w-64` : `w-52`" />
                            </div>
                            <span class="skeleton block h-6 w-16 shrink-0" />
                        </div>
                        <!--
                            Keeps the frame's own wash instead of filling it with skeleton; `h-36` matches WorkflowCard's frame height for a two-node
                            graph, and must stay on the surface's allowed scale.
                        -->
                        <div class="flex h-36 w-full flex-col items-center justify-center gap-3 rounded-lg bg-content/4">
                            <span v-for="node in 2" :key="node" class="skeleton block h-14 w-52 rounded-md" />
                        </div>
                    </Card>
                </div>
            </section>

            <section v-else-if="!isLoading && workflows.length > 0">
                <div class="mb-2 flex items-center gap-2 px-0.5">
                    <span :class="ui.sectionLabel()">Your workflows</span>
                    <span class="text-2xs font-medium text-subtle">{{ workflows.length }}</span>
                </div>
                <div class="flex flex-col gap-3">
                    <WorkflowCard
                        v-for="workflow in workflows"
                        :key="workflow.id"
                        :workflow="workflow"
                        :description="workflow.description"
                        @open="openSaved(workflow.id)"
                    >
                        <!-- Opens the webhook URL and CI step, otherwise only visible inside the designer. -->
                        <template v-if="workflow.gate" #badges>
                            <button
                                type="button"
                                class="cursor-pointer"
                                :aria-label="`CI wiring for ${workflow.name}`"
                                v-tooltip.top="`A pipeline can run this: the webhook URL and a paste-ready CI step`"
                                @click="showGate(workflow, $event)"
                            >
                                <StatusBadge variant="primary" size="xs">
                                    <Icon name="shield" class="text-2xs" />
                                    CI gate
                                </StatusBadge>
                            </button>
                        </template>
                        <!-- Run always shows; edit and delete appear on hover only, staying put below `md` where there's no hover. -->
                        <template #actions>
                            <Button
                                label="Run"
                                size="small"
                                v-tooltip.top="`Opens a session with this design picked: nothing runs until you send`"
                                @click="runNow(workflow)"
                            >
                                <template #icon><Icon name="play" /></template>
                            </Button>
                            <button
                                type="button"
                                :class="ui.iconButton('md:opacity-0 md:group-hover/card:opacity-100 md:focus-visible:opacity-100')"
                                :aria-label="`Edit ${workflow.name}`"
                                v-tooltip.top="`Edit`"
                                @click="openSaved(workflow.id)"
                            >
                                <Icon name="pencil" />
                            </button>
                            <button
                                type="button"
                                :class="ui.iconButton('hover:text-danger md:opacity-0 md:group-hover/card:opacity-100 md:focus-visible:opacity-100')"
                                :aria-label="`Delete ${workflow.name}`"
                                v-tooltip.top="`Delete`"
                                @click="confirmRemoveId = workflow.id"
                            >
                                <Icon name="trash" />
                            </button>
                        </template>
                        <!-- Last run as a fact in the meta line, not a fourth control competing with Run. -->
                        <template #meta>
                            <button
                                v-if="workflow.runs[0]"
                                type="button"
                                class="flex cursor-pointer items-center gap-1.5 hover:underline"
                                @click="watchRun(workflow.runs[0].runId)"
                            >
                                <span>Last run</span>
                                <StatusBadge :variant="RUN_VARIANT[workflow.runs[0].state]" size="xs" :label="workflow.runs[0].state" />
                                <span>{{ timeAgo(workflow.runs[0].startedAt) }}</span>
                            </button>
                            <span v-else>Never run</span>
                        </template>
                    </WorkflowCard>
                </div>
            </section>

            <!-- Rows, not cards: a loop has no shape to draw, just three facts on a line (what ends it, how far, what it's for). -->
            <RowGroup
                v-if="loops.length > 0"
                label="Your loops"
                :count="loops.length"
                caption="Pick one in a chat: what you type there is what it works towards."
            >
                <Row v-for="design in loops" :key="design.id" icon="repeat" density="compact" class="group/item">
                    <template #title>{{ design.name }}</template>
                    <template #description>
                        Ends on {{ loopDesignLine(design) }}{{ design.context === `continue` ? ` · keeps context` : `` }}
                        <span v-if="design.description">: {{ design.description }}</span>
                    </template>
                    <!-- Use is the loud control, like Run on a workflow card; edit and delete appear on hover only. -->
                    <template #control>
                        <Button
                            label="Use"
                            size="small"
                            severity="secondary"
                            v-tooltip.top="`Opens a chat with this loop picked: nothing runs until you send`"
                            @click="loopNow(design)"
                        >
                            <template #icon><Icon name="play" /></template>
                        </Button>
                        <button
                            type="button"
                            :class="ui.iconButton('md:opacity-0 md:group-hover/item:opacity-100 md:focus-visible:opacity-100')"
                            :aria-label="`Edit ${design.name}`"
                            v-tooltip.top="`Edit`"
                            @click="editLoop(design)"
                        >
                            <Icon name="pencil" />
                        </button>
                        <button
                            type="button"
                            :class="ui.iconButton('hover:text-danger md:opacity-0 md:group-hover/item:opacity-100 md:focus-visible:opacity-100')"
                            :aria-label="`Delete ${design.name}`"
                            v-tooltip.top="`Delete`"
                            @click="confirmRemoveLoopId = design.id"
                        >
                            <Icon name="trash" />
                        </button>
                    </template>
                </Row>
            </RowGroup>

            <!--
                Same dashed card as a saved workflow, not a bare box, so it reads as one of those, ready-made. Stacked, not gridded: the two
                templates differ in machinery, best read down a row rather than spotted in thumbnails.
            -->
            <section>
                <div class="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1 px-0.5">
                    <span :class="ui.sectionLabel()">Start from a template</span>
                    <!-- Avoids claiming an empty library while the read is still in flight; `[]` looks the same either way. -->
                    <span class="min-w-0 text-2xs text-subtle">
                        {{
                            workflows.length > 0 || isLoading
                                ? `A ready-made design, opened in the designer: nothing is saved or spent until you say so.`
                                : `Nothing saved yet. Open a ready-made design and edit it, nothing is saved or spent until you say so.`
                        }}
                    </span>
                    <button type="button" :class="ui.linkButton('ml-auto text-2xs text-muted hover:text-content')" @click="blank()">
                        or start from blank
                    </button>
                </div>
                <div class="flex flex-col gap-3">
                    <WorkflowCard
                        v-for="template in WORKFLOW_TEMPLATES"
                        :key="template.workflow.id"
                        :workflow="template.workflow"
                        :description="template.summary"
                        dashed
                        @open="fromTemplate(template)"
                    >
                        <template #badges>
                            <StatusBadge variant="neutral" size="xs">
                                <Icon :name="template.icon" class="text-2xs" />
                                Template
                            </StatusBadge>
                        </template>
                        <template #actions>
                            <Button label="Use this template" size="small" severity="secondary" @click="fromTemplate(template)">
                                <template #icon><Icon name="plus" /></template>
                            </Button>
                        </template>
                        <!-- Said plainly: this looks like adding new but really re-forks an existing copy. -->
                        <template v-if="savedAlready(template)" #meta>
                            <span class="text-warning">You have a copy: saving from here replaces it.</span>
                        </template>
                    </WorkflowCard>
                </div>
            </section>

            <RowGroup v-if="past.length > 0" label="Earlier runs" :count="past.length">
                <button
                    v-for="run in past"
                    :key="run.runId"
                    type="button"
                    class="ui-row-select flex w-full items-center gap-2 px-2.5 py-1.5 text-left"
                    @click="watchRun(run.runId)"
                >
                    <StatusBadge :variant="RUN_VARIANT[run.state]" size="xs" :label="run.state" class="w-20 shrink-0 justify-center" />
                    <span class="shrink-0 truncate text-xs text-content">{{ run.workflow.name }}</span>
                    <!-- What it was asked to do, the only thing telling two runs of one design apart. -->
                    <span v-if="run.request" class="min-w-0 flex-1 truncate text-2xs text-muted">{{ run.request }}</span>
                    <span v-else class="flex-1"></span>
                    <span class="shrink-0 text-2xs tabular-nums text-subtle">{{ runLine(run) }}</span>
                    <span class="w-16 shrink-0 text-right text-2xs tabular-nums text-subtle">{{ timeAgo(run.startedAt) }}</span>
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
            <p class="text-sm text-subtle">Its run history stays: every run kept its own copy of the design. A run already going is not stopped.</p>
        </ConfirmDialog>

        <ConfirmDialog
            :open="confirmRemoveLoopId !== undefined"
            header="Delete this loop?"
            confirm-label="Delete"
            confirm-icon="trash"
            :loading="removeLoop.isPending.value"
            @confirm="deleteLoop()"
            @cancel="confirmRemoveLoopId = undefined"
        >
            <p class="text-sm text-subtle">A loop already running from it keeps going: it copied what it needed when it started.</p>
        </ConfirmDialog>

        <LoopForm
            v-model="loopFormOpen"
            :editing="loopEditing"
            :taken="loops.filter((design) => design.id !== loopEditing?.id).map((design) => design.name)"
            @save="persistLoop($event)"
        />

        <!-- Same `<GateAccess>` the designer shows, so the two copies of the webhook string can't disagree. -->
        <AnchoredOverlay v-model="gateOpen" :anchor="gateShown?.anchor" side="bottom" cross="start">
            <div class="w-pop p-3">
                <GateAccess v-if="gateShown" :workflow="gateShown.workflow" />
            </div>
        </AnchoredOverlay>
    </Page>
</template>
