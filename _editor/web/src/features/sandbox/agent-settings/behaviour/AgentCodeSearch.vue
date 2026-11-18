<script setup lang="ts">
import { Notice, Row, RowGroup, RowNote } from "@intentic/ui";
import ToggleSwitch from "primevue/toggleswitch";
import { computed } from "vue";
import { useSavings } from "../../usage/useSavings";
import { useSandboxSettings } from "../../../../models/sandbox/useSandboxSettings";
import { asPercent } from "../models/numberInputs";
import MeasurementPanel from "../models/MeasurementPanel.vue";
import ResultChip from "../models/ResultChip.vue";
import DetailSwitch from "./DetailSwitch.vue";
import { useDetailLevel } from "./detailLevel";
import CodeSearchExplainer from "./explainers/CodeSearchExplainer.vue";
import { type ResultTable, tableOf } from "../models/experimentReadings";
import { useT } from "@intentic/ui/i18n";

// The project map, handed to the agent before there's a question. Simple draws the switch with one chip of what it
// measured; Advanced adds the table and the comparison groups.

const t = useT();
const level = useDetailLevel(`code-search`);
const advanced = computed(() => level.value === `advanced`);

const { settings, patch, refusal } = useSandboxSettings();
const { savings } = useSavings({});

// Session state: the holdout flips whole conversations, never individual turns, read on their opening turn.
const mapHoldoutPercent = computed<number>(() => asPercent(settings.value?.workspaceMapHoldout));
const mapTable = computed<ResultTable | undefined>(() => tableOf(savings.value?.map));
</script>

<template>
    <RowGroup data-setting="agent-code-search" :label="t(`sandbox.agentCodeSearch.codeSearch`)">
        <template #info><CodeSearchExplainer /></template>
        <template #actions><DetailSwitch v-model="level" :label="t(`sandbox.agentCodeSearch.codeSearch`)" /></template>
        <!-- Answers "what is this and where am I in it" before the agent searches for anything. -->
        <!-- `spine` hangs the measurement block off this row's name rather than the group's edge. -->
        <Row
            spine
            icon="sitemap"
            :title="t(`sandbox.agentCodeSearch.projectMap`)"
            :description="t(`sandbox.agentCodeSearch.provideProjectStructureOverview`)"
        >
            <template #control>
                <ToggleSwitch
                    :model-value="settings?.workspaceMap ?? true"
                    :disabled="settings === undefined"
                    @update:model-value="(value: boolean) => patch({ workspaceMap: value })"
                />
            </template>
            <!-- Holdout flips whole conversations here too: the map is sent once, on the conversation's opening turn. -->
            <template v-if="settings?.workspaceMap === true" #below>
                <ResultChip v-if="!advanced" :table="mapTable" />
                <MeasurementPanel
                    v-else
                    :table="mapTable"
                    :percent="mapHoldoutPercent"
                    :note="t(`sandbox.agentCodeSearch.ofConversationsOpenWithout`)"
                    :on-label="t(`sandbox.agentCodeSearch.withMap`)"
                    :off-label="t(`sandbox.measurementPanel.without`)"
                    @commit="(workspaceMapHoldout: number) => patch({ workspaceMapHoldout })"
                />
            </template>
        </Row>

        <RowNote v-if="refusal !== undefined" variant="block"><Notice :of="refusal" /></RowNote>
    </RowGroup>
</template>
