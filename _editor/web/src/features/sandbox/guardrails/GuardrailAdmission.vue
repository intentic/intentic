<script setup lang="ts">
import type { AdmissionPolicy, AdmissionRule } from "@intentic/sandbox-contract/schemas/command-admission";
import { Notice, Picker, Row, RowGroup, RowNote } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { useSandboxSettings } from "../../../models/sandbox/useSandboxSettings";
import { ADMISSION_KEYS, type AdmissionKey, admissionOptions } from "./outwardActions";

// Whether work started from outside may run at all, per kind of trigger (`settings.admission`): run, wait in Approvals,
// or be refused. It composes with each automation's own "ask every time", and the stricter wins, so holding every
// visitor's message needs no edit to each automation. Settable only through the public-office preset until 2026-10-16.

const t = useT();
const { settings, patch, refusal } = useSandboxSettings();

const admission = computed<AdmissionPolicy | undefined>(() => settings.value?.admission);
const setRule = (key: AdmissionKey, rule: AdmissionRule): void => {
    if (admission.value !== undefined) {
        // SAFETY: admissionOptions offers a workflow no `hold`, the one value its field refuses.
        patch({ admission: { ...admission.value, [key]: rule } as AdmissionPolicy });
    }
};
</script>

<template>
    <RowGroup data-setting="guardrails-admission" :label="t(`sandbox.guardrails.admission.title`)">
        <RowNote>{{ t(`sandbox.guardrails.admission.intro`) }}</RowNote>
        <Row v-for="key in ADMISSION_KEYS" :key="key" icon="automations" :title="t(`sandbox.guardrails.admission.${key}`)">
            <template #control>
                <Picker
                    :model-value="admission?.[key]"
                    :options="admissionOptions(key)"
                    :disabled="admission === undefined"
                    class="w-36 justify-between text-xs"
                    :aria-label="t(`sandbox.guardrails.admission.${key}`)"
                    :header="t(`sandbox.guardrails.admission.${key}`)"
                    @update:model-value="(next: AdmissionRule | undefined) => next !== undefined && setRule(key, next)"
                />
            </template>
        </Row>
        <RowNote v-if="refusal !== undefined" variant="block"><Notice :of="refusal" /></RowNote>
    </RowGroup>
</template>
