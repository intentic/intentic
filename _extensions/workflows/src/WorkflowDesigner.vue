<script setup lang="ts">
import { Button, cmp, Dialog, Icon, ToggleSwitch } from "@intentic/extension-ui";
import { type Workflow, type WorkflowStep, workflowFaults } from "@intentic/sandbox-contract";
import { computed, ref, watch } from "vue";
import StepFields from "./StepFields.vue";
import WorkflowGraph from "./WorkflowGraph.vue";
import { useWorkflows } from "./useWorkflows";

/* THE DESIGNER — the graph on the left, the step you are editing on the right.
 *
 * THE CANVAS DOES NOT EDIT, AND THAT IS THE DESIGN DECISION HERE. The obvious build is a node editor: drag
 * boxes, pull edges between them. It is the wrong shape for this content. A workflow step is a goal, an
 * instruction, an output shape and four ceilings — overwhelmingly prose — and a canvas is a poor text editor
 * at any size. Meanwhile the dependency graph is small (a handful of edges, mostly a chain) and a multi-select
 * of names is both faster to author than dragging and far faster to correct. So the canvas keeps the job it is
 * genuinely best at, which is showing you the shape you have made, and clicking a node selects the step whose
 * form is beside it. One picture, one form, and the picture is always the truth because both read the same
 * derivation.
 *
 * THE FAULTS ARE LIVE, under the canvas, and they are the same sentences the save route refuses with. A rule
 * the daemon holds privately is a rule you meet as a failed save with no idea which node is wrong.
 */

const { initial } = defineProps<{ initial: Workflow }>();
const open = defineModel<boolean>({ required: true });

const { save } = useWorkflows();
const draft = ref<Workflow>(structuredClone(initial));
const selectedId = ref<string | undefined>(initial.steps[0]?.id);
const failure = ref<string>();

// Re-opening on a different workflow must not keep the last one's draft — a designer that silently edits the
// wrong workflow is the one mistake here that is invisible until it is saved.
watch(
    () => initial,
    (next) => {
        draft.value = structuredClone(next);
        selectedId.value = next.steps[0]?.id;
        failure.value = undefined;
    },
);

const faults = computed(() => workflowFaults(draft.value));
const selected = computed(() => draft.value.steps.find((step) => step.id === selectedId.value));
const others = computed(() => draft.value.steps.filter((step) => step.id !== selectedId.value));

const patch = (over: Partial<Workflow>): void => {
    draft.value = { ...draft.value, ...over };
};

// A new step's id has to be unique AND slug-shaped (it is spliced into a conversation id and a branch name),
// so it is minted rather than typed. The title is what the user names; the id is plumbing they never see.
const nextStepId = (): string => {
    const used = new Set(draft.value.steps.map((step) => step.id));
    let n = draft.value.steps.length + 1;
    while (used.has(`step-${n}`)) {
        n += 1;
    }
    return `step-${n}`;
};

const addStep = (): void => {
    const id = nextStepId();
    // Chained onto the last step by default. A workflow is a sequence far more often than it is a fan-out, and
    // starting every new step disconnected means the common case is two clicks of housekeeping per step.
    const previous = draft.value.steps.at(-1);
    const step: WorkflowStep = {
        id,
        title: `Step ${draft.value.steps.length + 1}`,
        goal: ``,
        prompt: ``,
        needs: previous === undefined ? [] : [previous.id],
        handoff: `fresh`,
        output: { kind: `claim` },
        checks: [],
        context: `fresh`,
        maxIterations: 8,
        stallLimit: 2,
        maxSpendUsd: 5,
    };
    patch({ steps: [...draft.value.steps, step] });
    selectedId.value = id;
};

const updateStep = (next: WorkflowStep): void => patch({ steps: draft.value.steps.map((step) => (step.id === next.id ? next : step)) });

const removeStep = (id: string): void => {
    // Its dependents lose the edge rather than being left pointing at nothing — a dangling `needs` is a fault,
    // and producing one as a side effect of a delete would be the designer breaking its own document.
    const withoutNeed = (step: WorkflowStep): WorkflowStep =>
        step.needs.includes(id) ? { ...step, needs: step.needs.filter((need) => need !== id) } : step;
    patch({ steps: draft.value.steps.filter((step) => step.id !== id).map(withoutNeed) });
    selectedId.value = draft.value.steps[0]?.id;
};

const moveStep = (id: string, by: -1 | 1): void => {
    const from = draft.value.steps.findIndex((step) => step.id === id);
    const to = from + by;
    if (from === -1 || to < 0 || to >= draft.value.steps.length) {
        return;
    }
    const steps = [...draft.value.steps];
    const [moved] = steps.splice(from, 1);
    if (moved !== undefined) {
        steps.splice(to, 0, moved);
    }
    patch({ steps });
};

const ready = computed(
    () =>
        faults.value.length === 0 &&
        draft.value.name.trim() !== `` &&
        draft.value.steps.every((step) => step.goal.trim() !== `` && step.prompt.trim() !== ``),
);

const commit = async (): Promise<void> => {
    failure.value = undefined;
    try {
        await save.mutateAsync(draft.value);
        open.value = false;
    } catch (error) {
        failure.value = error instanceof Error ? error.message : `The workflow could not be saved.`;
    }
};
</script>

<template>
    <Dialog v-model:visible="open" :modal="true" :draggable="false" :style="{ width: '72rem', maxWidth: '95vw' }" header="Design a workflow">
        <div class="flex flex-col gap-4">
            <div class="flex flex-wrap items-end gap-3">
                <label class="flex min-w-52 flex-1 flex-col gap-1">
                    <span :class="cmp.sectionLabel()">Name</span>
                    <input :value="draft.name" :class="cmp.input()" @input="patch({ name: ($event.target as HTMLInputElement).value })" />
                </label>
                <label class="flex min-w-52 flex-[2] flex-col gap-1">
                    <span :class="cmp.sectionLabel()">What it is for</span>
                    <input
                        :value="draft.description ?? ``"
                        :class="cmp.input()"
                        placeholder="optional"
                        @input="patch({ description: ($event.target as HTMLInputElement).value })"
                    />
                </label>
            </div>

            <div class="grid grid-cols-1 gap-4 lg:grid-cols-[3fr_2fr]">
                <div class="flex flex-col gap-2">
                    <WorkflowGraph v-model="selectedId" :workflow="draft" />

                    <!-- The faults, live. Same sentences the save route refuses with — see workflowFaults. -->
                    <div v-if="faults.length > 0" :class="cmp.alertWarning()">
                        <span class="block font-medium">This cannot run yet</span>
                        <span v-for="fault in faults" :key="fault" class="mt-0.5 block text-xs">{{ fault }}</span>
                    </div>

                    <!-- The run-level settings sit under the canvas because they are properties of the PICTURE,
                         not of any step: where the work happens and how wide it may go. -->
                    <div class="flex flex-col gap-2 rounded-lg border border-line bg-card p-3">
                        <label class="flex items-start gap-2">
                            <ToggleSwitch :model-value="draft.isolated" @update:model-value="patch({ isolated: $event })" />
                            <span class="flex flex-col">
                                <span class="text-xs font-medium text-content">Work on branches</span>
                                <span class="text-2xs text-subtle">
                                    {{
                                        draft.isolated
                                            ? `Each new session gets its own worktree off main, and is told the branch the steps before it worked on. Right for reviewing, and for anything you want to land deliberately.`
                                            : `Every step works directly on this workspace, so each one sees what the last one did. Right for a chain that builds on itself — but steps running side by side share one tree.`
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
                            <span class="flex-1 text-2xs text-subtle">
                                Each step has its own ceiling too. This one is the number that stops the run — eight steps under $2 each is a $16 run.
                            </span>
                        </div>
                    </div>
                </div>

                <div class="flex max-h-[60vh] flex-col gap-2 overflow-y-auto pr-1">
                    <StepFields
                        v-if="selected"
                        :key="selected.id"
                        :model-value="selected"
                        :others="others"
                        @update:model-value="updateStep($event)"
                        @remove="removeStep(selected.id)"
                        @move="moveStep(selected.id, $event)"
                    />
                    <div v-else :class="cmp.emptyState('py-5')">Pick a step on the left, or add one.</div>
                    <Button label="Add a step" size="small" severity="secondary" @click="addStep()">
                        <template #icon><Icon name="plus" /></template>
                    </Button>
                </div>
            </div>

            <p v-if="failure" :class="cmp.alertDanger()">{{ failure }}</p>
        </div>

        <template #footer>
            <button type="button" :class="cmp.linkButton()" @click="open = false">Cancel</button>
            <button type="button" :class="cmp.buttonPrimary()" :disabled="!ready || save.isPending.value" @click="commit()">
                {{ save.isPending.value ? `Saving…` : `Save workflow` }}
            </button>
        </template>
    </Dialog>
</template>
