<script setup lang="ts">
import { Button, Checkbox, cmp, Icon, Segmented, Select } from "@intentic/extension-ui";
import type { OutputField, WorkflowStep } from "@intentic/sandbox-contract";
import { computed, ref } from "vue";

/* THE SELECTED STEP — two questions, and everything else folded away.
 *
 * WHAT CHANGED AND WHY. This panel used to show eight sections at once: the two prose fields, the output
 * shape, its field table, two checks, the dependency picker, the handoff, the memory mode and three ceilings.
 * All of it, for a step whose author almost always wanted to type one sentence. A form that asks nine
 * questions to accept one is not thorough, it is a wall — and it made a simple workflow feel like configuring
 * a build server.
 *
 * SO THE PANEL ASKS TWO THINGS: what this step does, and how you will know it is finished. Everything else
 * has a default that runs (see workflowEdit's DEFAULTS), and lives behind one disclosure that stays shut until
 * somebody has a reason to open it. The disclosure SAYS WHAT IS INSIDE IT when it differs from the default —
 * a folded section that hides a `pnpm test` gate somebody set last week is worse than no folding at all.
 *
 * TWO THINGS LEFT THE PANEL ENTIRELY, and both went somewhere better:
 *  · the dependency picker — you draw dependencies on the canvas now, which is what a canvas is for.
 *  · the handoff — it belongs to the EDGE, and the canvas draws it (solid = same session, dashed = new one).
 *    A property of the line between two steps was never a field on one of them.
 */

const step = defineModel<WorkflowStep>({ required: true });
const emit = defineEmits<{ remove: [] }>();

const advanced = ref(false);

const patch = (over: Partial<WorkflowStep>): void => {
    step.value = { ...step.value, ...over };
};

const OUTPUT_OPTIONS = [
    { value: `none` as const, label: `Nothing` },
    { value: `claim` as const, label: `A claim` },
    { value: `json` as const, label: `Data` },
];
const CONTEXT_OPTIONS = [
    { value: `fresh` as const, label: `Fresh each round` },
    { value: `continue` as const, label: `Keep the thread` },
];
const TYPE_OPTIONS: { label: string; value: OutputField["type"] }[] = [
    { label: `text`, value: `string` },
    { label: `number`, value: `number` },
    { label: `yes/no`, value: `boolean` },
    { label: `list of text`, value: `string[]` },
];

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

/* One command and one judge at most: a step wanting two commands wants `a && b`, and a step wanting two judges
 * is asking one model the same question twice. Emptying either field removes it rather than storing a blank —
 * a check that checks nothing would be a check the graph claims to have. */
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

/* What the folded section is currently hiding, in the fewest words that name it. Empty ⇒ everything inside is
 * still at its default and the fold is costing the reader nothing. This is what makes hiding safe: you can see
 * that a step has a test gate without opening anything, and the disclosure stops being somewhere things go to
 * be forgotten. */
const advancedSummary = computed(() => {
    const parts: string[] = [];
    if (step.value.output.kind === `json`) {
        parts.push(`${step.value.output.fields.length} data field${step.value.output.fields.length === 1 ? `` : `s`}`);
    }
    if (step.value.output.kind === `none`) {
        parts.push(`no written output`);
    }
    for (const check of step.value.checks) {
        parts.push(check.kind === `command` ? `runs \`${check.command}\`` : `a reviewer`);
    }
    if (step.value.context === `continue`) {
        parts.push(`keeps its thread`);
    }
    if (step.value.maxIterations !== 8) {
        parts.push(`${step.value.maxIterations} rounds`);
    }
    return parts.join(` · `);
});
</script>

<template>
    <div class="flex h-full flex-col gap-3 overflow-y-auto p-3">
        <div class="flex items-center gap-2">
            <input
                :value="step.title"
                :class="[cmp.input(), `flex-1 font-medium`]"
                placeholder="What this step is called"
                @input="patch({ title: ($event.target as HTMLInputElement).value })"
            />
            <button
                type="button"
                v-tooltip.top="`Delete this step`"
                :class="cmp.iconButton(`text-danger`)"
                aria-label="Delete step"
                @click="emit(`remove`)"
            >
                <Icon name="trash" />
            </button>
        </div>

        <!-- Tier one: the two sentences. Nothing else is required to have a step that runs. -->
        <label class="flex flex-col gap-1">
            <span :class="cmp.sectionLabel()">What it does</span>
            <textarea
                :value="step.prompt"
                :class="cmp.input()"
                rows="5"
                placeholder="Run the tests, take the top failure, understand it, fix the code."
                @input="patch({ prompt: ($event.target as HTMLTextAreaElement).value })"
            ></textarea>
        </label>

        <label class="flex flex-col gap-1">
            <span :class="cmp.sectionLabel()">Done when</span>
            <textarea
                :value="step.goal"
                :class="cmp.input()"
                rows="3"
                placeholder="The whole test suite passes."
                @input="patch({ goal: ($event.target as HTMLTextAreaElement).value })"
            ></textarea>
            <span class="text-2xs text-subtle">Restated to the agent every round — it repeats until this is true.</span>
        </label>

        <!-- Everything else. Shut by default, and it says what it is holding so shutting it is safe. -->
        <div class="rounded-lg border border-line">
            <button
                type="button"
                class="flex w-full cursor-pointer items-center gap-2 px-2.5 py-2 text-left"
                :aria-expanded="advanced"
                @click="advanced = !advanced"
            >
                <Icon :name="advanced ? `chevron-down` : `chevron-right`" class="shrink-0 text-2xs text-subtle" />
                <span :class="cmp.sectionLabel()">Advanced</span>
                <span class="min-w-0 flex-1 truncate text-2xs text-subtle">{{ advancedSummary }}</span>
            </button>

            <div v-if="advanced" class="flex flex-col gap-3 border-t border-line p-2.5">
                <div class="flex flex-col gap-1.5">
                    <span :class="cmp.sectionLabel()">What it hands on</span>
                    <Segmented v-model="outputKind" :options="OUTPUT_OPTIONS" />
                    <div v-if="step.output.kind === `json`" class="flex flex-col gap-1.5">
                        <div v-for="(field, index) in fields" :key="index" class="flex flex-wrap items-start gap-1.5">
                            <input
                                :value="field.name"
                                :class="[cmp.input(), `w-24 font-mono text-2xs`]"
                                placeholder="name"
                                @input="patchField(index, { name: ($event.target as HTMLInputElement).value })"
                            />
                            <Select
                                :model-value="field.type"
                                :options="TYPE_OPTIONS"
                                option-label="label"
                                option-value="value"
                                size="small"
                                class="w-28"
                                @update:model-value="patchField(index, { type: $event })"
                            />
                            <input
                                :value="field.description"
                                :class="[cmp.input(), `min-w-36 flex-1`]"
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
                    </div>
                    <span v-else class="text-2xs text-subtle">
                        {{
                            step.output.kind === `claim`
                                ? `It writes "done, and here is why" — self-assessed, so pair it with a check below on anything expensive.`
                                : `It leaves its work and nothing else, so it needs a check below or nothing can tell it it is finished.`
                        }}
                    </span>
                </div>

                <div class="flex flex-col gap-1.5">
                    <span :class="cmp.sectionLabel()">And only done when</span>
                    <input v-model="command" :class="[cmp.input(), `font-mono`]" placeholder="pnpm test" />
                    <textarea
                        v-model="rubric"
                        :class="cmp.input()"
                        rows="2"
                        placeholder="A rubric for a reviewer that did none of this work."
                    ></textarea>
                </div>

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
                    <span class="text-2xs text-subtle"
                        >An idle round changed nothing in the tree — that, not an error, is how a step usually goes wrong.</span
                    >
                </div>

                <div class="flex flex-col gap-1.5">
                    <span :class="cmp.sectionLabel()">Memory between rounds</span>
                    <Segmented :model-value="step.context" :options="CONTEXT_OPTIONS" @update:model-value="patch({ context: $event })" />
                </div>
            </div>
        </div>
    </div>
</template>
