<script setup lang="ts">
import { Button, ui, Modal, SegmentedControl } from "@intentic/extension-ui";
import type { LoopCheck, LoopDesign, LoopOutput } from "@intentic/sandbox-contract";
import { computed, ref, watch } from "vue";

/* THE SAVED-LOOP FORM: the long questions about looping, asked ONCE per loop instead of once per use.
 *
 * This is the old composer dialog with its first field removed and a name put in its place, and that swap is
 * the whole redesign. The field it lost was THE GOAL, which is the only thing about a loop that is genuinely
 * different every time, and the one thing the user has already written, in the message box, before they ever
 * reached for the control. Everything that remains is machinery: how it ends, what memory it carries, how far
 * it may go. Machinery is what a saved thing is for.
 *
 * SO IT LIVES ON A PAGE AND NOT ON A COMPOSER. A modal over a chat has to be small enough to answer in the
 * middle of writing a message, which no honest version of this form is; here it is a form on the surface that
 * owns the thing, where a form belongs and where nobody is mid-sentence.
 *
 * THE ORDER IS WHAT THE AUTHOR KNOWS, unchanged from the dialog it replaces: the name, then how it ENDS:
 * the one decision worth thinking about, and the one that decides whether the loop is trustworthy: then the
 * ceilings, pre-filled with defaults that are safe on their own.
 */

const { editing, taken } = defineProps<{
    /** The loop being edited, or undefined for a new one. */
    editing?: LoopDesign;
    /** Names already in use, so a new loop can say so before the save round-trips a refusal. */
    taken: readonly string[];
}>();
const open = defineModel<boolean>({ required: true });
const emit = defineEmits<{ save: [design: Omit<LoopDesign, "id">] }>();

const name = ref(``);
const description = ref(``);
const instruction = ref(``);
const context = ref<LoopDesign["context"]>(`fresh`);
const stopKind = ref<`command` | `claim` | `judge`>(`command`);
const command = ref(``);
const rubric = ref(``);
const maxIterations = ref(8);
const maxSpendUsd = ref(5);
const stallLimit = ref(2);

/* Every open reloads the form from the loop it was opened on, or clears it for a new one. Immediate, because
 * the dialog is mounted once and reused: without this, editing a loop after creating one would show the last
 * thing typed, which is the mistake here that costs real money the next time somebody picks it. */
watch(
    () => [open.value, editing] as const,
    ([shown, design]) => {
        if (!shown) {
            return;
        }
        name.value = design?.name ?? ``;
        description.value = design?.description ?? ``;
        instruction.value = design?.prompt ?? ``;
        context.value = design?.context ?? `fresh`;
        const check = design?.checks[0];
        stopKind.value = check?.kind === `command` ? `command` : check?.kind === `judge` ? `judge` : design === undefined ? `command` : `claim`;
        command.value = check?.kind === `command` ? check.command : ``;
        rubric.value = check?.kind === `judge` ? check.rubric : ``;
        maxIterations.value = design?.maxIterations ?? 8;
        maxSpendUsd.value = design?.maxSpendUsd ?? 5;
        stallLimit.value = design?.stallLimit ?? 2;
    },
    { immediate: true },
);

const contextOptions = [
    { value: `fresh` as const, label: `Fresh context` },
    { value: `continue` as const, label: `Keep context` },
];
const stopOptions = [
    { value: `command` as const, label: `A command passes` },
    { value: `claim` as const, label: `The agent says so` },
    { value: `judge` as const, label: `A reviewer agrees` },
];

// What each choice actually costs, said where the choice is made rather than in a tooltip nobody opens. The
// context note is the one people get wrong: "keep context" sounds strictly better until a loop spends fifteen
// rounds agreeing with itself.
const contextNote = computed(() =>
    context.value === `fresh`
        ? `Every round starts a new session against the same working tree, and carries its notes in a progress file. Slower per round, and it does not drift.`
        : `Each round continues the same session. Cheaper and it keeps the reasoning, but a long loop starts agreeing with itself.`,
);
const stopNote = computed(() => {
    if (stopKind.value === `command`) {
        return `Run after every round. Exit 0 ends the loop. The only check here whose answer does not come from a model.`;
    }
    return stopKind.value === `claim`
        ? `The agent writes a verdict each round. Self-assessed, so it is advisory: pair it with a tight round ceiling.`
        : `A separate model, which did none of the work, rules on the agent's own report against your rubric.`;
});

const clash = computed(() => name.value.trim() !== `` && taken.some((held) => held.toLowerCase() === name.value.trim().toLowerCase()));
const ready = computed(() => {
    if (name.value.trim() === `` || clash.value) {
        return false;
    }
    if (stopKind.value === `command`) {
        return command.value.trim() !== ``;
    }
    return stopKind.value !== `judge` || rubric.value.trim() !== ``;
});

const submit = (): void => {
    /* The contract asks two questions where this form asks one, and collapsing them is deliberate: a saved loop
     * has exactly one bar to clear, so offering "what do you produce" and "what else must be true" as separate
     * controls would be two fields answering a question already answered. Combining them is a workflow step's
     * job, and that has a designer. */
    const output: LoopOutput = stopKind.value === `claim` ? { kind: `claim` } : { kind: `none` };
    const checks: LoopCheck[] =
        stopKind.value === `command`
            ? [{ kind: `command`, command: command.value.trim() }]
            : stopKind.value === `judge`
              ? [{ kind: `judge`, rubric: rubric.value.trim() }]
              : [];
    emit(`save`, {
        name: name.value.trim(),
        ...(description.value.trim() === `` ? {} : { description: description.value.trim() }),
        ...(instruction.value.trim() === `` ? {} : { prompt: instruction.value.trim() }),
        context: context.value,
        output,
        checks,
        maxIterations: maxIterations.value,
        maxSpendUsd: maxSpendUsd.value,
        stallLimit: stallLimit.value,
    });
};
</script>

<template>
    <Modal v-model:open="open" size="md" :header="editing ? `Edit loop` : `New loop`">
        <div class="flex flex-col gap-4">
            <label class="flex flex-col gap-1">
                <span :class="ui.sectionLabel()">Name it</span>
                <input v-model="name" :class="ui.input()" placeholder="Until the tests pass" autofocus />
                <!-- The name is what the composer badge shows at pill width, so it is the one field whose
                     length is worth a word about at the moment of typing it. -->
                <span v-if="clash" class="text-2xs text-danger">You already have a loop with that name.</span>
                <span v-else class="text-2xs text-subtle">What you'll pick from the message box. Short enough to read on a button.</span>
            </label>

            <label class="flex flex-col gap-1">
                <span :class="ui.sectionLabel()">What it's for</span>
                <input v-model="description" :class="ui.input()" placeholder="fixes failures one at a time until the suite is green" />
                <span class="text-2xs text-subtle">Optional. One line under the name in the picker.</span>
            </label>

            <label class="flex flex-col gap-1">
                <span :class="ui.sectionLabel()">What each round does</span>
                <input v-model="instruction" :class="ui.input()" placeholder="run the tests, pick the top failure, fix it" />
                <span class="text-2xs text-subtle">
                    Optional. Leave it empty and the agent works towards whatever you type in the message box, however it sees fit.
                </span>
            </label>

            <div class="flex flex-col gap-1.5">
                <span :class="ui.sectionLabel()">How it ends</span>
                <SegmentedControl v-model="stopKind" :options="stopOptions" />
                <input v-if="stopKind === `command`" v-model="command" :class="[ui.input(), `font-mono`]" placeholder="pnpm test" />
                <textarea
                    v-else-if="stopKind === `judge`"
                    v-model="rubric"
                    :class="ui.input()"
                    rows="2"
                    placeholder="Every public function has a doc comment explaining why it exists."
                ></textarea>
                <span class="text-2xs text-subtle">{{ stopNote }}</span>
            </div>

            <div class="flex flex-col gap-1.5">
                <span :class="ui.sectionLabel()">Memory between rounds</span>
                <SegmentedControl v-model="context" :options="contextOptions" />
                <span class="text-2xs text-subtle">{{ contextNote }}</span>
            </div>

            <!-- The ceilings, together and pre-filled, because they are only ever read as a group: "how far can
                 this go before it stops on its own". Every one of them is a way the loop ends without meeting
                 the goal, so a loop saved with none of them touched still cannot start something unbounded. -->
            <div class="flex flex-col gap-1.5">
                <span :class="ui.sectionLabel()">Stop it anyway after</span>
                <div class="grid grid-cols-3 gap-2">
                    <label class="flex flex-col gap-1">
                        <input v-model.number="maxIterations" type="number" min="1" max="50" :class="ui.input()" />
                        <span class="text-2xs text-subtle">rounds</span>
                    </label>
                    <label class="flex flex-col gap-1">
                        <input v-model.number="maxSpendUsd" type="number" min="0.5" step="0.5" :class="ui.input()" />
                        <span class="text-2xs text-subtle">dollars</span>
                    </label>
                    <label class="flex flex-col gap-1">
                        <input v-model.number="stallLimit" type="number" min="1" max="10" :class="ui.input()" />
                        <span class="text-2xs text-subtle">idle rounds</span>
                    </label>
                </div>
                <!-- The stall limit is the one nobody would think to set, and the one that saves the most: an
                     agent re-reading the same files forever raises no error at all. -->
                <span class="text-2xs text-subtle">
                    An idle round is one that changed nothing in the tree: that, not an error, is how a loop usually goes wrong.
                </span>
            </div>
        </div>

        <template #footer>
            <button type="button" :class="ui.linkButton()" @click="open = false">Cancel</button>
            <Button size="small" :label="editing ? `Save` : `Create loop`" :disabled="!ready" @click="submit()" />
        </template>
    </Modal>
</template>
