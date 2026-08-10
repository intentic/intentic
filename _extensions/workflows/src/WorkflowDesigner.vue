<script setup lang="ts">
import { Button, cmp, Icon, Popover, ResizeSeam } from "@intentic/extension-ui";
import { type Workflow, workflowFaults } from "@intentic/sandbox-contract";
import { computed, ref, watch } from "vue";
import GatePanel from "./GatePanel.vue";
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
 *
 * THE SPLIT IS THE READER'S TO SET. Canvas and inspector want opposite things and both are right: reading the
 * shape of a nine-step graph wants the width, writing a step's prompt wants the column. A fixed 20rem answered
 * neither — the prompt, which is the one real paragraph in this extension, was being written three words to a
 * line. So the seam is draggable, double-click puts it back, and the width is remembered.
 */

const { initial, creating } = defineProps<{ initial: Workflow; creating: boolean }>();
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
const gatePanel = ref<InstanceType<typeof Popover>>();

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

/* THE PROMPT IS NO LONGER A CONDITION OF SAVING, and that is the point of the whole change rather than a
 * loosened rule. A step with no prompt is not an unfinished step — it is one that does whatever the run was
 * asked to do, which is the ordinary case for a design kept as a SHAPE. Requiring one here forced every author
 * to write a paraphrase of the request into every node before the graph would save, which is exactly the
 * wrapper the default removes. What remains is what genuinely cannot be inferred: a name, and a runnable graph.
 */
const ready = computed(() => faults.value.length === 0 && draft.value.name.trim() !== ``);

/* THE INSPECTOR'S WIDTH. Remembered per browser rather than per workflow: it is a property of the desk you are
 * working at (how wide the window is, whether you are writing or reading), not of the graph in front of you.
 * The floor is a readable column, the ceiling leaves the canvas more than half of a laptop screen. */
const WIDTH_KEY = `ext-workflows-inspector-width`;
const DEFAULT_WIDTH = 360;
const readWidth = (): number => {
    try {
        const stored = Number(localStorage.getItem(WIDTH_KEY));
        if (Number.isFinite(stored) && stored > 0) {
            return stored;
        }
    } catch {
        // Storage may be unavailable (private mode); fall back to the default.
    }
    return DEFAULT_WIDTH;
};
const inspectorWidth = ref(readWidth());
watch(inspectorWidth, (px) => {
    try {
        localStorage.setItem(WIDTH_KEY, String(px));
    } catch {
        // Storage may be unavailable (private mode); the in-memory ref still holds.
    }
});

const commit = async (): Promise<void> => {
    failure.value = undefined;
    try {
        /* Saved as authored. An unstated goal used to be back-filled with the step's TITLE here, because the
         * contract demanded one — an invented bar dressed up as an honest one, since "Claude's attempt" is a
         * label and not a description of done. It is absent now, and absent has a real meaning: the step is
         * measured against what the run was asked to do. The inspector already stores a cleared box as absent
         * rather than as ``, so there is nothing left to normalize on the way out. */
        await save.mutateAsync({ workflow: draft.value, create: creating });
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
            <!-- The gate sits beside Run settings because it is the same kind of thing — a property of the
                 whole design, not of any step. The icon takes the link tint when one is declared, which is the
                 header's whole statement of "a pipeline can call this". -->
            <Button label="CI gate" size="small" severity="secondary" :text="true" @click="gatePanel?.toggle($event)">
                <template #icon><Icon name="shield" :class="draft.gate !== undefined ? `text-link` : ``" /></template>
            </Button>
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

            <template v-if="selected">
                <ResizeSeam v-model="inspectorWidth" pane="after" :min="288" :max="720" :reset="DEFAULT_WIDTH" />
                <aside class="flex shrink-0 flex-col border-l border-line" :style="{ width: `${inspectorWidth}px` }">
                    <StepInspector
                        :key="selected.id"
                        :model-value="selected"
                        @update:model-value="draft = updateStep(draft, selected.id, $event)"
                        @remove="onRemove(selected.id)"
                    />
                </aside>
            </template>
        </div>

        <!-- Run settings: properties of the WHOLE run, so they are one click off the header rather than mixed
             in with a step's own fields. -->
        <Popover ref="settings">
            <div class="flex w-80 flex-col gap-3 p-1">
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
                    <span class="text-2xs text-subtle">How many steps may run side by side. Every one of them works in a worktree of its own.</span>
                </label>
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

        <!-- The gate: how a CI pipeline runs this design and reads a verdict back. -->
        <Popover ref="gatePanel">
            <GatePanel :workflow="draft" @patch="(gate) => patch({ gate })" />
        </Popover>
    </div>
</template>
