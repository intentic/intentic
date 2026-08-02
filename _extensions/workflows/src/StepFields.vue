<script setup lang="ts">
import { Button, Checkbox, cmp, Icon, Segmented, Select } from "@intentic/extension-ui";
import type { OutputField, WorkflowStep } from "@intentic/sandbox-contract";
import { computed } from "vue";

/* ONE STEP'S FORM. Ordered by what the author already knows, the same rule the loop dialog follows: the title
 * and the two sentences first, then what it must produce, then what checks it, then the ceilings last with
 * safe defaults already in them.
 *
 * WHAT IT PRODUCES IS ABOVE WHAT DEPENDS ON IT, deliberately. The output shape is the interface between this
 * step and the rest of the workflow, and an author who fills it in last has already written the next step's
 * prompt against a shape they were imagining. Putting it here makes the handoff the thing you design, which is
 * the only part of a workflow that a single prompt could not have done.
 */

const step = defineModel<WorkflowStep>({ required: true });
const { others } = defineProps<{ others: readonly WorkflowStep[] }>();
const emit = defineEmits<{ remove: []; move: [-1 | 1] }>();

const patch = (over: Partial<WorkflowStep>): void => {
    step.value = { ...step.value, ...over };
};

const HANDOFF_OPTIONS = [
    { value: `fresh` as const, label: `New session` },
    { value: `continue` as const, label: `Same session` },
];
const CONTEXT_OPTIONS = [
    { value: `fresh` as const, label: `Fresh each round` },
    { value: `continue` as const, label: `Keep the thread` },
];
const OUTPUT_OPTIONS = [
    { value: `none` as const, label: `Nothing` },
    { value: `claim` as const, label: `A claim` },
    { value: `json` as const, label: `Structured data` },
];
const TYPE_OPTIONS: { label: string; value: OutputField["type"] }[] = [
    { label: `text`, value: `string` },
    { label: `number`, value: `number` },
    { label: `yes/no`, value: `boolean` },
    { label: `list of text`, value: `string[]` },
];

// What each choice costs, said where the choice is made. The handoff note is the one people get wrong in both
// directions — "same session" looks free until a reviewer inherits the opinions it is meant to be checking.
const handoffNote = computed(() =>
    step.value.handoff === `fresh`
        ? `A new agent, which knows only what the steps above declared as output. The only honest way to review, audit or second-guess work.`
        : `Carries on the step above: same agent, same working tree, same thread. What "build on the last step" actually means — and useless for reviewing it.`,
);

const newField = (): OutputField => ({ name: `result`, type: `string`, description: ``, required: true });

const outputKind = computed({
    get: () => step.value.output.kind,
    set: (kind: `none` | `claim` | `json`) =>
        patch({
            output:
                kind === `json` ? { kind: `json`, fields: step.value.output.kind === `json` ? step.value.output.fields : [newField()] } : { kind },
        }),
});
const fields = computed(() => (step.value.output.kind === `json` ? step.value.output.fields : []));

const setFields = (next: readonly OutputField[]): void => patch({ output: { kind: `json`, fields: [...next] } });
const patchField = (index: number, over: Partial<OutputField>): void => {
    const applied = (field: OutputField, at: number): OutputField => (at === index ? { ...field, ...over } : field);
    setFields(fields.value.map(applied));
};

/* The checks list is one command and one judge at most, because a step wanting two commands wants `a && b`,
 * and a step wanting two judges is asking one model the same question twice. Emptying either field removes it
 * rather than storing a blank — a check that checks nothing would be a check the graph claims to have. */
const setCheck = (kind: `command` | `judge`, value: string): void => {
    const rest = step.value.checks.filter((check) => check.kind !== kind);
    const trimmed = value.trim();
    patch({
        checks: trimmed === `` ? rest : [...rest, kind === `command` ? { kind: `command`, command: trimmed } : { kind: `judge`, rubric: trimmed }],
    });
};
const command = computed({
    get: () => step.value.checks.find((check) => check.kind === `command`)?.command ?? ``,
    set: (value: string) => setCheck(`command`, value),
});
const rubric = computed({
    get: () => step.value.checks.find((check) => check.kind === `judge`)?.rubric ?? ``,
    set: (value: string) => setCheck(`judge`, value),
});

const toggleNeed = (id: string): void =>
    patch({ needs: step.value.needs.includes(id) ? step.value.needs.filter((need) => need !== id) : [...step.value.needs, id] });
</script>

<template>
    <div class="flex flex-col gap-3 rounded-lg border border-line bg-card p-3">
        <div class="flex items-center gap-2">
            <input
                :value="step.title"
                :class="[cmp.input(), `flex-1 font-medium`]"
                placeholder="What this step is called"
                @input="patch({ title: ($event.target as HTMLInputElement).value })"
            />
            <button type="button" :class="cmp.iconButton()" aria-label="Move up" @click="emit(`move`, -1)"><Icon name="chevron-up" /></button>
            <button type="button" :class="cmp.iconButton()" aria-label="Move down" @click="emit(`move`, 1)"><Icon name="chevron-down" /></button>
            <button type="button" :class="cmp.iconButton(`text-danger`)" aria-label="Remove step" @click="emit(`remove`)">
                <Icon name="trash" />
            </button>
        </div>

        <label class="flex flex-col gap-1">
            <span :class="cmp.sectionLabel()">Done means</span>
            <input
                :value="step.goal"
                :class="cmp.input()"
                placeholder="the failing case is reproduced and understood"
                @input="patch({ goal: ($event.target as HTMLInputElement).value })"
            />
        </label>

        <label class="flex flex-col gap-1">
            <span :class="cmp.sectionLabel()">What it does</span>
            <textarea
                :value="step.prompt"
                :class="cmp.input()"
                rows="3"
                placeholder="Reproduce the problem. Do not fix anything — find the smallest command that shows it failing."
                @input="patch({ prompt: ($event.target as HTMLTextAreaElement).value })"
            ></textarea>
        </label>

        <!-- What it hands on. Above the dependency picker because this is the interface, and the interface is
             the part of a workflow that a single long prompt could not have expressed. -->
        <div class="flex flex-col gap-1.5">
            <span :class="cmp.sectionLabel()">What it hands on</span>
            <Segmented v-model="outputKind" :options="OUTPUT_OPTIONS" />
            <div v-if="step.output.kind === `json`" class="flex flex-col gap-1.5">
                <div v-for="(field, index) in fields" :key="index" class="flex flex-wrap items-start gap-1.5">
                    <input
                        :value="field.name"
                        :class="[cmp.input(), `w-28 font-mono text-2xs`]"
                        placeholder="name"
                        @input="patchField(index, { name: ($event.target as HTMLInputElement).value })"
                    />
                    <Select
                        :model-value="field.type"
                        :options="TYPE_OPTIONS"
                        option-label="label"
                        option-value="value"
                        size="small"
                        class="w-32"
                        @update:model-value="patchField(index, { type: $event })"
                    />
                    <input
                        :value="field.description"
                        :class="[cmp.input(), `min-w-40 flex-1`]"
                        placeholder="what belongs here — the model reads this"
                        @input="patchField(index, { description: ($event.target as HTMLInputElement).value })"
                    />
                    <label class="flex items-center gap-1 pt-1.5 text-2xs text-subtle">
                        <Checkbox :model-value="field.required" binary @update:model-value="patchField(index, { required: $event })" />
                        required
                    </label>
                    <button
                        type="button"
                        :class="cmp.iconButton(`text-danger`)"
                        aria-label="Remove field"
                        @click="setFields(fields.filter((_, at) => at !== index))"
                    >
                        <Icon name="trash" />
                    </button>
                </div>
                <Button label="Add field" size="small" severity="secondary" :text="true" @click="setFields([...fields, newField()])">
                    <template #icon><Icon name="plus" /></template>
                </Button>
                <span class="text-2xs text-subtle">
                    The step must write these or it is not finished — a missing or mistyped field costs it an iteration, not the whole run.
                </span>
            </div>
            <span v-else class="text-2xs text-subtle">
                {{
                    step.output.kind === `claim`
                        ? `It writes "done, and here is why". Self-assessed, so pair it with a check below unless the step is cheap.`
                        : `It leaves its work and nothing else. Right for a step whose result is the code — but then it needs a check, or nothing can end it.`
                }}
            </span>
        </div>

        <div class="flex flex-col gap-1.5">
            <span :class="cmp.sectionLabel()">And it is only done when</span>
            <input v-model="command" :class="[cmp.input(), `font-mono`]" placeholder="pnpm test   (optional — a command that must exit 0)" />
            <textarea
                v-model="rubric"
                :class="cmp.input()"
                rows="2"
                placeholder="Optional: a rubric for a reviewer that did none of this work."
            ></textarea>
        </div>

        <div v-if="others.length > 0" class="flex flex-col gap-1.5">
            <span :class="cmp.sectionLabel()">After</span>
            <div class="flex flex-wrap gap-1.5">
                <button
                    v-for="other in others"
                    :key="other.id"
                    type="button"
                    :class="[
                        `cursor-pointer rounded-full border px-2 py-0.5 text-2xs`,
                        step.needs.includes(other.id) ? `border-link bg-link/10 text-link` : `border-line text-subtle hover:border-line-strong`,
                    ]"
                    @click="toggleNeed(other.id)"
                >
                    {{ other.title }}
                </button>
            </div>
            <span v-if="step.needs.length === 0" class="text-2xs text-subtle">Nothing selected — this step starts when the run starts.</span>
        </div>

        <div v-if="step.needs.length > 0" class="flex flex-col gap-1.5">
            <span :class="cmp.sectionLabel()">Starting from</span>
            <Segmented :model-value="step.handoff" :options="HANDOFF_OPTIONS" @update:model-value="patch({ handoff: $event })" />
            <span class="text-2xs text-subtle">{{ handoffNote }}</span>
        </div>

        <!-- The ceilings, together and pre-filled, because they are only read as a group: "how far can this step
             go before it gives up". Every one of them ends the step without meeting its goal. -->
        <div class="flex flex-col gap-1.5">
            <span :class="cmp.sectionLabel()">Give up after</span>
            <div class="grid grid-cols-3 gap-2">
                <label class="flex flex-col gap-1">
                    <input
                        :value="step.maxIterations"
                        type="number"
                        min="1"
                        max="50"
                        :class="cmp.input()"
                        @input="patch({ maxIterations: Number(($event.target as HTMLInputElement).value) })"
                    />
                    <span class="text-2xs text-subtle">rounds</span>
                </label>
                <label class="flex flex-col gap-1">
                    <input
                        :value="step.maxSpendUsd"
                        type="number"
                        min="0.5"
                        step="0.5"
                        :class="cmp.input()"
                        @input="patch({ maxSpendUsd: Number(($event.target as HTMLInputElement).value) })"
                    />
                    <span class="text-2xs text-subtle">dollars</span>
                </label>
                <label class="flex flex-col gap-1">
                    <input
                        :value="step.stallLimit"
                        type="number"
                        min="1"
                        max="10"
                        :class="cmp.input()"
                        @input="patch({ stallLimit: Number(($event.target as HTMLInputElement).value) })"
                    />
                    <span class="text-2xs text-subtle">idle rounds</span>
                </label>
            </div>
            <div class="flex items-center gap-2">
                <span :class="cmp.sectionLabel()">Memory between rounds</span>
                <Segmented :model-value="step.context" :options="CONTEXT_OPTIONS" @update:model-value="patch({ context: $event })" />
            </div>
        </div>
    </div>
</template>
