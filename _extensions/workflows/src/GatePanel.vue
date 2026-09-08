<script setup lang="ts">
import { Button, ui, Icon, Picker } from "@intentic/extension-ui";
import { GATE_DAILY_MAX_DEFAULT, type Workflow, type WorkflowGate } from "@intentic/sandbox-contract";
import { computed } from "vue";
import GateAccess from "./GateAccess.vue";

// Form for a workflow's release gate: which step decides, which field carries the verdict, which values ship, and the
// daily run cap. The webhook token isn't a field here; the daemon mints and returns it, and the panel only displays it
// via <GateAccess>. Presence of `gate` is the on/off switch, with no separate enabled flag.

// From the last save or the list, never the draft; passed in separately and shown once it exists.
const { workflow, gateToken } = defineProps<{ workflow: Workflow; gateToken?: string }>();
const emit = defineEmits<{ patch: [gate: WorkflowGate | undefined] }>();

const gate = computed(() => workflow.gate);
// Only steps with declared JSON output fields can carry a verdict; anything else is unchecked prose.
const eligible = computed(() => workflow.steps.filter((step) => step.output.kind === `json`));

// Scalar fields only; a list field has no reading as a pass/fail verdict.
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
    // Prefills `pass` with the common verdict value; editable, and always exactly what's saved.
    emit(`patch`, { step: step.id, field: fieldsOf(step.id)[0]?.name ?? ``, pass: [`pass`] });
};

// The token is kept when re-pointing the gate (workflows.routes.ts round-trips it), so a pipeline's URL survives a
// renamed step or a different field.
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
// Fires on change, not input: reformatting to `join(', ')` while typing would fight the caret mid-word.
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
            A gate gives this workflow a webhook a CI pipeline can call: the pipeline POSTs what it knows, the whole design runs, and the reply is
            pass, fail or blocked: read off one declared field, never scraped out of prose.
        </p>

        <template v-if="gate === undefined">
            <p v-if="eligible.length === 0" class="text-2xs text-warning">
                A gate reads a declared output field, and no step declares one yet. Give the deciding step a data field first: select it on the
                canvas and add one under Advanced.
            </p>
            <Button v-else label="Add a gate" size="small" severity="secondary" class="self-start" @click="add()">
                <template #icon><Icon name="plus" /></template>
            </Button>
        </template>

        <template v-else>
            <div class="grid grid-cols-2 gap-2">
                <label class="flex min-w-0 flex-col gap-1">
                    <span :class="ui.sectionLabel()">Deciding step</span>
                    <Picker
                        :model-value="gate.step"
                        :options="stepOptions"
                        aria-label="Step the gate reads"
                        class="min-w-0 text-xs"
                        @update:model-value="setStep"
                    />
                </label>
                <label class="flex min-w-0 flex-col gap-1">
                    <span :class="ui.sectionLabel()">Field</span>
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
                <span :class="ui.sectionLabel()">Ships when it says</span>
                <input
                    :value="gate.pass.join(`, `)"
                    :class="ui.input()"
                    placeholder="pass"
                    @change="setPass(($event.target as HTMLInputElement).value)"
                />
                <span class="text-2xs text-subtle">
                    An allowlist, comma-separated. Anything else the field says fails the gate: "mostly-pass" does not ship.
                </span>
            </label>
            <label class="flex flex-col gap-1">
                <span :class="ui.sectionLabel()">Runs per day</span>
                <input
                    :value="gate.dailyMax ?? ``"
                    type="number"
                    min="1"
                    :class="[ui.input(), `w-24`]"
                    :placeholder="`${GATE_DAILY_MAX_DEFAULT}`"
                    @input="setDailyMax(($event.target as HTMLInputElement).value)"
                />
                <span class="text-2xs text-subtle">
                    The spend ceiling. Every call runs the whole graph, and a push-triggered pipeline calls on every commit.
                </span>
            </label>

            <GateAccess v-if="gateToken !== undefined" :workflow="{ id: workflow.id, name: workflow.name, gateToken }" />
            <p v-else class="text-2xs text-subtle">Saving mints the webhook URL: it appears here and under the gate badge on the workflow's card.</p>

            <button type="button" :class="ui.linkButton(`self-start text-danger`)" @click="emit(`patch`, undefined)">
                Remove the gate: its URL stops working, and a future gate gets a new one
            </button>
        </template>
    </div>
</template>
