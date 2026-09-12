<script setup lang="ts">
import { Button, ui, Icon, Notice, noticeOf, Popover, ResizeSeam } from "@intentic/extension-ui";
import { type Workflow, workflowFaults } from "@intentic/sandbox-contract";
import { computed, ref, watch } from "vue";
import GatePanel from "./GatePanel.vue";
import StepInspector from "./StepInspector.vue";
import WorkflowCanvas from "./WorkflowCanvas.vue";
import { addStep, connectSteps, disconnectSteps, removeStep, toggleHandoff, updateStep } from "./workflowEdit";
import { editableCopy } from "./workflowDraft";
import { useWorkflows } from "./useWorkflows";

// Full-page designer, not a modal, since a graph needs horizontal room a dialog can't give. A mode of the workflows
// view via `?edit=<id>`, not its own route. Dependencies live on the canvas, handoff on the edge, prose in the
// inspector, run settings in a header popover; the canvas/inspector seam is draggable.

// Saved design's summary (with gate token) or a bare template; the token is kept out of the saveable draft.
const { initial, creating } = defineProps<{ initial: Workflow & { readonly gateToken?: string }; creating: boolean }>();
const emit = defineEmits<{ close: []; saved: [id: string] }>();

const { save } = useWorkflows();
// `editableCopy`, not structuredClone, since `initial` here is a reactive proxy.
const draft = ref<Workflow>(editableCopy(initial));
const gateToken = ref<string | undefined>(initial.gateToken);
const selectedId = ref<string | undefined>(initial.steps[0]?.id);
// Endpoints of the last-clicked edge; drives the floating edge card over the canvas.
const pickedEdge = ref<{ from: string; to: string }>();
const failure = ref<string>();
const settingsAnchor = ref<HTMLElement>();
const settings = ref<InstanceType<typeof Popover>>();
const gatePanel = ref<InstanceType<typeof Popover>>();

// Resets the draft when `initial` changes, so reopening on a different workflow can't silently keep editing the last
// one.
watch(
    () => initial,
    (next) => {
        draft.value = editableCopy(next);
        gateToken.value = next.gateToken;
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

// Every gesture routes through workflowEdit, which owns the invariants and is what's tested.
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

// Prompt is optional now; only a name and a fault-free graph are required to save.
const ready = computed(() => faults.value.length === 0 && draft.value.name.trim() !== ``);

// Inspector width is remembered per browser, not per workflow; a property of the desk, not the graph.
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
        // Saved as authored: an absent goal means measured against the run's request, nothing to normalize here.
        const saved = await save.mutateAsync({ workflow: draft.value, create: creating });
        gateToken.value = saved.gateToken;
        emit(`saved`, draft.value.id);
    } catch (error) {
        failure.value = error instanceof Error ? error.message : `The workflow could not be saved.`;
    }
};
</script>

<template>
    <!-- The page does not scroll; the canvas fills it and the inspector scrolls itself. -->
    <div class="flex h-full min-h-0 flex-col">
        <header class="flex shrink-0 flex-wrap items-center gap-2 border-b border-line-subtle px-4 py-2.5">
            <button type="button" :class="ui.iconButton()" aria-label="Back to workflows" @click="emit(`close`)"><Icon name="arrow-left" /></button>
            <input
                :value="draft.name"
                :class="[ui.input(), `min-w-48 max-w-96 flex-1 font-medium`]"
                aria-label="Workflow name"
                placeholder="Name this workflow"
                @input="patch({ name: ($event.target as HTMLInputElement).value })"
            />
            <!-- Discoverable add: the node handle's `+` and drag-to-add are faster but hidden until hover. -->
            <Button label="Add step" size="small" severity="secondary" @click="onAdd(selectedId ?? draft.steps.at(-1)?.id)">
                <template #icon><Icon name="plus" /></template>
            </Button>
            <span ref="settingsAnchor">
                <Button label="Run settings" size="small" severity="secondary" :text="true" @click="settings?.toggle($event)">
                    <template #icon><Icon name="sliders-h" /></template>
                </Button>
            </span>
            <!-- Property of the whole design, like Run settings; the icon tints when a gate is declared. -->
            <Button label="CI gate" size="small" severity="secondary" :text="true" @click="gatePanel?.toggle($event)">
                <template #icon><Icon name="shield" :class="draft.gate !== undefined ? `text-link` : ``" /></template>
            </Button>
            <span class="flex-1"></span>
            <span v-if="faults.length > 0" class="truncate text-2xs text-warning">{{ faults[0] }}</span>
            <button type="button" :class="ui.linkButton()" @click="emit(`close`)">Cancel</button>
            <Button label="Save" size="small" :disabled="!ready || save.isPending.value" @click="commit()">
                <template #icon><Icon name="save" /></template>
            </Button>
        </header>

        <Notice v-if="failure" :of="noticeOf(failure)" class="m-3" />

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

                <!-- Empty state sits directly on the canvas, where the first step will go. -->
                <div v-if="draft.steps.length === 0" class="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2">
                    <p class="text-xs text-subtle">Nothing here yet.</p>
                    <Button class="pointer-events-auto" label="Add the first step" size="small" @click="onAdd()">
                        <template #icon><Icon name="plus" /></template>
                    </Button>
                </div>

                <!-- Edge card: a dependency has exactly two settings, same agent or not, and whether it exists at all. -->
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
                                ? `A new session knows only what the step before it declared: the only honest way to review work. Carrying on keeps the agent, its thread and its working tree.`
                                : `Only a step with exactly one predecessor can carry a session on.`
                        "
                        class="ui-chip"
                        :class="pickedStep.handoff === `continue` ? `ui-chip-on` : ``"
                        :disabled="pickedStep.needs.length !== 1"
                        @click="flipHandoff()"
                    >
                        {{ pickedStep.handoff === `continue` ? `Same agent` : `New agent` }}
                    </button>
                    <button type="button" :class="ui.iconButton(`text-danger`)" aria-label="Remove this dependency" @click="dropEdge()">
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

        <!-- Run settings are properties of the whole run, kept off the header rather than mixed into a step's fields. -->
        <Popover ref="settings">
            <div class="flex w-80 flex-col gap-3 p-1">
                <label class="flex flex-col gap-1">
                    <span :class="ui.sectionLabel()">At once</span>
                    <input
                        :value="draft.maxParallel"
                        type="number"
                        min="1"
                        max="8"
                        :class="[ui.input(), `w-20`]"
                        @input="patch({ maxParallel: Number(($event.target as HTMLInputElement).value) })"
                    />
                    <span class="text-2xs text-subtle">How many steps may run side by side. Every one of them works in a worktree of its own.</span>
                </label>
                <label class="flex flex-col gap-1">
                    <span :class="ui.sectionLabel()">What it is for</span>
                    <input
                        :value="draft.description ?? ``"
                        :class="ui.input()"
                        placeholder="optional"
                        @input="patch({ description: ($event.target as HTMLInputElement).value })"
                    />
                </label>
                <p v-for="fault in faults" :key="fault" class="text-2xs text-warning">{{ fault }}</p>
            </div>
        </Popover>

        <!-- The gate: how a CI pipeline runs this design and reads a verdict back. -->
        <Popover ref="gatePanel">
            <GatePanel :workflow="draft" :gate-token="gateToken" @patch="(gate) => patch({ gate })" />
        </Popover>
    </div>
</template>
