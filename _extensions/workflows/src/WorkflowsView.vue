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

/* WORKFLOWS AND LOOPS: the two shapes you keep and point at a job.
 *
 * A workflow is a designed graph of agent sessions, each producing a declared output. A loop is one session
 * repeated until a bar you can state is cleared. They share this page because they are the same KIND of thing
 *: a design you author once, pick from a composer, and hand today's sentence to, and differ only in their
 * answer: a workflow spreads the message across sessions that are not this one, a loop repeats it in one.
 *
 * The page says what neither of them is by what it does NOT have. An automation has an enabled switch, because
 * something fires it. Nothing here fires on its own: a design runs when somebody says run it.
 *
 * A LOOP DID NOT USED TO HAVE A PAGE, and the sentence that justified that was "it is started against a
 * conversation and then it is history": true of a RUNNING loop and false of the thing a person actually
 * wanted to keep. Every loop was configured from scratch, in a modal over the composer, whose first field
 * asked for a goal already typed in the box behind it. What is saved here is the machinery without the goal;
 * the goal stays where it always was, in the message.
 *
 * A GALLERY OF CARDS RATHER THAN A LIST OF ROWS, which is the one place this page departs from every other
 * list in the product. A row is right for a thing whose identity is its NAME and whose interest is its STATE:
 * an automation, a secret, a file. A workflow's identity is its shape, and a shape needs two dimensions: the
 * row this replaced spent its width on a name, a shape described in three words, a description truncated to
 * whatever was left, a status and three controls, all on one line and all in the same grey. Nothing on it was
 * legible except the buttons. The card gives the graph a picture, the description two lines, and the controls
 * one loud one (Run) with the rest under the pointer.
 *
 * THE TEMPLATE IS UNDER THE LIST, not in the create dialog, and that is the one deliberate difference from the
 * automations page. Automation recipes are prefill for a form whose shape you already understand; a workflow
 * template is the only way most people will learn what shapes are POSSIBLE: that a reviewer should be a
 * different session, that two steps can run on two different models, that a step can be made to produce data
 * the next one consumes. So it stays visible on the page rather than hiding one level in, and it is drawn as
 * the SAME card as a saved workflow, dashed, because "one of those, ready-made" is the whole proposition and
 * the old bare-bordered box under a bare "Start from" label said none of it.
 */

const { workflows, isLoading, runs, runsLoaded, error: listError, remove } = useWorkflows();
// Only drawn once the wait has earned it: see useLoadingReveal for the two thresholds.
const outline = useLoadingReveal(
    isLoading,
    computed(() => `workflows`),
);
// The page's second kind of design: see the saved-loops block below for what one is and why it lives here.
const { loops, error: loopsError, save: saveLoop, remove: removeLoop } = useLoopDesigns();

/* WHICH OF THE THREE SCREENS THIS IS, and it is read from the URL rather than held in a ref.
 *
 * `?edit=<id>` is the designer, `?run=<runId>` is a run, neither is the list. The query is an extension view's
 * whole route space (IntenticApi.route), so this buys Back, reload and a linkable address for free, and it is
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

const topError = computed(() => actionError.value ?? listError.value ?? loopsError.value);
const watching = computed(() => runs.value.find((run) => run.runId === watchingId.value));
/* `?run=` naming a run the ledger no longer holds. Reachable rather than theoretical: the workflow mark on a
 * fleet card is never cleared (which run a conversation came out of is what its card is read for a week later),
 * while the ledger keeps only the last 50 runs, so the card outlives the record it links to. Falling through
 * to the list silently reads as the link having done nothing, which is the one thing it must not look like.
 * Gated on the ledger having actually been READ, so a slow first load cannot accuse a good link. */
const lostRunId = computed(() => (watchingId.value !== undefined && watching.value === undefined && runsLoaded.value ? watchingId.value : undefined));
/* The workflow the designer is on: a saved one by id, or the draft that `?edit=new` stands for.
 *
 * The draft ALSO answers for its own id once it has been saved, and that is not belt-and-braces: it closes a
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
/* THE GALLERY OFFERS EVERY TEMPLATE, INCLUDING ONE ALREADY SAVED under its own id, which it used to hide, on
 * the reasoning that the gallery is for shapes you do not have.
 *
 * That reasoning had a hole, and it is the one people fall down: a template is PREFILL, so a saved copy is a
 * fork taken at the moment it was picked. When the template moves on: a step removed, a prompt rewritten:
 * the saved workflow does not, and hiding the card left no way to take the new version short of deleting the
 * old one first. Somebody watching the template change and their own run not change has no way to connect the
 * two. Picking it still costs nothing: it opens the DESIGNER prefilled, and nothing is written until Save.
 */
const savedAlready = (template: WorkflowTemplate): boolean => workflows.value.some((workflow) => workflow.id === template.workflow.id);

// A saved workflow opens by id; anything unsaved is parked in `drafted` first and opens as `new`.
const openSaved = (id: string): void => host().route.setQuery({ edit: id, run: undefined }, { push: true });
const openDraft = (workflow: Workflow): void => {
    drafted.value = workflow;
    host().route.setQuery({ edit: `new`, run: undefined }, { push: true });
};
const mintWorkflowId = (): string => `workflow-${crypto.randomUUID()}`;
const watchRun = (runId: string): void => host().route.setQuery({ run: runId, edit: undefined }, { push: true });
const backToList = (): void => host().route.setQuery({ edit: undefined, run: undefined });

// A template opens the designer PREFILLED rather than creating the workflow: a graph that costs money to run
// is not something to create by accident, and looking at the picture before saving is the whole point.
// Handed over uncloned: the designer copies whatever it is given, so the module constant is only ever read.
const fromTemplate = (template: WorkflowTemplate): void => openDraft({ ...template.workflow, id: mintWorkflowId() });

const blank = (): void =>
    openDraft({
        id: mintWorkflowId(),
        name: `New workflow`,
        // No goal and no prompt: the step does whatever the run is asked to do and is measured against it. A
        // blank workflow is therefore RUNNABLE the moment it is named, which is the point: the author adds
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
 * named on the composer's workflow badge, and that is where the run begins, when the user types what they
 * want and presses send.
 *
 * It used to start the run here, behind a dialog with its own prompt box, and that was two ways to begin agent
 * work: the one everybody knows (a composer) and this one, which looked like nothing else in the product and
 * put a text box inside a modal on a list page. Starting a workflow is starting agent work; the difference is
 * only that the message fans out. So the composer is the place, and this button's job is to get you there
 * with the design already picked. Nothing is spent until the send.
 */
const runNow = (workflow: WorkflowSummary): void => host().chat.composeWorkflow(workflow.id);

/* THE GATE BADGE'S PANEL: the URL and the paste-ready CI step, on the card, because the card is where the
 * owner is standing months after the save that minted them (the automations row keeps its webhook on the row
 * for the same reason). One overlay for the whole list, anchored to whichever badge was pressed. */
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

/* --- SAVED LOOPS -------------------------------------------------------------------------------------
 * The page's second kind of design, and a deliberate neighbour rather than a page of its own. A loop and a
 * workflow are one question with two answers: what is the next message run THROUGH, and everything about how
 * they are used is shared: authored here, picked from the composer's badge row, pointed at whatever you type.
 *
 * THE FORM IS A DIALOG HERE AND WAS ONE ON THE COMPOSER, which sounds like the same thing moved sideways and is
 * not. On a composer it interrupted a sentence somebody was in the middle of writing, opened in the app window
 * while the chat was popped out into another, and asked for a goal that was already typed behind it. On a page
 * it interrupts nothing, and every question in it is about the loop rather than about today's job.
 */
const loopEditing = ref<LoopDesign | undefined>();
const loopFormOpen = ref(false);
const confirmRemoveLoopId = ref<string | undefined>();

/* `?loop=new` from the composer's empty picker opens the form on arrival, `?loop=list` just lands here. That is
 * the whole of this view's loop route space: a saved loop has no canvas and no run of its own to link to, so
 * unlike a workflow it needs no screen: only this page, and a form over it. The query is cleared as it is
 * consumed, so a reload does not reopen a dialog the user has closed. */
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
        // An edit keeps its id even when the name changes: a composer badge pointing at this loop must not be
        // orphaned by a rename, which is exactly the sort of breakage nobody connects back to the edit.
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

// Aim a fresh session at this loop, the same handover Run performs for a workflow: the composer opens with the
// loop on its badge and nothing is spent until the user types what they want done and presses send.
const loopNow = (design: LoopDesign): void => host().chat.composeLoop(design.id);

const doneSteps = (run: WorkflowRun): number => run.steps.filter((step) => step.state === `done`).length;
const spentOn = (run: WorkflowRun): number => run.steps.reduce((total, step) => total + (step.costUsd ?? 0), 0);

// A run's headline: how far it got, and what it cost. Both numbers, because "3 of 7" and "$4.10" answer the
// two different questions a person has about a run they were not watching. WHEN it ran is not in here: it gets
// a column of its own, because a date only scans when it lines up with the one above it.
const runLine = (run: WorkflowRun): string =>
    [`${doneSteps(run)}/${run.steps.length} steps`, spentOn(run) > 0 ? `$${spentOn(run).toFixed(2)}` : ``].filter((part) => part !== ``).join(` · `);

/* One vocabulary for run state, everywhere it is shown, and it is a <StatusBadge> rather than a tinted word.
 *
 * The word alone was doing two jobs it could not do at once: on a card it had to survive sitting between a
 * description and a Run button, and in the history it had to be scannable down a column. A pill is the app's
 * answer to both, and using it means "failed" reads the same here as it does on every other surface.
 *
 * `stopped` IS NOT AN ERROR COLOUR: the user did that on purpose (the same rule the graph's step tones keep).
 * `running` takes the brand tint rather than a status colour, because it is not an outcome, it is a live thing.
 */
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
    <!-- THREE SCREENS, ONE VIEW. The designer and a run each need the whole page (a graph does not fit in a
         dialog), and an extension's route space is the query, so this switches on it rather than layering
         modals over the list. `h-full` because both of those are canvas pages that must not scroll. -->
    <!-- SAVING GOES BACK TO THE LIST. It used to navigate `?edit=new` → `?edit=<id>`, which is the same
         screen at a different address, and since `editing` is this component's `:key`, the designer was torn
         down and rebuilt in place: a flicker, then the form you were already looking at. Nothing about the
         press was legible as having worked. A save is finishing with the document, so it closes it. -->
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
        <PageHeader
            title="Workflows"
            description="Shapes you point at a job: a run of agent sessions handing results down the line, or one session repeating until a bar is cleared."
        >
            <template #actions>
                <!-- Two kinds of design, two ways in. The loop is the secondary one because it is the smaller
                     idea, not the lesser one: a workflow is what most people come here for, and a loop is what
                     they reach for once they have a bar they can state. -->
                <PageAction icon="repeat" label="New loop" @click="newLoop()" />
                <PageAction icon="plus" label="New workflow" primary @click="blank()" />
            </template>
        </PageHeader>

        <Notice v-if="topError" :of="noticeOf(topError)" class="mb-4" />

        <!-- A link to a run that has rolled off the ledger. Not an error: nothing failed and nothing is wrong
             with the card that sent you here, so it states the fact and leaves the page usable beneath it. -->
        <Notice v-if="lostRunId !== undefined" tone="info" class="mb-4">
            Run <span class="font-mono">{{ lostRunId }}</span> is no longer on the record: the ledger keeps the last 50 runs.
        </Notice>

        <div class="flex flex-col gap-6">
            <!-- Runs in flight sit at the top, above the designs: while something is going, that is the page.
                 It carries a PROGRESS BAR rather than a sentence, because the question asked of a live run is
                 never "what is it" (the name answers that) it is "how far, and is it still moving". One
                 segment per step in the workflow's own order, tinted by the same table the graph uses, so the
                 strip here and the canvas behind it are the same reading at two sizes. -->
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
                        <!-- What this run was ASKED to do. The design is a shape; the sentence is the job, and it
                             is the only thing that tells two runs of the same workflow apart. -->
                        <span v-if="run.request" class="w-full truncate text-2xs text-muted">{{ run.request }}</span>
                    </button>
                </div>
            </section>

            <!-- The saved library, as the cards that are coming. A workflow card is a title, a two-line
                 description and a diagram frame, and the frame is most of its height, so an outline that drew
                 only the text would promise a card a third of the size of the one that lands, and the
                 templates below it would jump down the page as the real ones arrive. Two, because two is the
                 shortest library worth drawing and a reader with twenty is no worse served by seeing two. -->
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
                        <!-- THE FRAME IS THE FRAME, NOT A GREY SLAB. Filled edge to edge with a skeleton, the
                             picture area came out darker and heavier than the real one, so the outline read as
                             a card with a hole in it rather than a card about to hold a diagram. The frame
                             keeps its own wash (WorkflowCard draws the same one) and the bars go INSIDE it, at
                             a node's size, which is also the honest amount to promise: that a picture is
                             coming, not what it will be a picture of.

                             h-36 is 9rem, the frame's own height for the two-node graph most saved workflows
                             are, and on the scale rather than an arbitrary value because an extension may only
                             use classes the surface promises (see extensionSurface.test.ts). -->
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
                        <!-- The gate badge is a DOOR, not an ornament: it opens the URL and the CI step a
                             pipeline is wired with, which otherwise only exist inside the designer. -->
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
                        <!-- ONE LOUD CONTROL PER CARD. Run is what the page is for and is always there; edit and
                             delete come up under the pointer, because reading the gallery is the common act and
                             three buttons of equal weight is what made the old row unreadable. They stay put
                             below `md`, where there is no hover to reveal them. -->
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
                        <!-- The last run, as a FACT in the meta line rather than as a fourth control competing
                             with Run. The card is a design, not a run; clicking through is how you read one. -->
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

            <!-- SAVED LOOPS: rows, where a workflow gets a card, and the difference is honest rather than a
                 downgrade. A card exists to give a workflow's SHAPE two dimensions: that is what a graph needs
                 and what a row could never show. A loop has no shape: it is one session, repeated, and
                 everything worth knowing about it is three facts on a line: what ends it, how far it may go,
                 what it is for. That is a row, and pretending otherwise would be a picture of nothing. -->
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
                    <!-- Use is the loud one, for the reason Run is loud on a workflow card: reading this
                             list is the common act, and starting one is what the list is FOR. Edit and delete
                             come up under the pointer, and stay put below `md` where there is no hover. -->
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

            <!-- THE GALLERY, drawn as the same card as a saved workflow and dashed. That is the whole fix: the
                 old block was a bare box under the words "Start from", which named neither what it held nor what
                 pressing it would do, and it sat under a list whose items looked nothing like it, so there was
                 no reading in which the two were the same kind of thing.
                 Full width and stacked rather than a grid: there are two of these, they differ by how much
                 machinery they carry, and that is a difference you read along the row, not one you spot in a
                 column of thumbnails. The first is the plain one, and it is the one to click first. -->
            <section>
                <div class="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1 px-0.5">
                    <span :class="ui.sectionLabel()">Start from a template</span>
                    <!-- "Nothing saved yet" is a claim about the reader's own library, and an unread library
                         answers `[]` exactly like an empty one, so while the read is in flight the caption
                         says only the part that is true of every visit. -->
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
                        <!-- You already have one of these. Said plainly, because a card that looks like "add a
                             new thing" while it is really "take the current version of a thing you forked" is
                             the difference between a save you meant and one you did not. -->
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
                    <!-- What it was asked to do, which is the only thing telling two runs of one design apart:
                         and the first question anybody has of a row in a history. -->
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

        <!-- The gate badge's panel: the same <GateAccess> the designer shows, so the two copies of the one
             string a pipeline is taught cannot disagree. -->
        <AnchoredOverlay v-model="gateOpen" :anchor="gateShown?.anchor" side="bottom" cross="start">
            <div class="w-pop p-3">
                <GateAccess v-if="gateShown" :workflow="gateShown.workflow" />
            </div>
        </AnchoredOverlay>
    </Page>
</template>
