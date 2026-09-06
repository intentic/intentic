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

/* HOW THE ASSISTANT FINDS ITS WAY AROUND THE CODE. Three settings that compose and are easy to confuse, which
 * is exactly why they share a group: the first teaches the assistant to search with iq instead of grep, the
 * second hands over the shape of the project before there is a question to ask, the third keeps the files no
 * search can see into (docx, pdf, images, audio) pre-rendered as text so both of the others reach them.
 *
 * Ordered by when each one happens: search on demand, the map that comes before there is anything to search
 * for, and the background pass that runs before either. */

const { settings, patch } = useSandboxSettings();
const { savings } = useSavings({});

// Search teaching is session state, so this holdout flips whole conversations and never individual turns.
const iqSearchHoldoutPercent = computed<number>(() => asPercent(settings.value?.iqSearchHoldout));

/* WHAT THE EXPERIMENT SAYS SO FAR, worded exactly as the Savings card words it: the two screens read the same
 * report and a settings row that paraphrased it would be a second opinion.
 *
 * Through `verdictsOf` rather than mapping every metric as a peer: this experiment reports TWO readings of one
 * subject (searches per turn, and searches before the first file), and drawn at equal weight they read as two
 * findings. <MeasurementPanel> gives the first the headline and the second a line under it. */
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

/* The map's holdout flips whole conversations for the same reason the teaching's does, and is READ on their
 * opening turns, which is the turn the note was sent to. Same two arms, same shape, one function. */
const mapHoldoutPercent = computed<number>(() => asPercent(settings.value?.workspaceMapHoldout));
const mapReadings = computed<PanelReading[]>(() => readingsOf(savings.value?.map));
</script>

<template>
    <RowGroup label="Code search">
        <template #info><CodeSearchInfo /></template>

        <!-- iq code search: loads the iq plugin (skill + nudge) so the assistant reaches for the iq CLI instead
             of grep/find/glob. Opt-in per sandbox; the browser Search box uses iq regardless. -->
        <!-- `spine`: the measurement block hangs off this row's name rather than starting at the group's edge.
             See <Row>'s own note for why the rule sits under the mark and not down the text column. -->
        <Row spine icon="search" title="iq code search" description="Use iq search CLI instead of grep/find/glob.">
            <template #control>
                <ToggleSwitch
                    :model-value="settings?.iqSearch ?? false"
                    :disabled="settings === undefined"
                    @update:model-value="(value: boolean) => patch({ iqSearch: value })"
                />
            </template>
            <!-- The measurement block for the search teaching experiment, and the same one line about it. Why the arm
                 has to stay pinned for a whole conversation is a paragraph, and it now lives in the (i) where a
                 paragraph can be read: on the row it was three lines of 11px text between a switch and its
                 own result. -->
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

        <!-- The project map: one question earlier than search. Search answers \"where is this thing\"; this
             answers \"what is this and which part of it am I in\", which every new conversation has to buy for
             itself and, left to itself, buys with a folder listing. Read off disk each time a conversation
             opens rather than written down anywhere, which is the whole reason it is a switch here and not a
             paragraph somebody maintains by hand. -->
        <!-- `spine` for the same reason its neighbour has one: the measurement block hangs off this row's name. -->
        <Row spine icon="sitemap" title="Project map" description="Provide project structure overview to new conversations.">
            <template #control>
                <ToggleSwitch
                    :model-value="settings?.workspaceMap ?? false"
                    :disabled="settings === undefined"
                    @update:model-value="(value: boolean) => patch({ workspaceMap: value })"
                />
            </template>
            <!-- THIS ROW USED TO SAY A SPLIT COULD NOT ANSWER, and the reasoning was half right: what the map
                 removes is one or two calls on a conversation's first message, which is too small a slice of a
                 turn for any cost or search figure to resolve. What that missed is that the map is not a
                 quantity of searching, it is a CHOICE of one, and a choice shows up in a rate: measured over
                 468 mapped conversations of this workspace against 497 unmapped ones, searches before the
                 first file did not move (+7.6% ±17.6pp) while the share that opened by listing a directory
                 fell from 46.3% to 32.1%. So the arms are read on the opening turn, and on the listings rather
                 than the searches. The method itself is a paragraph and lives in the (i). -->
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

        <!-- Document shadows: the background pass keeping every binary file (docx, pdf, images, audio)
             pre-rendered as markdown the moment it lands, so a mid-task read costs a file open instead of a
             parse. The fileq CLI itself is always available (its skill governs whether the assistant is told);
             this switch is only about spending background CPU unasked, which is the owner's call. -->
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
