<script setup lang="ts">
import type { TurnExperiment } from "@intentic/sandbox-contract";
import { InfoHint, Row, RowGroup } from "@intentic/ui";
import ToggleSwitch from "primevue/toggleswitch";
import { computed } from "vue";
import { useSavings } from "../../usage/useSavings";
import { useSandboxSettings } from "../../overview/useSandboxSettings";
import { useSidecarStatus } from "../../../workspace/files/useSidecarStatus";
import { asPercent } from "../models/numberInputs";
import { meanUnit, verdictsOf } from "../../usage/savingsChart";
import MeasurementPanel, { type PanelReading } from "../models/MeasurementPanel.vue";
import { useT } from "@intentic/ui/i18n";

// Three composing settings, ordered by when each acts: iq search (on demand), the project map (before there's
// a question), and document shadows (a background pass rendering non-text files so both others can reach them).

const t = useT();

const { settings, patch } = useSandboxSettings();
const { savings } = useSavings({});

// Session state: the holdout flips whole conversations, never individual turns.
const iqSearchHoldoutPercent = computed<number>(() => asPercent(settings.value?.iqSearchHoldout));

// Through `verdictsOf` rather than treating each metric as a peer: two readings of one subject would otherwise
// read as two findings. This block is the only place these experiments are reported.
const readingsOf = (experiment: TurnExperiment | undefined): PanelReading[] => {
    if (experiment === undefined) {
        return [];
    }
    const { headline, also } = verdictsOf(experiment);
    return [headline, ...also].flatMap((verdict, index) => {
        const reading = experiment.metrics[index];
        if (reading === undefined) {
            return [];
        }
        // Means travel with the arms: the panel draws them as the bars under the verdict they produced.
        return [{ verdict, on: reading.on, off: reading.off, meanUnit: meanUnit(reading) }];
    });
};

const searchReadings = computed<PanelReading[]>(() => readingsOf(savings.value?.search));

// Same holdout behaviour as the search teaching above: flips whole conversations, read on their opening turn.
const mapHoldoutPercent = computed<number>(() => asPercent(settings.value?.workspaceMapHoldout));
const mapReadings = computed<PanelReading[]>(() => readingsOf(savings.value?.map));

// The background pass reports itself, since nothing else can: it makes no request and owns no page.
const { status: shadowStatus } = useSidecarStatus();
const shadowBusy = computed(() => shadowStatus.value !== undefined && (shadowStatus.value.sweeping || shadowStatus.value.deriving.length > 0));
const shadowSummary = computed<string>(() => {
    const status = shadowStatus.value;
    if (status === undefined) {
        return ``;
    }
    if (status.broken) {
        return `The renderer is missing from this sandbox, so nothing is being rendered until it restarts.`;
    }
    const rendered = status.shadows === undefined ? `` : `${status.shadows} rendered`;
    if (status.sweeping) {
        return `Checking every file…`;
    }
    const waiting = status.deriving.length + status.queued;
    const queued = waiting === 0 ? `nothing waiting` : `${waiting} waiting`;
    return rendered === `` ? `Up to date, ${queued}.` : `${rendered}, ${queued}.`;
});
</script>

<template>
    <RowGroup :label="t(`sandbox.agentCodeSearch.codeSearch`)">
        <!-- Where the method behind the readings below lives, so each one can be the answer alone. -->
        <template #info>
            <InfoHint :label="t(`sandbox.agentCodeSearch.howTheseAreMeasured`)">
                <span class="block text-xs text-content">{{ t(`sandbox.agentCodeSearch.eachSwitchRunsOwn`) }}</span>
            </InfoHint>
        </template>

        <!-- Loads the iq plugin so the assistant searches with the iq CLI instead of grep/find/glob. -->
        <!-- `spine` hangs the measurement block off this row's name rather than the group's edge. -->
        <Row spine icon="search" :title="t(`sandbox.agentCodeSearch.iqCodeSearch`)" :description="t(`sandbox.agentCodeSearch.useIqSearchCli`)">
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
                    :note="t(`sandbox.agentCodeSearch.ofConversationsRunWithout`)"
                    on-label="taught"
                    off-label="cold"
                    @commit="(iqSearchHoldout: number) => patch({ iqSearchHoldout })"
                />
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
                    :model-value="settings?.workspaceMap ?? false"
                    :disabled="settings === undefined"
                    @update:model-value="(value: boolean) => patch({ workspaceMap: value })"
                />
            </template>
            <!-- Holdout flips whole conversations here too: the map is sent once, on the conversation's opening turn. -->
            <template v-if="settings?.workspaceMap === true" #below>
                <MeasurementPanel
                    :percent="mapHoldoutPercent"
                    :readings="mapReadings"
                    :note="t(`sandbox.agentCodeSearch.ofConversationsOpenWithout`)"
                    on-label="mapped"
                    off-label="unmapped"
                    @commit="(workspaceMapHoldout: number) => patch({ workspaceMapHoldout })"
                />
            </template>
        </Row>

        <!-- Background pass that pre-renders binary files (docx, pdf, images, audio) as markdown as they land, so a later read is a file open, not a parse. -->
        <Row icon="file" :title="t(`sandbox.agentCodeSearch.documentShadows`)" :description="t(`sandbox.agentCodeSearch.keepDocumentsImagesAudio`)">
            <template #control>
                <ToggleSwitch
                    :model-value="settings?.sidecars ?? false"
                    :disabled="settings === undefined"
                    @update:model-value="(value: boolean) => patch({ sidecars: value })"
                />
            </template>
            <!-- Work with no request behind it and no page of its own; without this line the only way to know whether it
                 is keeping up is to open a file and find out. -->
            <template v-if="settings?.sidecars === true && shadowStatus !== undefined" #below>
                <p class="flex items-center gap-2 text-2xs text-subtle">
                    <Icon v-if="shadowBusy" name="spinner" spin class="text-[0.7rem]" />
                    <Icon v-else-if="shadowStatus.broken" name="exclamation-triangle" class="text-[0.7rem] text-warning" />
                    <span :class="shadowStatus.broken ? `text-warning` : undefined">{{ shadowSummary }}</span>
                </p>
            </template>
        </Row>
    </RowGroup>
</template>
