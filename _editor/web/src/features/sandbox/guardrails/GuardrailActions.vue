<script setup lang="ts">
import type { AdmissionRule } from "@intentic/sandbox-contract/schemas/agent";
import { Notice, Picker, Row, RowGroup, RowNote } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { useExtensions } from "../../../models/extensions/useExtensions";
import { actionLabel, serviceName } from "../data-protection/dataProtection";
import { useSandboxSettings } from "../../../models/sandbox/useSandboxSettings";
import { actionRules, ruleOptions, type ServiceRow, serviceRows, withServiceRule } from "./outwardActions";
import { type Posture, postureOf, postures, withPosture } from "./spawnPosture";

// What the agent may do out in the world without a person saying yes: start more agents, then one row per service whose
// extension is on (send a Discord message, register a letter in EZD RP). Ask first parks the action in Approvals. A
// service's actions are set together, and when they were set apart (the preset holds each on its own key) the row says
// how each stands rather than picking one. Starting subagents sat in Agent ▸ Tools, the rest had no control outside the
// preset, until 2026-10-16.

const t = useT();
const { settings, patch, refusal } = useSandboxSettings();
const { enabled: enabledExtensions } = useExtensions();

const rules = computed(() => settings.value?.actionRules ?? {});
const switchedOn = computed(() => new Set(enabledExtensions.value.map((extension) => extension.id)));
const rows = computed(() => serviceRows(rules.value, switchedOn.value));

const posture = computed<Posture>(() => postureOf(rules.value));
const setPosture = (next: Posture): void => patch({ actionRules: withPosture(rules.value, next) });
const setRule = (row: ServiceRow, rule: AdmissionRule): void => patch({ actionRules: withServiceRule(rules.value, row, rule) });

const actionOf = (key: string): string => actionLabel(key.split(`.`).slice(1).join(`.`));
const covers = (row: ServiceRow): string => row.keys.map(actionOf).join(` · `);
// The line under a row whose actions differ, each with how it stands, in the words Data protection uses for the same rules.
const mixedLine = (row: ServiceRow): string =>
    actionRules(rules.value, row)
        .map(({ key, rule }) => `${actionOf(key)}: ${t(`sandbox.dataProtection.value.${rule}`)}`)
        .join(` · `);
</script>

<template>
    <RowGroup :label="t(`sandbox.guardrails.actions.title`)">
        <RowNote>{{ t(`sandbox.guardrails.actions.intro`) }}</RowNote>
        <Row icon="subagents" :title="t(`sandbox.agentSubagents.spawnSubagents`)" :description="t(`sandbox.agentSubagents.spawnedSubagentSpends`)">
            <template #control>
                <Picker
                    :model-value="posture"
                    :options="postures()"
                    :disabled="settings === undefined"
                    class="w-36 justify-between text-xs"
                    :aria-label="t(`sandbox.agentSubagents.spawnSubagents`)"
                    :header="t(`sandbox.agentSubagents.spawnSubagents`)"
                    @update:model-value="(next: Posture | undefined) => next !== undefined && setPosture(next)"
                />
            </template>
        </Row>
        <Row v-for="row in rows" :key="row.service" icon="send" :title="serviceName(row.service)" :description="covers(row)">
            <template #control>
                <Picker
                    :model-value="row.rule"
                    :options="ruleOptions()"
                    :placeholder="t(`sandbox.guardrails.actions.mixed`)"
                    :disabled="settings === undefined"
                    class="w-36 justify-between text-xs"
                    :aria-label="serviceName(row.service)"
                    :header="serviceName(row.service)"
                    @update:model-value="(next: AdmissionRule | undefined) => next !== undefined && setRule(row, next)"
                />
            </template>
            <template v-if="row.rule === undefined" #below>
                <p class="text-2xs text-muted">{{ mixedLine(row) }}</p>
            </template>
        </Row>
        <RowNote v-if="rows.length === 0" variant="empty">{{ t(`sandbox.guardrails.actions.noServices`) }}</RowNote>
        <RowNote v-if="refusal !== undefined" variant="block"><Notice :of="refusal" /></RowNote>
    </RowGroup>
</template>
