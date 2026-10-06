<script setup lang="ts">
import { FIELD_NOTES_FILE } from "@intentic/constants";
import { formatCount, Notice, Row, RowGroup, RowNote } from "@intentic/ui";
import { formatDayMonth } from "@intentic/ui/format";
import { RouterLink } from "vue-router";
import ToggleSwitch from "primevue/toggleswitch";
import { computed } from "vue";
import { useSavings } from "../../usage/useSavings";
import { useSandboxSettings } from "../../overview/useSandboxSettings";
import { useFieldNotes } from "./useFieldNotes";
import { commitCount, asPercent } from "../models/numberInputs";
import MeasurementPanel from "../models/MeasurementPanel.vue";
import { type ResultTable, tableOf } from "../models/experimentReadings";
import { useT } from "@intentic/ui/i18n";

// Three composing settings, ordered by when each acts: iq search (on demand), the project map (before there's a
// question), and the field notes (before the conversation, and for all of it).

const t = useT();

const { settings, patch, refusal } = useSandboxSettings();
const { savings } = useSavings({});

// Session state: the holdout flips whole conversations, never individual turns.
const iqSearchHoldoutPercent = computed<number>(() => asPercent(settings.value?.iqSearchHoldout));
const searchTable = computed<ResultTable | undefined>(() => tableOf(savings.value?.search));

// Same holdout behaviour as the search teaching above: flips whole conversations, read on their opening turn. Both arms
// get a map; the holdout keeps the full one, so the compact one is measured against it.
const mapHoldoutPercent = computed<number>(() => asPercent(settings.value?.workspaceMapHoldout));
const mapTable = computed<ResultTable | undefined>(() => tableOf(savings.value?.map));

// The field notes report two things no setting can: whether the file the switch composes exists at all, and whether
// anything is scheduled to keep it current. A switch left on over a brief nothing maintains is the failure to show.
const notesHoldoutPercent = computed<number>(() => asPercent(settings.value?.fieldNotesHoldout));
const notesTable = computed<ResultTable | undefined>(() => tableOf(savings.value?.notes));
const { status: notes } = useFieldNotes();
const NOTES_BUDGET = { min: 500, max: 20000 } as const;
// The pair, never the first number alone: "top 5 of 12" separates a tight limit from a short file, and "5" cannot.
const notesReach = computed<string>(() =>
    notes.value?.ranksTotal === undefined
        ? ``
        : t(`sandbox.agentCodeSearch.briefReach`, {
              sent: notes.value.ranksSent ?? 0,
              total: notes.value.ranksTotal,
              chars: formatCount(notes.value.chars ?? 0),
          }),
);
const notesSchedule = computed<string>(() => {
    const next = notes.value?.nextRunAt;
    return next === undefined
        ? t(`sandbox.agentCodeSearch.rewrittenMonthly`)
        : t(`sandbox.agentCodeSearch.rewrittenMonthlyNext`, { when: formatDayMonth(next) });
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
                    :table="searchTable"
                    :percent="iqSearchHoldoutPercent"
                    :note="t(`sandbox.agentCodeSearch.ofConversationsRunWithout`)"
                    :on-label="t(`sandbox.agentCodeSearch.withIq`)"
                    :off-label="t(`sandbox.measurementPanel.without`)"
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
            <!-- Holdout flips whole conversations here too: the map is sent once, on the conversation's opening turn, compact
                 to the measured share and full to the rest. -->
            <template v-if="settings?.workspaceMap === true" #below>
                <MeasurementPanel
                    :table="mapTable"
                    :percent="mapHoldoutPercent"
                    :note="t(`sandbox.agentCodeSearch.ofConversationsGetFullMap`)"
                    :on-label="t(`sandbox.agentCodeSearch.compactMap`)"
                    :off-label="t(`sandbox.agentCodeSearch.fullMap`)"
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
                <div class="flex flex-col gap-4">
                    <!-- The brief's own state as labelled facts, one per line on one grid: what is sent, the limit that
                         decides how much of it, and what keeps it current. A switch left on over a brief nothing
                         maintains is the failure to show, so the schedule gets a line even when it is fine. -->
                    <dl class="grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-6 gap-y-2.5 text-xs">
                        <dt class="text-subtle">{{ t(`sandbox.agentCodeSearch.brief`) }}</dt>
                        <dd class="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
                            <span v-if="notes?.unreadable !== undefined" class="text-warning">
                                {{ t(`sandbox.agentCodeSearch.briefUnreadable`, { why: notes.unreadable }) }}
                            </span>
                            <span v-else-if="notes?.present === false" class="text-muted">{{ t(`sandbox.agentCodeSearch.noBriefYet`) }}</span>
                            <template v-else-if="notes?.present === true">
                                <span class="tabular-nums text-content">{{ notesReach }}</span>
                                <RouterLink :to="`/workspace/${FIELD_NOTES_FILE}`" class="text-link hover:underline">{{
                                    t(`sandbox.agentCodeSearch.openTheBrief`)
                                }}</RouterLink>
                            </template>
                        </dd>

                        <!-- Characters, not sections: the file's own ranking picks WHICH, this picks HOW MANY fit, and
                             raising it buys more of the tail rather than a fuller version of the same thing. -->
                        <dt class="text-subtle">
                            <label for="field-notes-budget">{{ t(`sandbox.agentCodeSearch.lengthLimit`) }}</label>
                        </dt>
                        <dd class="flex items-center gap-2 text-muted">
                            <span class="ui-field-shell inline-flex items-center bg-transparent px-1.5 py-0.5">
                                <input
                                    id="field-notes-budget"
                                    type="number"
                                    :min="NOTES_BUDGET.min"
                                    :max="NOTES_BUDGET.max"
                                    :step="100"
                                    :value="settings?.fieldNotesBudget ?? 4000"
                                    :disabled="settings === undefined"
                                    class="field-bare w-14 p-0 text-right text-xs tabular-nums"
                                    @change="
                                        (event: Event) =>
                                            commitCount(event, settings?.fieldNotesBudget ?? 4000, NOTES_BUDGET, (fieldNotesBudget: number) =>
                                                patch({ fieldNotesBudget }),
                                            )
                                    "
                                />
                            </span>
                            {{ t(`sandbox.agentCodeSearch.characters`) }}
                        </dd>

                        <dt class="text-subtle">{{ t(`sandbox.agentCodeSearch.updates`) }}</dt>
                        <dd class="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
                            <template v-if="notes?.automation === `missing`">
                                <span class="text-muted">{{ t(`sandbox.agentCodeSearch.notScheduled`) }}</span>
                                <RouterLink to="/ext/automations" class="text-link hover:underline">{{
                                    t(`sandbox.agentCodeSearch.setUpTheAutomation`)
                                }}</RouterLink>
                            </template>
                            <template v-else-if="notes?.automation === `disabled`">
                                <span class="text-warning">{{ t(`sandbox.agentCodeSearch.automationOff`) }}</span>
                                <RouterLink to="/ext/automations" class="text-link hover:underline">{{
                                    t(`sandbox.agentCodeSearch.openAutomations`)
                                }}</RouterLink>
                            </template>
                            <span v-else-if="notes?.automation === `enabled`" class="text-content">{{ notesSchedule }}</span>
                        </dd>
                    </dl>

                    <MeasurementPanel
                        :table="notesTable"
                        :percent="notesHoldoutPercent"
                        :note="t(`sandbox.agentCodeSearch.ofConversationsRunWithoutNotes`)"
                        :on-label="t(`sandbox.agentCodeSearch.withNotes`)"
                        :off-label="t(`sandbox.measurementPanel.without`)"
                        @commit="(fieldNotesHoldout: number) => patch({ fieldNotesHoldout })"
                    />
                </div>
            </template>
        </Row>
        <RowNote v-if="refusal !== undefined" variant="block"><Notice :of="refusal" /></RowNote>
    </RowGroup>
</template>
