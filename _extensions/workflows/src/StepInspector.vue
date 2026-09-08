<script setup lang="ts">
import { Button, Checkbox, ui, Icon, Picker, type PickerOption, ProseField, SegmentedControl, vAction } from "@intentic/extension-ui";
import { HARNESSES, type OutputField, providerLabel, type WorkflowStep } from "@intentic/sandbox-contract";
import { computed, ref } from "vue";
import { host } from "./host";
import { usePersonas } from "./usePersonas";

// Step panel asks two things: what it does (prompt) and how it's known done (goal), rendered as prose via
// `<ProseField>`, not bordered fields. Everything else defaults and sits behind Advanced, whose summary names anything
// non-default. Dependencies and handoff live on the canvas edges now (solid = same session, dashed = new one), not
// here.

const step = defineModel<WorkflowStep>({ required: true });
const emit = defineEmits<{ remove: [] }>();

const advanced = ref(false);

const patch = (over: Partial<WorkflowStep>): void => {
    step.value = { ...step.value, ...over };
};

const TITLE_HINT = `Fix the failing tests`;
// Hints lead with what leaving the field empty does, since that's the common case.
const PROMPT_HINT = `Empty, this step does whatever the run was asked to do. Or give it a job of its own: "run the tests, take the top failure, fix it".`;
const GOAL_HINT = `Empty, measured against what the run was asked to do. Or set its own bar: "the whole test suite passes".`;
const RUBRIC_HINT = `A rubric for a reviewer that did none of this work.`;

// Converts blank to undefined; a step with no prompt/goal falls back to the run's own request, and the schema refuses a
// stored empty string.
const declared = (value: string): string | undefined => (value.trim() === `` ? undefined : value);

// True once the step declares an output or a check, which is what makes it repeat.
const repeats = computed(() => step.value.output.kind !== `none` || step.value.checks.length > 0);
const title = computed({ get: () => step.value.title, set: (value: string) => patch({ title: value }) });
const prompt = computed({ get: () => step.value.prompt ?? ``, set: (value: string) => patch({ prompt: declared(value) }) });
const goal = computed({ get: () => step.value.goal ?? ``, set: (value: string) => patch({ goal: declared(value) }) });

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

const newField = (existing: readonly OutputField[] = []): OutputField => {
    const names = new Set(existing.map((field) => field.name));
    let suffix = 1;
    while (names.has(suffix === 1 ? `result` : `result_${suffix}`)) {
        suffix += 1;
    }
    return { name: suffix === 1 ? `result` : `result_${suffix}`, type: `string`, description: ``, required: true };
};

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

// At most one command and one judge check; clearing a field removes it rather than storing a blank check.
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

// Model pin: unpinned by default so a workflow keeps working if the user switches providers. The chip opens the shell's
// own `api.models.pick`, not a local provider/model dropdown pair.

// Only codex and grok have both a native and routed runtime to choose between.
const harnessChoosable = computed(() => step.value.agent === `codex` || step.value.agent === `grok`);

// Provider with no version pins to that family; a pinned version shows its raw id, not a cached label.
const described = computed(() => {
    if (step.value.agent === undefined) {
        // `loop-iteration` matches how workflow-runner.ts actually executes an unpinned step's turns.
        return host().models.agentRun(`loop-iteration`);
    }
    return host().models.describe({
        provider: step.value.agent,
        model: step.value.model ?? ``,
        ...(step.value.account !== undefined ? { account: step.value.account } : {}),
        ...(step.value.harness !== undefined ? { harness: step.value.harness } : {}),
    });
});
const pinLabel = computed(() => {
    if (step.value.agent === undefined) {
        return `Whatever you normally use`;
    }
    return [described.value.label || providerLabel(step.value.agent), described.value.accountLabel].filter((part) => part !== undefined).join(` · `);
});

// Anchor element the shell hangs its model picker off (popover or sheet, the host decides).
const chip = ref<HTMLElement>();

// Opens the picker pre-selected on this step's pin, or on the model an unpinned run would actually use.
const choose = async (): Promise<void> => {
    if (chip.value === undefined) {
        return;
    }
    const from = described.value;
    const next = await host().models.pick({
        anchor: chip.value,
        provider: from.provider,
        model: from.model,
        ...(step.value.account !== undefined ? { account: step.value.account } : {}),
        ...(step.value.harness !== undefined ? { harness: step.value.harness } : {}),
    });
    if (next === undefined) {
        return;
    }
    const harness = HARNESSES.find((entry) => entry.value === next.harness)?.value;
    patch({ agent: next.provider, model: next.model, account: next.account, harness });
};

const unpin = (): void => patch({ agent: undefined, model: undefined, account: undefined, harness: undefined });

// Persona this step acts as; unattended with no persona reaches no logged-in account. Cards are authored on the
// Personas page, this only points at one.
const { personas } = usePersonas();

// Nobody is a real, selectable row (not a placeholder) so the field can show it checked; the step still stores
// `undefined`, `` is only the picker's key. Picking any row unpins, so there's no separate unpin control here.
const NOBODY = ``;
const actsAs = computed<string>({
    get: () => step.value.actsAs ?? NOBODY,
    set: (value: string) => patch({ actsAs: value === NOBODY ? undefined : value }),
});

// `face` renders each persona's own character, matching the Personas page and chat; Nobody gets a plain icon.
const personaOptions = computed<readonly PickerOption[]>(() => [
    { value: NOBODY, label: `Nobody`, description: `full tools, no accounts`, icon: `circle` as const },
    ...personas.value.map((persona) => ({ value: persona.id, label: persona.label ?? persona.id, face: persona })),
]);
const personaLabel = (id: string): string => personas.value.find((persona) => persona.id === id)?.label ?? id;

const setMaxSpend = (value: string): void => {
    const trimmed = value.trim();
    patch({ maxSpendUsd: trimmed === `` ? undefined : Number(trimmed) });
};

// Names what Advanced is currently hiding; empty means everything inside is still at its default.
const advancedSummary = computed(() => {
    const parts: string[] = [];
    // Model comes first: the one setting here that changes who does the step, not how.
    if (step.value.agent !== undefined) {
        parts.push(providerLabel(step.value.agent));
    }
    if (step.value.model !== undefined) {
        parts.push(step.value.model);
    }
    if (step.value.account !== undefined) {
        parts.push(described.value.accountLabel ?? `pinned account`);
    }
    if (step.value.actsAs !== undefined) {
        parts.push(`acts as ${personaLabel(step.value.actsAs)}`);
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
    if (step.value.maxSpendUsd !== undefined) {
        parts.push(`up to $${step.value.maxSpendUsd}`);
    }
    return parts.join(` · `);
});
</script>

<template>
    <!-- `cursor-text` signals "write here" since no field draws a box; the measure is capped so lines stay a comfortable read. -->
    <div class="h-full cursor-text overflow-y-auto px-4 py-5">
        <div class="flex max-w-read flex-col text-sm">
            <!-- Delete sits beside the title rather than in a toolbar, since it's the one action specific to this step. -->
            <div class="-mx-2 flex items-start gap-1">
                <ProseField v-model="title" variant="heading" :placeholder="TITLE_HINT" class="min-w-0 flex-1" />
                <button
                    type="button"
                    v-tooltip.top="`Delete this step`"
                    :class="ui.iconButton(`mt-1 text-danger`)"
                    aria-label="Delete step"
                    @click="emit(`remove`)"
                >
                    <Icon name="trash" />
                </button>
            </div>

            <!-- Unlabelled: this prose is the step itself, and a label would only restate it. Handed to the agent verbatim. -->
            <ProseField v-model="prompt" :placeholder="PROMPT_HINT" class="-mx-2 mt-3 min-h-24" />

            <div class="mt-5 flex items-baseline justify-between border-t border-line/60 pt-4">
                <h3 class="text-sm font-semibold text-content">Done when</h3>
                <span v-if="repeats" class="text-2xs text-subtle">restated every round</span>
            </div>
            <ProseField v-model="goal" :placeholder="GOAL_HINT" class="-mx-2 mt-1 min-h-12" />
            <!-- Wording depends on `repeats`: without an output or check, this step is one session, not a loop. -->
            <p class="px-0.5 text-2xs text-subtle">
                {{
                    repeats
                        ? `It repeats until this is true.`
                        : `One session, finished when it finishes. Ask for an output or a check below to make it repeat until this is true.`
                }}
            </p>

            <!-- Shut by default; the summary line names what's inside so shutting it stays safe. -->
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
                    <span :class="ui.sectionLabel()">What it hands on</span>
                    <SegmentedControl v-model="outputKind" :options="OUTPUT_OPTIONS" />
                    <div v-if="step.output.kind === `json`" class="flex flex-col gap-1.5">
                        <div v-for="(field, index) in fields" :key="index" class="flex flex-wrap items-start gap-1.5">
                            <input
                                :value="field.name"
                                :class="[ui.inputSm(), `w-24 font-mono`]"
                                placeholder="name"
                                @input="patchField(index, { name: ($event.target as HTMLInputElement).value })"
                            />
                            <Picker
                                :model-value="field.type"
                                :options="TYPE_OPTIONS"
                                aria-label="Field type"
                                class="w-28 px-2 py-1 text-2xs"
                                @update:model-value="patchField(index, { type: $event })"
                            />
                            <input
                                :value="field.description"
                                :class="[ui.input(), `min-w-36 flex-1`]"
                                placeholder="what belongs here: the model reads this"
                                @input="patchField(index, { description: ($event.target as HTMLInputElement).value })"
                            />
                            <label class="flex items-center gap-1 pt-1.5 text-2xs text-subtle">
                                <Checkbox :model-value="field.required" binary @update:model-value="patchField(index, { required: $event })" />
                                required
                            </label>
                            <button
                                type="button"
                                :class="ui.iconButton(`text-danger`)"
                                aria-label="Remove field"
                                @click="setFields(fields.filter((_, at) => at !== index))"
                            >
                                <Icon name="trash" />
                            </button>
                        </div>
                        <Button label="Add field" size="small" severity="secondary" :text="true" @click="setFields([...fields, newField(fields)])">
                            <template #icon><Icon name="plus" /></template>
                        </Button>
                    </div>
                    <span v-else class="text-2xs text-subtle">
                        {{
                            step.output.kind === `claim`
                                ? `It writes "done, and here is why": self-assessed, so pair it with a check below on anything expensive.`
                                : `It leaves its work and nothing else, so it needs a check below or nothing can tell it it is finished.`
                        }}
                    </span>
                </div>

                <div class="flex flex-col gap-1.5">
                    <span :class="ui.sectionLabel()">And only done when</span>
                    <!-- A command is a value and keeps its box; the rubric beside it is prose and does not. -->
                    <input v-model="command" :class="[ui.input(), `font-mono`]" placeholder="pnpm test" />
                    <!-- Kept flush with its boxed siblings here, unlike the bled-out passages above. -->
                    <ProseField v-model="rubric" :placeholder="RUBRIC_HINT" class="min-h-12" />
                </div>

                <div class="flex flex-col gap-1.5">
                    <span :class="ui.sectionLabel()">Memory between rounds</span>
                    <SegmentedControl :model-value="step.context" :options="CONTEXT_OPTIONS" @update:model-value="patch({ context: $event })" />
                </div>

                <label class="flex flex-col gap-1.5">
                    <span :class="ui.sectionLabel()">Spend ceiling</span>
                    <span class="flex items-center gap-1.5">
                        <span class="text-xs text-subtle">$</span>
                        <input
                            :value="step.maxSpendUsd ?? ``"
                            type="number"
                            min="0.01"
                            step="0.01"
                            :class="[ui.input(), `w-28 tabular-nums`]"
                            placeholder="No ceiling"
                            @input="setMaxSpend(($event.target as HTMLInputElement).value)"
                        />
                    </span>
                    <span class="text-2xs text-subtle">Across every round of this step. Empty leaves it uncapped.</span>
                </label>

                <div class="flex flex-col gap-1.5">
                    <span :class="ui.sectionLabel()">Runs on</span>
                    <!-- A chip, not a boxed input: this panel holds no model catalog of its own. Unpin shows only once pinned. -->
                    <div class="flex items-center gap-1.5">
                        <button
                            ref="chip"
                            type="button"
                            class="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-lg border border-line px-2.5 py-1.5 text-left text-xs text-content transition-colors hover:border-line-strong"
                            :aria-label="`Model for this step: ${pinLabel}`"
                            v-action="choose"
                        >
                            <Icon name="sparkles" class="shrink-0 text-subtle" />
                            <span class="min-w-0 flex-1 truncate" :class="{ 'text-muted': step.agent === undefined }">{{ pinLabel }}</span>
                            <Icon name="chevron-down" class="shrink-0 text-2xs text-subtle" />
                        </button>
                        <button
                            v-if="step.agent !== undefined"
                            type="button"
                            v-tooltip.top="`Unpin: run this step on whatever you normally use`"
                            :class="ui.iconButton()"
                            aria-label="Unpin the model"
                            @click="unpin"
                        >
                            <Icon name="times" />
                        </button>
                    </div>
                    <!-- Harness choice is orthogonal to the provider, shown only where more than one is possible. -->
                    <SegmentedControl
                        v-if="harnessChoosable"
                        :model-value="step.harness ?? `native`"
                        :options="HARNESSES"
                        @update:model-value="patch({ harness: $event })"
                    />
                    <span class="text-2xs text-subtle">
                        Pin one where the model is part of the design: two steps on two providers is how you compare them. Left alone, this step runs
                        on whatever you normally use.
                    </span>
                </div>

                <div class="flex flex-col gap-1.5">
                    <span :class="ui.sectionLabel()">Acts as</span>
                    <Picker v-model="actsAs" :options="personaOptions" aria-label="Persona for this step" class="w-full text-xs" />
                    <span class="text-2xs text-subtle">
                        A step runs with nobody at the keyboard, so it reaches no logged-in account unless it acts as a persona: the card also sets
                        how far its tools go and where it works.
                    </span>
                </div>
            </div>
        </div>
    </div>
</template>
