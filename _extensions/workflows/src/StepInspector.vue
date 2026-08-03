<script setup lang="ts">
import { Button, Checkbox, cmp, Icon, ProseField, Segmented, Select } from "@intentic/extension-ui";
import {
    type CatalogOption,
    HARNESSES,
    ModelsSchema,
    modelsFor,
    type OutputField,
    providerLabel,
    PROVIDERS,
    type WorkflowStep,
} from "@intentic/sandbox-contract";
import { useQuery } from "@tanstack/vue-query";
import { computed, ref } from "vue";
import { host } from "./host";

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
 *
 * AND THE TWO QUESTIONS ARE SET AS A DOCUMENT, NOT AS A FORM — the same decision, for the same reason, as the
 * acceptance extension's story panel (see StoryRow, which has the long version). A step's prompt is the only
 * real PROSE in this extension: it is the paragraph handed to an agent verbatim, it is written and rewritten,
 * and it was being typed into a 5-row bordered box that showed a third of it and scrolled the rest. Three
 * stacked boxes of that kind on one panel is a form, and it drew its borders in the same colour as the surface
 * behind them — chrome with no figure/ground to show for it.
 *
 * So the top of this panel is a heading and two passages: no borders, no fixed heights, each field as tall as
 * what has been typed into it (<ProseField> — it grows without JavaScript, and the note there says why that
 * matters more than it sounds). The panel is a resizable pane precisely so those passages can be given room.
 *
 * THE FOLD BELOW IS STILL A FORM, and deliberately still looks like one. An output field's name and type, a
 * shell command, three numeric ceilings — those are values, not sentences, and dressing them as prose would be
 * the same mistake in the other direction. The line between the tiers IS the rule under "Advanced". */

const step = defineModel<WorkflowStep>({ required: true });
const emit = defineEmits<{ remove: [] }>();

const advanced = ref(false);

const patch = (over: Partial<WorkflowStep>): void => {
    step.value = { ...step.value, ...over };
};

const TITLE_HINT = `Fix the failing tests`;
const PROMPT_HINT = `Run the tests, take the top failure, understand it, fix the code.`;
const GOAL_HINT = `The whole test suite passes.`;
const RUBRIC_HINT = `A rubric for a reviewer that did none of this work.`;

// The document's three passages, as writable views onto the step. `patch` is what keeps every edit a whole
// new step object, which is what the designer's undo-free draft model depends on.
const title = computed({ get: () => step.value.title, set: (value: string) => patch({ title: value }) });
const prompt = computed({ get: () => step.value.prompt, set: (value: string) => patch({ prompt: value }) });
const goal = computed({ get: () => step.value.goal, set: (value: string) => patch({ goal: value }) });

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

/* WHICH MODEL RUNS THIS STEP — the one thing on a step that is about the agent rather than about the work.
 *
 * Unpinned by default, and that default is the honest one: a step naming no provider runs on whatever the user
 * normally uses, so a workflow does not quietly stop working when they change providers or when one is not
 * connected. Pinning is for the graphs where the model IS the design — two attempts at one brief on two
 * different models, a judge from a family that wrote neither — and there the pin has to be READABLE without
 * opening this fold, which is why it reaches the summary line below and the node card (workflowDag).
 */
const UNPINNED = ``;
const providerOptions: CatalogOption[] = [{ value: UNPINNED, label: `Whatever you normally use` }, ...PROVIDERS];

// Only codex/grok have both a native runtime and a routed one to switch between. Claude IS the Claude Code
// loop, and kimi/gemini only ever run on it — so none of the three has a harness to choose.
const harnessChoosable = computed(() => step.value.agent === `codex` || step.value.agent === `grok`);

// The pinned provider's live model list, fetched only while a provider is pinned: with none, there is no
// catalog to pick from and the row is not drawn at all. Keyed by provider alone — the ids are the same under
// either harness, since codex/grok route the same subscription models through the translator.
const liveModels = useQuery({
    queryKey: computed(() => host().sandbox.key(`agent-models`, step.value.agent ?? UNPINNED)),
    queryFn: async (): Promise<CatalogOption[]> =>
        ModelsSchema.parse(await host().sandbox.json(`/${step.value.agent}/models`)).models.map((model) => ({ value: model.id, label: model.label })),
    enabled: computed(() => host().sandbox.reachable() && step.value.agent !== undefined),
});
const modelOptions = computed<CatalogOption[]>(() => [
    { value: UNPINNED, label: `The provider's own default` },
    ...(liveModels.data.value ?? modelsFor(step.value.agent ?? UNPINNED)).filter((option) => option.value !== UNPINNED),
]);

// A provider switch invalidates both choices under it: a model id belongs to one provider's catalog, and a
// harness only means anything on the two providers that have two of them.
const setAgent = (agent: string): void => patch({ agent: agent === UNPINNED ? undefined : agent, model: undefined, harness: undefined });

/* What the folded section is currently hiding, in the fewest words that name it. Empty ⇒ everything inside is
 * still at its default and the fold is costing the reader nothing. This is what makes hiding safe: you can see
 * that a step has a test gate without opening anything, and the disclosure stops being somewhere things go to
 * be forgotten. */
const advancedSummary = computed(() => {
    const parts: string[] = [];
    // The model leads, because it is the one thing in here that changes WHO does the step rather than how.
    if (step.value.agent !== undefined) {
        parts.push(providerLabel(step.value.agent));
    }
    if (step.value.model !== undefined) {
        parts.push(step.value.model);
    }
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
    <!-- `cursor-text` over the whole document: the page under the words is what says "write here", now that no
         field draws a box to say it. The measure is capped because the pane is draggable — an unbounded prompt
         at 700px runs past where the eye finds the start of the next line. -->
    <div class="h-full cursor-text overflow-y-auto px-4 py-5">
        <div class="flex max-w-[68ch] flex-col text-sm">
            <!-- The step's name, at the size a heading is. Delete sits beside it rather than in a toolbar: it
                 is the one action that belongs to this step and to nothing else on the page. -->
            <div class="-mx-2 flex items-start gap-1">
                <ProseField v-model="title" variant="heading" :placeholder="TITLE_HINT" class="min-w-0 flex-1" />
                <button
                    type="button"
                    v-tooltip.top="`Delete this step`"
                    :class="cmp.iconButton(`mt-1 text-danger`)"
                    aria-label="Delete step"
                    @click="emit(`remove`)"
                >
                    <Icon name="trash" />
                </button>
            </div>

            <!-- The instructions, directly under the heading and unlabelled — this IS the step, and a form
                 label over it would be describing what the words already are. Handed to the agent verbatim. -->
            <ProseField v-model="prompt" :placeholder="PROMPT_HINT" class="-mx-2 mt-3 min-h-24" />

            <div class="mt-5 flex items-baseline justify-between border-t border-line/60 pt-4">
                <h3 class="text-sm font-semibold text-content">Done when</h3>
                <span class="text-2xs text-subtle">restated every round</span>
            </div>
            <ProseField v-model="goal" :placeholder="GOAL_HINT" class="-mx-2 mt-1 min-h-12" />
            <p class="px-0.5 text-2xs text-subtle">It repeats until this is true.</p>

            <!-- Everything else. Shut by default, and it says what it is holding so shutting it is safe. The
                 rule above it is the seam between the two tiers: prose above, values below. -->
            <button
                type="button"
                class="mt-5 flex cursor-pointer items-center gap-2 border-t border-line/60 pt-4 text-left"
                :aria-expanded="advanced"
                @click="advanced = !advanced"
            >
                <Icon :name="advanced ? `chevron-down` : `chevron-right`" class="shrink-0 text-2xs text-subtle" />
                <span class="shrink-0 text-sm font-semibold text-content">Advanced</span>
                <span class="min-w-0 flex-1 truncate text-right text-2xs text-subtle">{{ advancedSummary }}</span>
            </button>

            <div v-if="advanced" class="mt-3 flex flex-col gap-4">
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
                    <!-- A shell command is a VALUE, so it keeps its box; the rubric beside it is a paragraph
                         somebody writes, so it does not. That is the whole rule this panel is typeset on. -->
                    <input v-model="command" :class="[cmp.input(), `font-mono`]" placeholder="pnpm test" />
                    <!-- Not bled out to the section's edge the way the passages above are: down here it has
                         boxed siblings, and a field hanging 8px to their left reads as a caption on the one
                         above it rather than as a field of its own. -->
                    <ProseField v-model="rubric" :placeholder="RUBRIC_HINT" class="min-h-12" />
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

                <div class="flex flex-col gap-1.5">
                    <span :class="cmp.sectionLabel()">Runs on</span>
                    <Select
                        :model-value="step.agent ?? UNPINNED"
                        :options="providerOptions"
                        option-label="label"
                        option-value="value"
                        size="small"
                        @update:model-value="setAgent($event)"
                    />
                    <!-- The harness (the agentic loop), orthogonal to the provider — same semantics as the
                         chat's own picker, and shown only where there is genuinely a choice. -->
                    <Segmented
                        v-if="harnessChoosable"
                        :model-value="step.harness ?? `native`"
                        :options="HARNESSES"
                        @update:model-value="patch({ harness: $event })"
                    />
                    <Select
                        v-if="step.agent !== undefined"
                        :model-value="step.model ?? UNPINNED"
                        :options="modelOptions"
                        option-label="label"
                        option-value="value"
                        size="small"
                        @update:model-value="patch({ model: $event === UNPINNED ? undefined : $event })"
                    />
                    <span class="text-2xs text-subtle">
                        Pin one where the model is part of the design — two steps on two providers is how you compare them. Left alone, this step runs
                        on whatever you normally use.
                    </span>
                </div>
            </div>
        </div>
    </div>
</template>
