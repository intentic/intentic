<script setup lang="ts">
import { Button, ui, Icon, Picker } from "@intentic/extension-ui";
import { GATE_DAILY_MAX_DEFAULT, type Workflow, type WorkflowGate } from "@intentic/sandbox-contract";
import { computed } from "vue";
import GateAccess from "./GateAccess.vue";
import { t } from "./i18n.js";

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
            {{ t(`gatePanel.gateGivesWorkflowWebhook`) }}
        </p>

        <template v-if="gate === undefined">
            <p v-if="eligible.length === 0" class="text-2xs text-warning">
                {{ t(`gatePanel.gateReadsDeclaredOutput`) }}
            </p>
            <Button v-else :label="t(`gatePanel.addGate`)" size="small" severity="secondary" class="self-start" @click="add()">
                <template #icon><Icon name="plus" /></template>
            </Button>
        </template>

        <template v-else>
            <div class="grid grid-cols-2 gap-2">
                <label class="flex min-w-0 flex-col gap-1">
                    <span :class="ui.sectionLabel()">{{ t(`gatePanel.decidingStep`) }}</span>
                    <Picker
                        :model-value="gate.step"
                        :options="stepOptions"
                        :aria-label="t(`gatePanel.stepGateReads`)"
                        class="min-w-0 text-xs"
                        @update:model-value="setStep"
                    />
                </label>
                <label class="flex min-w-0 flex-col gap-1">
                    <span :class="ui.sectionLabel()">{{ t(`gatePanel.field`) }}</span>
                    <Picker
                        :model-value="gate.field"
                        :options="fieldOptions"
                        :aria-label="t(`gatePanel.fieldGateReads`)"
                        class="min-w-0 text-xs"
                        @update:model-value="setField"
                    />
                </label>
            </div>
            <label class="flex flex-col gap-1">
                <span :class="ui.sectionLabel()">{{ t(`gatePanel.shipsSays`) }}</span>
                <input
                    :value="gate.pass.join(`, `)"
                    :class="ui.input()"
                    :placeholder="t(`gatePanel.pass`)"
                    @change="setPass(($event.target as HTMLInputElement).value)"
                />
                <span class="text-2xs text-subtle">
                    {{ t(`gatePanel.allowlistCommaSeparatedAnything`) }}
                </span>
            </label>
            <label class="flex flex-col gap-1">
                <span :class="ui.sectionLabel()">{{ t(`gatePanel.runsPerDay`) }}</span>
                <input
                    :value="gate.dailyMax ?? ``"
                    type="number"
                    min="1"
                    :class="[ui.input(), `w-24`]"
                    :placeholder="`${GATE_DAILY_MAX_DEFAULT}`"
                    @input="setDailyMax(($event.target as HTMLInputElement).value)"
                />
                <span class="text-2xs text-subtle">
                    {{ t(`gatePanel.spendCeilingEveryCall`) }}
                </span>
            </label>

            <GateAccess v-if="gateToken !== undefined" :workflow="{ id: workflow.id, name: workflow.name, gateToken }" />
            <p v-else class="text-2xs text-subtle">{{ t(`gatePanel.savingMintsWebhookUrl`) }}</p>

            <button type="button" :class="ui.linkButton(`self-start text-danger`)" @click="emit(`patch`, undefined)">
                {{ t(`gatePanel.removeGateUrlStops`) }}
            </button>
        </template>
    </div>
</template>
