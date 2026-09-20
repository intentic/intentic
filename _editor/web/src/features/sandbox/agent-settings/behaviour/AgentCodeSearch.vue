<script setup lang="ts">
import { FIELD_NOTES_FILE } from "@intentic/constants";
import type { TurnExperiment } from "@intentic/sandbox-contract";
import { Row, RowGroup, ui } from "@intentic/ui";
import { RouterLink } from "vue-router";
import ToggleSwitch from "primevue/toggleswitch";
import { computed } from "vue";
import { useSavings } from "../../usage/useSavings";
import { useSandboxSettings } from "../../overview/useSandboxSettings";
import { useSidecarStatus } from "../../../workspace/files/useSidecarStatus";
import { useFieldNotes } from "./useFieldNotes";
import { commitCount,asPercent } from "../models/numberInputs";
import { meanUnit, verdictsOf } from "../../usage/savingsChart";
import MeasurementPanel, { type PanelReading } from "../models/MeasurementPanel.vue";
import { useT } from "@intentic/ui/i18n";

// Four composing settings, ordered by when each acts: iq search (on demand), the project map (before there's
// a question), the field notes (before the conversation, and for all of it), and document shadows (a background pass
// rendering non-text files so the others can reach them).

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

// The field notes report two things no setting can: whether the file the switch composes exists at all, and whether
// anything is scheduled to keep it current. A switch left on over a brief nothing maintains is the failure to show.
const notesHoldoutPercent = computed<number>(() => asPercent(settings.value?.fieldNotesHoldout));
const notesReadings = computed<PanelReading[]>(() => readingsOf(savings.value?.notes));
const { status: notes } = useFieldNotes();
const NOTES_BUDGET = { min: 500, max: 20000 } as const;
// The pair, never the first number alone: "5 of 12" separates a tight budget from a short file, and "5" cannot.
const notesReach = computed<string>(() =>
    notes.value?.ranksTotal === undefined
        ? ``
        : t(`sandbox.agentCodeSearch.sendingRanks`, {
              sent: notes.value.ranksSent ?? 0,
              total: notes.value.ranksTotal,
              chars: notes.value.chars ?? 0,
          }),
);

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

        <!-- The one composed piece that is written rather than derived: a monthly automation rewrites it off the session
             record, so it can carry what no scan of the tree can. Rides the system prompt for the whole session, unlike
             the map above, which is sent once with the opening message. -->
        <Row
            spine
            icon="book"
            :title="t(`sandbox.agentCodeSearch.fieldNotes`)"
            :description="t(`sandbox.agentCodeSearch.whatSessionsLearned`)"
        >
            <template #control>
                <ToggleSwitch
                    :model-value="settings?.fieldNotes ?? false"
                    :disabled="settings === undefined"
                    @update:model-value="(value: boolean) => patch({ fieldNotes: value })"
                />
            </template>
            <template v-if="settings?.fieldNotes === true" #below>
                <!-- Two facts no setting can hold: whether the file this switch composes exists, and whether anything
                     is scheduled to keep it current. A switch left on over a brief nothing maintains is the failure. -->
                <p v-if="notes?.unreadable !== undefined" class="text-2xs text-warning">
                    {{ t(`sandbox.agentCodeSearch.briefUnreadable`, { why: notes.unreadable }) }}
                </p>
                <!-- One line: what is being sent, and the way to the file it came from. Two lines read as two
                     findings, and the link is not one. -->
                <p v-else class="flex items-center gap-2 text-2xs text-subtle">
                    <span>{{ notes?.present === false ? t(`sandbox.agentCodeSearch.noBriefYet`) : notesReach }}</span>
                    <RouterLink v-if="notes?.present === true" :to="`/workspace/${FIELD_NOTES_FILE}`" class="underline">{{
                        t(`sandbox.agentCodeSearch.openTheBrief`)
                    }}</RouterLink>
                </p>
                <p v-if="notes?.automation === `missing`" class="text-2xs text-subtle">
                    <RouterLink to="/ext/automations" class="underline">{{ t(`sandbox.agentCodeSearch.setUpTheAutomation`) }}</RouterLink>
                </p>
                <p v-else-if="notes?.automation === `disabled`" class="text-2xs text-warning">
                    {{ t(`sandbox.agentCodeSearch.automationOff`) }}
                </p>
                <!-- Characters, not sections: the file's own ranking picks WHICH, this picks HOW MANY fit, and raising
                     it buys more of the tail rather than a fuller version of the same thing. -->
                <label class="flex items-center gap-2 text-2xs text-subtle">
                    <span>{{ t(`sandbox.agentCodeSearch.budget`) }}</span>
                    <input
                        type="number"
                        :min="NOTES_BUDGET.min"
                        :max="NOTES_BUDGET.max"
                        :step="100"
                        :value="settings?.fieldNotesBudget ?? 4000"
                        :disabled="settings === undefined"
                        :class="ui.inputSm(`w-24 text-right`)"
                        @change="
                            (event: Event) =>
                                commitCount(event, settings?.fieldNotesBudget ?? 4000, NOTES_BUDGET, (fieldNotesBudget: number) =>
                                    patch({ fieldNotesBudget }),
                                )
                        "
                    />
                </label>
                <MeasurementPanel
                    :percent="notesHoldoutPercent"
                    :readings="notesReadings"
                    :note="t(`sandbox.agentCodeSearch.ofConversationsRunWithoutNotes`)"
                    on-label="briefed"
                    off-label="cold"
                    @commit="(fieldNotesHoldout: number) => patch({ fieldNotesHoldout })"
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
