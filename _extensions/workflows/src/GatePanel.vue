<script setup lang="ts">
import { Button, cmp, Icon, Picker } from "@intentic/extension-ui";
import { GATE_DAILY_MAX_DEFAULT, type Workflow, type WorkflowGate } from "@intentic/sandbox-contract";
import { computed } from "vue";
import GateAccess from "./GateAccess.vue";

/* THE GATE, AS A FORM — the designer's answer to "let my pipeline run this and read a verdict".
 *
 * The engine has been finished for a while (gate.routes.ts); what was missing was any way to declare one
 * without hand-editing the manifest. The form asks exactly what the schema asks and nothing else: which step
 * decides, which of its declared fields carries the decision, which values ship, and how many runs a day the
 * owner will pay for. The webhook token is deliberately NOT a field here — it is minted on save and kept
 * across edits (workflows.routes.ts), so the panel only ever shows it, via <GateAccess>.
 *
 * Presence is the switch, so there is no enabled toggle to get out of sync with the token behind it: adding
 * the gate opens the door on the next save, removing it closes the door and revokes the URL with it. */

const { workflow } = defineProps<{ workflow: Workflow }>();
const emit = defineEmits<{ patch: [gate: WorkflowGate | undefined] }>();

const gate = computed(() => workflow.gate);
// Only a step that declares output fields can carry a verdict — a validated field is the one part of a
// session's answer that was checked rather than scraped out of prose, and pointing at one is the entire rule.
const eligible = computed(() => workflow.steps.filter((step) => step.output.kind === `json`));

// The fields a gate may read on a given step: scalars only. A list has no reading as a release decision, and
// offering one here just to refuse it in the fault line would be a form arguing with itself.
const fieldsOf = (stepId: string) => {
    const step = workflow.steps.find((entry) => entry.id === stepId);
    return step?.output.kind === `json` ? step.output.fields.filter((field) => field.type !== `string[]`) : [];
};

const stepOptions = computed(() => eligible.value.map((step) => ({ value: step.id, label: step.title })));
const fieldOptions = computed(() =>
    gate.value === undefined ? [] : fieldsOf(gate.value.step).map((field) => ({ value: field.name, label: `${field.name} · ${field.type}` })),
);

const add = (): void => {
    const step = eligible.value[0];
    if (step === undefined) {
        return;
    }
    // `pass` prefilled with the one value almost every verdict field means by it — editable, never invented
    // on the wire: what is saved is exactly what this form shows.
    emit(`patch`, { step: step.id, field: fieldsOf(step.id)[0]?.name ?? ``, pass: [`pass`] });
};

// Re-pointing the gate keeps the token on purpose (workflows.routes.ts round-trips it): the URL a pipeline
// was taught must survive the step being renamed or the decision moving to a different field.
const setStep = (stepId: string | undefined): void => {
    if (gate.value !== undefined && stepId !== undefined) {
        emit(`patch`, { ...gate.value, step: stepId, field: fieldsOf(stepId)[0]?.name ?? `` });
    }
};
const setField = (field: string | undefined): void => {
    if (gate.value !== undefined && field !== undefined) {
        emit(`patch`, { ...gate.value, field });
    }
};
// On change rather than on input: the value re-renders as `join(", ")`, and reformatting under a caret
// mid-word is how a form fights its author.
const setPass = (raw: string): void => {
    if (gate.value !== undefined) {
        emit(`patch`, {
            ...gate.value,
            pass: raw
                .split(`,`)
                .map((value) => value.trim())
                .filter((value) => value !== ``),
        });
    }
};
const setDailyMax = (raw: string): void => {
    if (gate.value !== undefined) {
        const value = Number(raw.trim());
        emit(`patch`, { ...gate.value, dailyMax: Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined });
    }
};
</script>

<template>
    <div class="flex w-pop-sm flex-col gap-3 p-1">
        <p class="text-2xs text-subtle">
            A gate gives this workflow a webhook a CI pipeline can call: the pipeline POSTs what it knows, the whole design runs, and
            the reply is pass, fail or blocked — read off one declared field, never scraped out of prose.
        </p>

        <template v-if="gate === undefined">
            <p v-if="eligible.length === 0" class="text-2xs text-warning">
                A gate reads a declared output field, and no step declares one yet. Give the deciding step a data field first — select
                it on the canvas and add one under Advanced.
            </p>
            <Button v-else label="Add a gate" size="small" severity="secondary" class="self-start" @click="add()">
                <template #icon><Icon name="plus" /></template>
            </Button>
        </template>

        <template v-else>
            <div class="grid grid-cols-2 gap-2">
                <label class="flex min-w-0 flex-col gap-1">
                    <span :class="cmp.sectionLabel()">Deciding step</span>
                    <Picker
                        :model-value="gate.step"
                        :options="stepOptions"
                        aria-label="Step the gate reads"
                        class="min-w-0 text-xs"
                        @update:model-value="setStep"
                    />
                </label>
                <label class="flex min-w-0 flex-col gap-1">
                    <span :class="cmp.sectionLabel()">Field</span>
                    <Picker
                        :model-value="gate.field"
                        :options="fieldOptions"
                        aria-label="Field the gate reads"
                        class="min-w-0 text-xs"
                        @update:model-value="setField"
                    />
                </label>
            </div>
            <label class="flex flex-col gap-1">
                <span :class="cmp.sectionLabel()">Ships when it says</span>
                <input
                    :value="gate.pass.join(`, `)"
                    :class="cmp.input()"
                    placeholder="pass"
                    @change="setPass(($event.target as HTMLInputElement).value)"
                />
                <span class="text-2xs text-subtle">
                    An allowlist, comma-separated. Anything else the field says fails the gate — "mostly-pass" does not ship.
                </span>
            </label>
            <label class="flex flex-col gap-1">
                <span :class="cmp.sectionLabel()">Runs per day</span>
                <input
                    :value="gate.dailyMax ?? ``"
                    type="number"
                    min="1"
                    :class="[cmp.input(), `w-24`]"
                    :placeholder="`${GATE_DAILY_MAX_DEFAULT}`"
                    @input="setDailyMax(($event.target as HTMLInputElement).value)"
                />
                <span class="text-2xs text-subtle">
                    The spend ceiling. Every call runs the whole graph, and a push-triggered pipeline calls on every commit.
                </span>
            </label>

            <GateAccess v-if="gate.token !== undefined" :workflow="workflow" />
            <p v-else class="text-2xs text-subtle">Saving mints the webhook URL — it appears here and under the gate badge on the workflow's card.</p>

            <button type="button" :class="cmp.linkButton(`self-start text-danger`)" @click="emit(`patch`, undefined)">
                Remove the gate — its URL stops working, and a future gate gets a new one
            </button>
        </template>
    </div>
</template>
