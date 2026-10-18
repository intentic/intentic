<script setup lang="ts">
import { Notice, Row, RowGroup, RowNote } from "@intentic/ui";
import ToggleSwitch from "primevue/toggleswitch";
import { computed } from "vue";
import { useSavings } from "../../usage/useSavings";
import { useSandboxSettings } from "../../../../models/sandbox/useSandboxSettings";
import { asPercent } from "../models/numberInputs";
import MeasurementPanel from "../models/MeasurementPanel.vue";
import { type ResultTable, tableOf } from "../models/experimentReadings";
import { useT } from "@intentic/ui/i18n";

// What every request of a turn carries before the agent's own words, and so what every call of it pays again. Three
// switches: connected tools' descriptions kept out until the agent looks one up; the instructions kept identical
// between turns so the provider's cache holds them, with what moves between turns said on the message instead; and a
// large conversation whose cache already expired resumed with older tool output cleared, when re-reading it is paid in
// full anyway. Each measured like the other composing settings: a share of conversations runs without it, and the table
// says what it costs.

const t = useT();

const { settings, patch, refusal } = useSandboxSettings();
const { savings } = useSavings({});

// Whole conversations: switching mid-conversation would rewrite the prompt the provider's cache holds.
const holdoutPercent = computed<number>(() => asPercent(settings.value?.toolSearchHoldout));
const table = computed<ResultTable | undefined>(() => tableOf(savings.value?.toolSearch));

// Whole conversations too: the paragraphs a held-out conversation keeps are part of the prompt its cache holds.
const stableHoldoutPercent = computed<number>(() => asPercent(settings.value?.stableSystemPromptHoldout));
const stableTable = computed<ResultTable | undefined>(() => tableOf(savings.value?.stablePrompt));

// Drawn only on the turns that came back cold, both arms, so the table compares like with like.
const coldHoldoutPercent = computed<number>(() => asPercent(settings.value?.coldTrimHoldout));
const coldTable = computed<ResultTable | undefined>(() => tableOf(savings.value?.coldTrim));
</script>

<template>
    <RowGroup data-setting="agent-tool-loading" :label="t(`sandbox.agentToolLoading.group`)">
        <Row spine icon="wrench" :title="t(`sandbox.agentToolLoading.onDemand`)" :description="t(`sandbox.agentToolLoading.onDemandDescription`)">
            <template #control>
                <ToggleSwitch
                    :model-value="settings?.toolSearch ?? true"
                    :disabled="settings === undefined"
                    @update:model-value="(value: boolean) => patch({ toolSearch: value })"
                />
            </template>
            <template v-if="settings?.toolSearch === true" #below>
                <MeasurementPanel
                    :table="table"
                    :percent="holdoutPercent"
                    :note="t(`sandbox.agentToolLoading.ofConversationsLoadEverything`)"
                    :on-label="t(`sandbox.agentToolLoading.onDemandShort`)"
                    :off-label="t(`sandbox.agentToolLoading.allLoaded`)"
                    @commit="(toolSearchHoldout: number) => patch({ toolSearchHoldout })"
                />
            </template>
        </Row>

        <Row spine icon="lock" :title="t(`sandbox.agentToolLoading.stable`)" :description="t(`sandbox.agentToolLoading.stableDescription`)">
            <template #control>
                <ToggleSwitch
                    :model-value="settings?.stableSystemPrompt ?? true"
                    :disabled="settings === undefined"
                    @update:model-value="(value: boolean) => patch({ stableSystemPrompt: value })"
                />
            </template>
            <template v-if="settings?.stableSystemPrompt === true" #below>
                <MeasurementPanel
                    :table="stableTable"
                    :percent="stableHoldoutPercent"
                    :note="t(`sandbox.agentToolLoading.ofConversationsKeepMoving`)"
                    :on-label="t(`sandbox.agentToolLoading.stableShort`)"
                    :off-label="t(`sandbox.agentToolLoading.stableMoving`)"
                    @commit="(stableSystemPromptHoldout: number) => patch({ stableSystemPromptHoldout })"
                />
            </template>
        </Row>

        <Row spine icon="compress" :title="t(`sandbox.agentToolLoading.coldTrim`)" :description="t(`sandbox.agentToolLoading.coldTrimDescription`)">
            <template #control>
                <ToggleSwitch
                    :model-value="settings?.coldTrim ?? true"
                    :disabled="settings === undefined"
                    @update:model-value="(value: boolean) => patch({ coldTrim: value })"
                />
            </template>
            <template v-if="settings?.coldTrim === true" #below>
                <MeasurementPanel
                    :table="coldTable"
                    :percent="coldHoldoutPercent"
                    :note="t(`sandbox.agentToolLoading.ofConversationsResumeWhole`)"
                    :on-label="t(`sandbox.agentToolLoading.coldTrimShort`)"
                    :off-label="t(`sandbox.agentToolLoading.coldTrimWhole`)"
                    @commit="(coldTrimHoldout: number) => patch({ coldTrimHoldout })"
                />
            </template>
        </Row>
        <RowNote v-if="refusal !== undefined" variant="block"><Notice :of="refusal" /></RowNote>
    </RowGroup>
</template>
