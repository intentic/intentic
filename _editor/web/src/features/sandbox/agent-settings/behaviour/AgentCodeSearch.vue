<script setup lang="ts">
import { Notice, Row, RowGroup, RowNote } from "@intentic/ui";
import { formatPercent } from "@intentic/ui/format";
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

// Two composing settings, ordered by when each acts: iq search (on demand) and the project map (before there's a
// question). Simple draws each switch with one chip of what it measured; Advanced adds the tables and the comparison
// groups.

const t = useT();
const level = useDetailLevel(`code-search`);
const advanced = computed(() => level.value === `advanced`);

const { settings, patch, refusal } = useSandboxSettings();
const { savings } = useSavings({});

// Session state: the holdout flips whole conversations, never individual turns.
const iqSearchHoldoutPercent = computed<number>(() => asPercent(settings.value?.iqSearchHoldout));
const searchTable = computed<ResultTable | undefined>(() => tableOf(savings.value?.search));
// Whether agents taught iq reach for it at all: a teaching nobody takes up cannot move the rows above, and only this says
// which of the two a "no clear difference" is.
const iqUptake = computed<string | undefined>(() => {
    const uptake = savings.value?.search?.uptake;
    return uptake === undefined
        ? undefined
        : t(`sandbox.agentCodeSearch.iqUptake`, { on: formatPercent(uptake.on * 100), off: formatPercent(uptake.off * 100) });
});

// Same holdout behaviour as the search teaching above: flips whole conversations, read on their opening turn.
const mapHoldoutPercent = computed<number>(() => asPercent(settings.value?.workspaceMapHoldout));
const mapTable = computed<ResultTable | undefined>(() => tableOf(savings.value?.map));
</script>

<template>
    <RowGroup data-setting="agent-code-search" :label="t(`sandbox.agentCodeSearch.codeSearch`)">
        <template #info><CodeSearchExplainer /></template>
        <template #actions><DetailSwitch v-model="level" :label="t(`sandbox.agentCodeSearch.codeSearch`)" /></template>
        <!-- Loads the iq plugin so the assistant searches with the iq CLI instead of grep/find/glob. -->
        <!-- `spine` hangs the measurement block off this row's name rather than the group's edge. -->
        <Row spine icon="search" :title="t(`sandbox.agentCodeSearch.iqCodeSearch`)" :description="t(`sandbox.agentCodeSearch.useIqSearchCli`)">
            <template #control>
                <ToggleSwitch
                    :model-value="settings?.iqSearch ?? true"
                    :disabled="settings === undefined"
                    @update:model-value="(value: boolean) => patch({ iqSearch: value })"
                />
            </template>
            <template v-if="settings?.iqSearch === true" #below>
                <ResultChip v-if="!advanced" :table="searchTable" />
                <MeasurementPanel
                    v-else
                    :table="searchTable"
                    :percent="iqSearchHoldoutPercent"
                    :note="t(`sandbox.agentCodeSearch.ofConversationsRunWithout`)"
                    :on-label="t(`sandbox.agentCodeSearch.withIq`)"
                    :off-label="t(`sandbox.measurementPanel.without`)"
                    @commit="(iqSearchHoldout: number) => patch({ iqSearchHoldout })"
                >
                    <template v-if="iqUptake !== undefined" #note>
                        <p class="text-xs text-muted">{{ iqUptake }}</p>
                    </template>
                </MeasurementPanel>
            </template>
        </Row>

        <!-- Answers "what is this and where am I in it", one question earlier than search. -->
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
