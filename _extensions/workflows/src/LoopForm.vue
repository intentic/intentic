<script setup lang="ts">
import { Button, ui, Modal, SegmentedControl } from "@intentic/extension-ui";
import type { LoopCheck, LoopDesign, LoopOutput } from "@intentic/sandbox-contract";
import { computed, ref, watch } from "vue";
import { t } from "./i18n.js";

// Form for a saved loop's machinery (how it ends, memory, ceilings), asked once per loop rather than per use; the goal
// itself is typed in the message box, not here. A full page rather than a modal, since none of this fits mid-message.
// Order: name, then how it ends, then the ceilings.

const { editing, taken } = defineProps<{
    /** The loop being edited, or undefined for a new one. */
    editing?: LoopDesign;
    /** Names already in use, checked client-side before the save can refuse. */
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

// Reloads the form from `editing` (or clears it) on every open; immediate, since the dialog is mounted once and reused
// across loops.
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

const contextOptions = computed(() => [
    { value: `fresh` as const, label: t(`loopForm.freshContext`) },
    { value: `continue` as const, label: t(`loopForm.keepContext`) },
]);
const stopOptions = computed(() => [
    { value: `command` as const, label: t(`loopForm.commandPasses`) },
    { value: `claim` as const, label: t(`loopForm.agentSays`) },
    { value: `judge` as const, label: t(`loopForm.reviewerAgrees`) },
]);

// "Keep context" sounds strictly better but risks a loop agreeing with itself for many rounds.
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
    // Collapses the contract's two questions (output, extra checks) into this form's single stop condition.
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
    <Modal v-model:open="open" size="md" :header="editing ? t(`loopForm.editLoop`) : t(`loopForm.newLoop`)">
        <div class="flex flex-col gap-4">
            <label class="flex flex-col gap-1">
                <span :class="ui.sectionLabel()">{{ t(`loopForm.name`) }}</span>
                <input v-model="name" :class="ui.input()" :placeholder="t(`loopForm.untilTestsPass`)" autofocus />
                <!-- Shown at pill width on the composer badge, so length matters here more than for other fields. -->
                <span v-if="clash" class="text-2xs text-danger">{{ t(`loopForm.alreadyLoopName`) }}</span>
                <span v-else class="text-2xs text-subtle">{{ t(`loopForm.whatYoullPickMessage`) }}</span>
            </label>

            <label class="flex flex-col gap-1">
                <span :class="ui.sectionLabel()">{{ t(`loopForm.what`) }}</span>
                <input v-model="description" :class="ui.input()" :placeholder="t(`loopForm.fixesFailuresOneAt`)" />
                <span class="text-2xs text-subtle">{{ t(`loopForm.optionalOneLineUnder`) }}</span>
            </label>

            <label class="flex flex-col gap-1">
                <span :class="ui.sectionLabel()">{{ t(`loopForm.whatEachRoundDoes`) }}</span>
                <input v-model="instruction" :class="ui.input()" :placeholder="t(`loopForm.runTestsPickTop`)" />
                <span class="text-2xs text-subtle">
                    {{ t(`loopForm.optionalLeaveEmptyAgent`) }}
                </span>
            </label>

            <div class="flex flex-col gap-1.5">
                <span :class="ui.sectionLabel()">{{ t(`loopForm.howEnds`) }}</span>
                <SegmentedControl v-model="stopKind" :options="stopOptions" />
                <input v-if="stopKind === `command`" v-model="command" :class="[ui.input(), `font-mono`]" :placeholder="t(`loopForm.pnpmTest`)" />
                <textarea
                    v-else-if="stopKind === `judge`"
                    v-model="rubric"
                    :class="ui.input()"
                    rows="2"
                    :placeholder="t(`loopForm.everyPublicFunctionDoc`)"
                ></textarea>
                <span class="text-2xs text-subtle">{{ stopNote }}</span>
            </div>

            <div class="flex flex-col gap-1.5">
                <span :class="ui.sectionLabel()">{{ t(`loopForm.memoryBetweenRounds`) }}</span>
                <SegmentedControl v-model="context" :options="contextOptions" />
                <span class="text-2xs text-subtle">{{ contextNote }}</span>
            </div>

            <!-- Ceilings are grouped and pre-filled, so a loop saved untouched still can't run unbounded. -->
            <div class="flex flex-col gap-1.5">
                <span :class="ui.sectionLabel()">{{ t(`loopForm.stopAnywayAfter`) }}</span>
                <div class="grid grid-cols-3 gap-2">
                    <label class="flex flex-col gap-1">
                        <input v-model.number="maxIterations" type="number" min="1" max="50" :class="ui.input()" />
                        <span class="text-2xs text-subtle">{{ t(`loopForm.rounds`) }}</span>
                    </label>
                    <label class="flex flex-col gap-1">
                        <input v-model.number="maxSpendUsd" type="number" min="0.5" step="0.5" :class="ui.input()" />
                        <span class="text-2xs text-subtle">{{ t(`loopForm.dollars`) }}</span>
                    </label>
                    <label class="flex flex-col gap-1">
                        <input v-model.number="stallLimit" type="number" min="1" max="10" :class="ui.input()" />
                        <span class="text-2xs text-subtle">{{ t(`loopForm.idleRounds`) }}</span>
                    </label>
                </div>
                <!-- Stall limit catches an agent looping without progress, which raises no error on its own. -->
                <span class="text-2xs text-subtle">
                    {{ t(`loopForm.idleRoundOneChanged`) }}
                </span>
            </div>
        </div>

        <template #footer>
            <button type="button" :class="ui.linkButton()" @click="open = false">{{ t(`loopForm.cancel`) }}</button>
            <Button size="small" :label="editing ? t(`loopForm.save`) : t(`loopForm.createLoop`)" :disabled="!ready" @click="submit()" />
        </template>
    </Modal>
</template>
