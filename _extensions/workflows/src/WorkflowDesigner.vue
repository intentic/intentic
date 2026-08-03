<script setup lang="ts">
import { Button, cmp, Icon, Popover, ToggleSwitch } from "@intentic/extension-ui";
import { type Workflow, workflowFaults } from "@intentic/sandbox-contract";
import { computed, ref, watch } from "vue";
import StepInspector from "./StepInspector.vue";
import WorkflowCanvas from "./WorkflowCanvas.vue";
import { addStep, connectSteps, disconnectSteps, removeStep, toggleHandoff, updateStep } from "./workflowEdit";
import { editableCopy } from "./workflowDraft";
import { useWorkflows } from "./useWorkflows";

/* THE DESIGNER — a full page whose content is the canvas.
 *
 * IT WAS A DIALOG, AND THAT WAS THE WHOLE PROBLEM. A graph needs horizontal room; a modal is the one container
 * that categorically cannot give it any. Inside 72rem the canvas was a letterbox that showed one node while the
 * second sat off-screen, and the form beside it was a scrolling column of nine questions. The page it is now
 * uses `Page width="full"` — the width tier whose own comment reads "canvas surfaces that need every pixel" —
 * and reserves everything below the header for the graph.
 *
 * IT IS A MODE OF THE WORKFLOWS VIEW, NOT A ROUTE OF ITS OWN. An extension's route space is the QUERY (see
 * IntenticApi.route), so `?edit=<id>` is the whole navigation, Back leaves the designer, and the URL is
 * linkable. Same shape the documentation extension uses for opening a document.
 *
 * WHAT LIVES WHERE, and it is the same rule three times: the thing goes where you can see it.
 *  · dependencies  → the canvas. You draw them.
 *  · the handoff   → the EDGE. Click it; it is already drawn as solid-versus-dashed.
 *  · a step's prose → the inspector, which asks two questions and folds the other nine away.
 *  · run settings  → a popover off the header. They belong to the whole run, not to any step, and putting them
 *                    beside a step's fields is what made the old panel read as one undifferentiated wall.
 */

const { initial } = defineProps<{ initial: Workflow }>();
const emit = defineEmits<{ close: []; saved: [id: string] }>();

const { save } = useWorkflows();
// `editableCopy`, not structuredClone — `initial` is a reactive proxy here. See workflowDraft.ts.
const draft = ref<Workflow>(editableCopy(initial));
const selectedId = ref<string | undefined>(initial.steps[0]?.id);
// The edge the reader last clicked, as its endpoints. Drives the little edge card over the canvas.
const pickedEdge = ref<{ from: string; to: string }>();
const failure = ref<string>();
const settingsAnchor = ref<HTMLElement>();
const settings = ref<InstanceType<typeof Popover>>();

// Re-opening on a different workflow must not keep the last one's draft — a designer that silently edits the
// wrong workflow is the one mistake here that is invisible until it is saved.
watch(
    () => initial,
    (next) => {
        draft.value = editableCopy(next);
        selectedId.value = next.steps[0]?.id;
        pickedEdge.value = undefined;
        failure.value = undefined;
    },
);

const faults = computed(() => workflowFaults(draft.value));
const selected = computed(() => draft.value.steps.find((step) => step.id === selectedId.value));
const pickedStep = computed(() => draft.value.steps.find((step) => step.id === pickedEdge.value?.to));
const stepTitle = (id: string): string => draft.value.steps.find((step) => step.id === id)?.title ?? id;

const patch = (over: Partial<Workflow>): void => {
    draft.value = { ...draft.value, ...over };
};

// Every graph gesture goes through workflowEdit, which is where the invariants are kept and where they are
// tested. This component's job is to say which gesture happened, not what it means.
const onAdd = (after?: string): void => {
    const added = addStep(draft.value, after);
    draft.value = added.workflow;
    selectedId.value = added.stepId;
    pickedEdge.value = undefined;
};
const onConnect = (from: string, to: string): void => {
    draft.value = connectSteps(draft.value, from, to);
};
const onSelectEdge = (from: string, to: string): void => {
    pickedEdge.value = { from, to };
    selectedId.value = undefined;
};
const onRemove = (id: string): void => {
    draft.value = removeStep(draft.value, id);
    selectedId.value = draft.value.steps[0]?.id;
};
const dropEdge = (): void => {
    const edge = pickedEdge.value;
    if (edge !== undefined) {
        draft.value = disconnectSteps(draft.value, edge.from, edge.to);
        pickedEdge.value = undefined;
    }
};
const flipHandoff = (): void => {
    if (pickedEdge.value !== undefined) {
        draft.value = toggleHandoff(draft.value, pickedEdge.value.to);
    }
};

const ready = computed(
    () => faults.value.length === 0 && draft.value.name.trim() !== `` && draft.value.steps.every((step) => step.prompt.trim() !== ``),
);

const commit = async (): Promise<void> => {
    failure.value = undefined;
    try {
        /* A step's `goal` is required by the contract but not by this form — "done when" is the second
         * question and plenty of steps do not need one. Falling back to the title is honest rather than
         * invented: an unstated goal IS "do what this step is called", which is what the title says. */
        const steps = draft.value.steps.map((step) => (step.goal.trim() === `` ? { ...step, goal: step.title } : step));
        await save.mutateAsync({ ...draft.value, steps });
        emit(`saved`, draft.value.id);
    } catch (error) {
        failure.value = error instanceof Error ? error.message : `The workflow could not be saved.`;
    }
};
</script>

<template>
    <!-- The page does not scroll; the canvas fills it and the inspector scrolls itself. -->
    <div class="flex h-full min-h-0 flex-col">
        <header class="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-4 py-2.5">
            <button type="button" :class="cmp.iconButton()" aria-label="Back to workflows" @click="emit(`close`)"><Icon name="arrow-left" /></button>
            <input
                :value="draft.name"
                :class="[cmp.input(), `min-w-48 max-w-96 flex-1 font-medium`]"
                aria-label="Workflow name"
                placeholder="Name this workflow"
                @input="patch({ name: ($event.target as HTMLInputElement).value })"
            />
            <!-- The discoverable way to add a step. The `+` on a node's handle is faster once you know it is
                 there, and dragging off a handle is faster still — but neither is visible until you hover a
                 node, and an editor whose primary action only appears on hover has no primary action. -->
            <Button label="Add step" size="small" severity="secondary" @click="onAdd(selectedId ?? draft.steps.at(-1)?.id)">
                <template #icon><Icon name="plus" /></template>
            </Button>
            <span ref="settingsAnchor">
                <Button label="Run settings" size="small" severity="secondary" :text="true" @click="settings?.toggle($event)">
                    <template #icon><Icon name="sliders-h" /></template>
                </Button>
            </span>
            <span class="flex-1"></span>
            <span v-if="faults.length > 0" class="truncate text-2xs text-warning">{{ faults[0] }}</span>
            <button type="button" :class="cmp.linkButton()" @click="emit(`close`)">Cancel</button>
            <Button label="Save" size="small" :disabled="!ready || save.isPending.value" @click="commit()">
                <template #icon><Icon name="save" /></template>
            </Button>
        </header>

        <p v-if="failure" :class="cmp.alertDanger('m-3')">{{ failure }}</p>

        <div class="flex min-h-0 flex-1">
            <!-- The canvas takes everything the inspector does not. -->
            <div class="relative min-w-0 flex-1">
                <WorkflowCanvas
                    v-model="selectedId"
                    :workflow="draft"
                    @connect="onConnect"
                    @select-edge="onSelectEdge"
                    @add="(from) => onAdd(from)"
                />

                <!-- The empty state sits ON the canvas, because the canvas is where the first step goes. -->
                <div v-if="draft.steps.length === 0" class="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2">
                    <p class="text-xs text-subtle">Nothing here yet.</p>
                    <Button class="pointer-events-auto" label="Add the first step" size="small" @click="onAdd()">
                        <template #icon><Icon name="plus" /></template>
                    </Button>
                </div>

                <!-- THE EDGE CARD. A dependency has exactly two things worth saying about it, so it gets two
                     controls floating over the canvas rather than a panel: is this the same agent carrying on,
                     and should the line be there at all. -->
                <div
                    v-if="pickedEdge && pickedStep"
                    class="absolute left-1/2 top-3 flex -translate-x-1/2 items-center gap-2 rounded-lg border border-line bg-card px-2.5 py-1.5 shadow-sm"
                >
                    <span class="text-2xs text-subtle">
                        <span class="text-content">{{ stepTitle(pickedEdge.from) }}</span> →
                        <span class="text-content">{{ stepTitle(pickedEdge.to) }}</span>
                    </span>
                    <button
                        type="button"
                        v-tooltip.top="
                            pickedStep.needs.length === 1
                                ? `A new session knows only what the step before it declared — the only honest way to review work. Carrying on keeps the agent, its thread and its working tree.`
                                : `Only a step with exactly one predecessor can carry a session on.`
                        "
                        class="cursor-pointer rounded-full border px-2 py-0.5 text-2xs disabled:cursor-default disabled:opacity-40"
                        :class="
                            pickedStep.handoff === `continue`
                                ? `border-link bg-link/10 text-link`
                                : `border-line text-subtle hover:border-line-strong`
                        "
                        :disabled="pickedStep.needs.length !== 1"
                        @click="flipHandoff()"
                    >
                        {{ pickedStep.handoff === `continue` ? `Same agent` : `New agent` }}
                    </button>
                    <button type="button" :class="cmp.iconButton(`text-danger`)" aria-label="Remove this dependency" @click="dropEdge()">
                        <Icon name="times" />
                    </button>
                </div>
            </div>

            <aside v-if="selected" class="flex w-80 shrink-0 flex-col border-l border-line">
                <StepInspector
                    :key="selected.id"
                    :model-value="selected"
                    @update:model-value="draft = updateStep(draft, selected.id, $event)"
                    @remove="onRemove(selected.id)"
                />
            </aside>
        </div>

        <!-- Run settings: properties of the WHOLE run, so they are one click off the header rather than mixed
             in with a step's own fields. -->
        <Popover ref="settings">
            <div class="flex w-80 flex-col gap-3 p-1">
                <label class="flex items-start gap-2">
                    <ToggleSwitch :model-value="draft.isolated" @update:model-value="patch({ isolated: $event })" />
                    <span class="flex flex-col">
                        <span class="text-xs font-medium text-content">Work on branches</span>
                        <span class="text-2xs text-subtle">
                            {{
                                draft.isolated
                                    ? `Each new agent gets its own worktree off main, and is told the branch the steps before it worked on.`
                                    : `Every step works directly on this workspace, so each sees what the last one did — but steps running side by side share one tree.`
                            }}
                        </span>
                    </span>
                </label>
                <div class="flex flex-wrap items-end gap-3">
                    <label class="flex flex-col gap-1">
                        <span :class="cmp.sectionLabel()">At once</span>
                        <input
                            :value="draft.maxParallel"
                            type="number"
                            min="1"
                            max="8"
                            :class="[cmp.input(), `w-20`]"
                            @input="patch({ maxParallel: Number(($event.target as HTMLInputElement).value) })"
                        />
                    </label>
                    <label class="flex flex-col gap-1">
                        <span :class="cmp.sectionLabel()">Whole run, at most</span>
                        <input
                            :value="draft.maxSpendUsd ?? ``"
                            type="number"
                            min="1"
                            step="1"
                            placeholder="dollars"
                            :class="[cmp.input(), `w-28`]"
                            @input="patch({ maxSpendUsd: Number(($event.target as HTMLInputElement).value) || undefined })"
                        />
                    </label>
                </div>
                <label class="flex flex-col gap-1">
                    <span :class="cmp.sectionLabel()">What it is for</span>
                    <input
                        :value="draft.description ?? ``"
                        :class="cmp.input()"
                        placeholder="optional"
                        @input="patch({ description: ($event.target as HTMLInputElement).value })"
                    />
                </label>
                <p v-for="fault in faults" :key="fault" class="text-2xs text-warning">{{ fault }}</p>
            </div>
        </Popover>
    </div>
</template>
