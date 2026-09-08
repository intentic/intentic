<script setup lang="ts">
import type { TurnExperiment } from "@intentic/sandbox-contract";
import { Row, RowGroup } from "@intentic/ui";
import ToggleSwitch from "primevue/toggleswitch";
import { computed } from "vue";
import { useSavings } from "../../usage/useSavings";
import { useSandboxSettings } from "../../overview/useSandboxSettings";
import { asPercent } from "../models/numberInputs";
import { verdictsOf } from "../../usage/savingsChart";
import CodeSearchInfo from "./CodeSearchInfo.vue";
import MeasurementPanel, { type PanelReading } from "../models/MeasurementPanel.vue";

// Three composing settings, ordered by when each acts: iq search (on demand), the project map (before there's
// a question), and document shadows (a background pass rendering non-text files so both others can reach them).

const { settings, patch } = useSandboxSettings();
const { savings } = useSavings({});

// Session state: the holdout flips whole conversations, never individual turns.
const iqSearchHoldoutPercent = computed<number>(() => asPercent(settings.value?.iqSearchHoldout));

// Mirrors how the Savings card reports the same experiment, via `verdictsOf` rather than treating each metric
// as a peer: two readings of one subject would otherwise read as two findings.
const readingsOf = (experiment: TurnExperiment | undefined): PanelReading[] => {
    if (experiment === undefined) {
        return [];
    }
    const { headline, also } = verdictsOf(experiment);
    return [headline, ...also].flatMap((verdict, index) => {
        const reading = experiment.metrics[index];
        return reading === undefined ? [] : [{ verdict, on: reading.on.turns, off: reading.off.turns }];
    });
};

const searchReadings = computed<PanelReading[]>(() => readingsOf(savings.value?.search));

// Same holdout behaviour as the search teaching above: flips whole conversations, read on their opening turn.
const mapHoldoutPercent = computed<number>(() => asPercent(settings.value?.workspaceMapHoldout));
const mapReadings = computed<PanelReading[]>(() => readingsOf(savings.value?.map));
</script>

<template>
    <RowGroup label="Code search">
        <template #info><CodeSearchInfo /></template>

        <!--
            Loads the iq plugin so the assistant searches with the iq CLI instead of grep/find/glob. Opt-in per sandbox;
            the browser Search box always uses iq.
        -->
        <!-- `spine` hangs the measurement block off this row's name rather than the group's edge. -->
        <Row spine icon="search" title="iq code search" description="Use iq search CLI instead of grep/find/glob.">
            <template #control>
                <ToggleSwitch
                    :model-value="settings?.iqSearch ?? false"
                    :disabled="settings === undefined"
                    @update:model-value="(value: boolean) => patch({ iqSearch: value })"
                />
            </template>
            <!-- The rationale for why the arm must stay pinned for a whole conversation lives in the info tooltip, not inline. -->
            <template v-if="settings?.iqSearch === true" #below>
                <MeasurementPanel
                    :percent="iqSearchHoldoutPercent"
                    :readings="searchReadings"
                    note="Runs this share of conversations without it, as a control."
                    on-label="taught"
                    off-label="cold"
                    @commit="(iqSearchHoldout: number) => patch({ iqSearchHoldout })"
                />
            </template>
        </Row>

        <!--
            Answers "what is this and where am I in it", one question earlier than search. Read off disk on each new
            conversation rather than a maintained document, hence a switch rather than a file kept in sync by hand.
        -->
        <Row spine icon="sitemap" title="Project map" description="Provide project structure overview to new conversations.">
            <template #control>
                <ToggleSwitch
                    :model-value="settings?.workspaceMap ?? false"
                    :disabled="settings === undefined"
                    @update:model-value="(value: boolean) => patch({ workspaceMap: value })"
                />
            </template>
            <!--
                The map changes a choice (list vs. search), not a quantity of searching, so the arms are read by whether the
                opening turn lists a directory, not by search count. Full method lives in the info tooltip.
            -->
            <template v-if="settings?.workspaceMap === true" #below>
                <MeasurementPanel
                    :percent="mapHoldoutPercent"
                    :readings="mapReadings"
                    note="Opens this share of conversations without it, as a control."
                    on-label="mapped"
                    off-label="unmapped"
                    @commit="(workspaceMapHoldout: number) => patch({ workspaceMapHoldout })"
                />
            </template>
        </Row>

        <!--
            Background pass that pre-renders binary files (docx, pdf, images, audio) as markdown as they land, so a
            later read is a file open, not a parse. Only gates background CPU spend; fileq itself is always available.
        -->
        <Row icon="file" title="Document shadows" description="Keep documents, images and audio pre-rendered as text, updated as files change.">
            <template #control>
                <ToggleSwitch
                    :model-value="settings?.sidecars ?? false"
                    :disabled="settings === undefined"
                    @update:model-value="(value: boolean) => patch({ sidecars: value })"
                />
            </template>
        </Row>
    </RowGroup>
</template>
