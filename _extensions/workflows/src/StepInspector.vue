<script setup lang="ts">
import { Button, Checkbox, ui, Icon, Picker, type PickerOption, ProseField, SegmentedControl } from "@intentic/extension-ui";
import { HARNESSES, type OutputField, providerLabel, type WorkflowStep } from "@intentic/sandbox-contract";
import { computed, ref } from "vue";
import { host } from "./host";
import { usePersonas } from "./usePersonas";

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
// Both hints lead with what LEAVING IT EMPTY does, because that is now the common answer and an empty box
// that looks unfinished is one people fill in with a paraphrase of the request — which is the wrapper this
// default exists to remove, retyped by hand.
const PROMPT_HINT = `Empty — this step does whatever the run was asked to do. Or give it a job of its own: "run the tests, take the top failure, fix it".`;
const GOAL_HINT = `Empty — measured against what the run was asked to do. Or set its own bar: "the whole test suite passes".`;
const RUBRIC_HINT = `A rubric for a reviewer that did none of this work.`;

/* The document's three passages, as writable views onto the step. `patch` is what keeps every edit a whole new
 * step object, which is what the designer's undo-free draft model depends on.
 *
 * AN EMPTY FIELD IS ABSENT, NOT EMPTY. A step that declares no prompt and no goal is handed what the person
 * typed when they started the run, verbatim (WorkflowStepSchema) — which is the default and the reason these
 * two boxes can be left alone. Storing `` instead would mean "this step declares an empty instruction": the
 * schema refuses it on save, and it is not what clearing a box means to anyone who does it. */
const declared = (value: string): string | undefined => (value.trim() === `` ? undefined : value);

/* Whether this step is a LOOP or a single session, which is the one fact that changes what half this panel
 * means. A step with nothing to produce and nothing to check ends when its turn ends (loop-stop answers `done`
 * for a `none` output), so for it there is no round to restate a goal every, no iteration to number, and no
 * ceiling to approach. Declaring either is what buys the repetition — and its cost, which is that the step can
 * now fail for not satisfying what it declared. */
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
 *
 * IT IS THE SHELL'S PICKER, not a control of this extension's own, and the two dropdowns it replaces are the
 * argument for that being an API rather than a widget. A provider `<Select>` over the static PROVIDERS list and
 * a model `<Select>` behind it, fed by a `/{provider}/models` fetch this extension made itself, offered rows in
 * an order nothing had ranked, said nothing about which providers the sandbox actually holds a credential for,
 * knew nothing of a configured model endpoint or an installed ACP agent, and asked for the provider first —
 * which is the one question a person choosing a model does not have in mind. `api.models.pick` hands over the
 * app's own list: searchable across every provider at once, connected ones first, locked ones marked with what
 * they would cost, and one gesture to a (provider, model) pair.
 *
 * PINNING IS NOW A PAIR, where the provider alone used to be pinnable with the version left to the provider's
 * default. That default has not gone anywhere — a step saved without a model still runs on it, and the chip
 * says so — there is simply no longer a control for choosing it, because the picker's list is LIVE: what it
 * offers is what this subscription serves today, which is the thing "the provider's own default" was standing
 * in for.
 */

// Only codex/grok have both a native runtime and a routed one to switch between. Claude IS the Claude Code
// loop, and kimi/gemini only ever run on it — so none of the three has a harness to choose.
const harnessChoosable = computed(() => step.value.agent === `codex` || step.value.agent === `grok`);

/* What the chip reads. Three states, and the middle one is the reason it is not simply the model id: a step
 * saved with a provider and no version — every step of the shipped template — is pinned to a family, not to a
 * model, and naming the family is the true thing to say about it.
 *
 * A pinned version shows as its raw id, because the label belongs to the catalog and the catalog belongs to the
 * shell: holding one here to pretty-print a stored pin is the duplication `api.models` exists to end, and a
 * cached label is a label that goes stale the day the provider renames a model. */
const described = computed(() => {
    if (step.value.agent === undefined) {
        return host().models.agentRun();
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

// The element the shell hangs its picker off — a popover on desktop, a sheet on mobile; the host decides.
const chip = ref<HTMLElement>();

/* Open the picker on what this step is holding, or — unpinned — on the model a run would spend anyway, so the
 * list opens with the checkmark on the row this step is effectively already using rather than on nothing. */
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

/* WHO THE STEP IS when it reaches outside — the chat composer's persona pill, as a form row. A step is an
 * unattended turn, and unattended-with-no-persona deliberately reaches no logged-in account at all; pinning a
 * card is how a release check gets the folder scope, toolbox and account set its owner already wrote down.
 * The cards are authored on the Personas page — this is only a pointer at one. */
const { personas } = usePersonas();

/* NOBODY IS A REAL ROW, not grey placeholder text, and that swap is the whole of this control's redesign. A
 * placeholder cannot be TICKED: the panel marks the row whose value matches the current one, and an absent value
 * matches no row, so the commonest setting of this field was the one setting the open list refused to confirm —
 * you opened it, saw nothing marked, and could not tell whether the step was pinned to a card you had scrolled
 * past. It also has something to SAY that an absence cannot: unattended-with-nobody reaches no logged-in account
 * at all, which is the opposite of what an empty persona means in a chat.
 *
 * Empty string is the row's value only because a picker option is keyed by a string. The step keeps storing
 * `undefined`, which is what the daemon means by nobody, and this is the one place that translates.
 *
 * PICKING IT IS UNPINNING, so the separate unpin button beside the field is gone. Two controls for one setting
 * is how a panel teaches that the pick does not fully commit — and the button could only ever undo, while the
 * row can also confirm. */
const NOBODY = ``;
const actsAs = computed<string>({
    get: () => step.value.actsAs ?? NOBODY,
    set: (value: string) => patch({ actsAs: value === NOBODY ? undefined : value }),
});

/* `face` is what turns a row into a PERSON: the picker draws the card's own derived character in the row and
 * again in the closed field, so a step's speaker is recognised the same way here as on the Personas page and in
 * the chat. Nobody keeps a glyph — an empty ring above a column of faces is what says "none of these" before
 * either label has been read. */
const personaOptions = computed<readonly PickerOption[]>(() => [
    { value: NOBODY, label: `Nobody`, description: `full tools, no accounts`, icon: `circle` as const },
    ...personas.value.map((persona) => ({ value: persona.id, label: persona.label ?? persona.id, face: persona })),
]);
const personaLabel = (id: string): string => personas.value.find((persona) => persona.id === id)?.label ?? id;

const setMaxSpend = (value: string): void => {
    const trimmed = value.trim();
    patch({ maxSpendUsd: trimmed === `` ? undefined : Number(trimmed) });
};

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
    <!-- `cursor-text` over the whole document: the page under the words is what says "write here", now that no
         field draws a box to say it. The measure is capped because the pane is draggable — an unbounded prompt
         at 700px runs past where the eye finds the start of the next line. -->
    <div class="h-full cursor-text overflow-y-auto px-4 py-5">
        <div class="flex max-w-read flex-col text-sm">
            <!-- The step's name, at the size a heading is. Delete sits beside it rather than in a toolbar: it
                 is the one action that belongs to this step and to nothing else on the page. -->
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

            <!-- The instructions, directly under the heading and unlabelled — this IS the step, and a form
                 label over it would be describing what the words already are. Handed to the agent verbatim. -->
            <ProseField v-model="prompt" :placeholder="PROMPT_HINT" class="-mx-2 mt-3 min-h-24" />

            <div class="mt-5 flex items-baseline justify-between border-t border-line/60 pt-4">
                <h3 class="text-sm font-semibold text-content">Done when</h3>
                <span v-if="repeats" class="text-2xs text-subtle">restated every round</span>
            </div>
            <ProseField v-model="goal" :placeholder="GOAL_HINT" class="-mx-2 mt-1 min-h-12" />
            <!-- What this line says depends on whether the step REPEATS, because for most steps it does not and
                 "it repeats until this is true" was simply false. A step is one session finished when the
                 session is; asking it for an output or a check is what turns it into a loop, and only then is
                 the goal a bar it is measured against over and over. -->
            <p class="px-0.5 text-2xs text-subtle">
                {{
                    repeats
                        ? `It repeats until this is true.`
                        : `One session, finished when it finishes. Ask for an output or a check below to make it repeat until this is true.`
                }}
            </p>

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
                    <span :class="ui.sectionLabel()">What it hands on</span>
                    <SegmentedControl v-model="outputKind" :options="OUTPUT_OPTIONS" />
                    <div v-if="step.output.kind === `json`" class="flex flex-col gap-1.5">
                        <div v-for="(field, index) in fields" :key="index" class="flex flex-wrap items-start gap-1.5">
                            <input
                                :value="field.name"
                                :class="[ui.input(), `w-24 font-mono text-2xs`]"
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
                                placeholder="what belongs here — the model reads this"
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
                                ? `It writes "done, and here is why" — self-assessed, so pair it with a check below on anything expensive.`
                                : `It leaves its work and nothing else, so it needs a check below or nothing can tell it it is finished.`
                        }}
                    </span>
                </div>

                <div class="flex flex-col gap-1.5">
                    <span :class="ui.sectionLabel()">And only done when</span>
                    <!-- A shell command is a VALUE, so it keeps its box; the rubric beside it is a paragraph
                         somebody writes, so it does not. That is the whole rule this panel is typeset on. -->
                    <input v-model="command" :class="[ui.input(), `font-mono`]" placeholder="pnpm test" />
                    <!-- Not bled out to the section's edge the way the passages above are: down here it has
                         boxed siblings, and a field hanging 8px to their left reads as a caption on the one
                         above it rather than as a field of its own. -->
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
                    <!-- A chip rather than a field, and the same chip the acceptance extension's run pill uses:
                         it NAMES a choice and opens the app's own picker, where a boxed input would be claiming
                         this panel holds a catalog. Unpin sits beside it and only exists once there is a pin —
                         the unpinned chip is already the "no pin" state and needs nothing to clear. -->
                    <div class="flex items-center gap-1.5">
                        <button
                            ref="chip"
                            type="button"
                            class="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-lg border border-line px-2.5 py-1.5 text-left text-xs text-content transition-colors hover:border-line-strong"
                            :aria-label="`Model for this step: ${pinLabel}`"
                            @click="choose"
                        >
                            <Icon name="sparkles" class="shrink-0 text-subtle" />
                            <span class="min-w-0 flex-1 truncate" :class="{ 'text-muted': step.agent === undefined }">{{ pinLabel }}</span>
                            <Icon name="chevron-down" class="shrink-0 text-2xs text-subtle" />
                        </button>
                        <button
                            v-if="step.agent !== undefined"
                            type="button"
                            v-tooltip.top="`Unpin — run this step on whatever you normally use`"
                            :class="ui.iconButton()"
                            aria-label="Unpin the model"
                            @click="unpin"
                        >
                            <Icon name="times" />
                        </button>
                    </div>
                    <!-- The harness (the agentic loop), orthogonal to the provider — same semantics as the
                         chat's own picker, and shown only where there is genuinely a choice. -->
                    <SegmentedControl
                        v-if="harnessChoosable"
                        :model-value="step.harness ?? `native`"
                        :options="HARNESSES"
                        @update:model-value="patch({ harness: $event })"
                    />
                    <span class="text-2xs text-subtle">
                        Pin one where the model is part of the design — two steps on two providers is how you compare them. Left alone, this step runs
                        on whatever you normally use.
                    </span>
                </div>

                <div class="flex flex-col gap-1.5">
                    <span :class="ui.sectionLabel()">Acts as</span>
                    <Picker v-model="actsAs" :options="personaOptions" aria-label="Persona for this step" class="w-full text-xs" />
                    <span class="text-2xs text-subtle">
                        A step runs with nobody at the keyboard, so it reaches no logged-in account unless it acts as a persona — the card also sets
                        how far its tools go and where it works.
                    </span>
                </div>
            </div>
        </div>
    </div>
</template>
