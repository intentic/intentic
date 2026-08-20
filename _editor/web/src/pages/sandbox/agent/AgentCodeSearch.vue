<script setup lang="ts">
import { Row, RowGroup } from "@intentic/ui";
import ToggleSwitch from "primevue/toggleswitch";
import { computed } from "vue";
import { useSavings } from "../../../composables/sandbox/useSavings";
import { useSandboxSettings } from "../../../composables/sandbox/useSandboxSettings";
import { asPercent } from "./numberInputs";
import { verdictsOf } from "../savingsChart";
import CodeSearchInfo from "./CodeSearchInfo.vue";
import MeasurementPanel, { type PanelReading } from "./MeasurementPanel.vue";

/* HOW THE ASSISTANT FINDS ITS WAY AROUND THE CODE. Two settings that compose and are easy to confuse, which is
 * exactly why they share a group: the first teaches the assistant to search with iq instead of grep, the second
 * hands over the shape of the project before there is a question to ask.
 *
 * Ordered by when each one happens: search on demand, and the map that comes before there is anything to
 * search for. */

const { settings, patch } = useSandboxSettings();
const { savings } = useSavings({});

// Search teaching is session state, so this holdout flips whole conversations and never individual turns.
const iqSearchHoldoutPercent = computed<number>(() => asPercent(settings.value?.iqSearchHoldout));

/* WHAT THE EXPERIMENT SAYS SO FAR, worded exactly as the Savings card words it — the two screens read the same
 * report and a settings row that paraphrased it would be a second opinion.
 *
 * Through `verdictsOf` rather than mapping every metric as a peer: this experiment reports TWO readings of one
 * subject (searches per turn, and searches before the first file), and drawn at equal weight they read as two
 * findings. <MeasurementPanel> gives the first the headline and the second a line under it. */
const searchReadings = computed<PanelReading[]>(() => {
    const experiment = savings.value?.search;
    if (experiment === undefined) {
        return [];
    }
    const { headline, also } = verdictsOf(experiment);
    return [headline, ...also].flatMap((verdict, index) => {
        const reading = experiment.metrics[index];
        return reading === undefined ? [] : [{ verdict, on: reading.on.turns, off: reading.off.turns }];
    });
});
</script>

<template>
    <RowGroup label="Code search">
        <template #info><CodeSearchInfo /></template>

        <!-- iq code search — loads the iq plugin (skill + nudge) so the assistant reaches for the iq CLI instead
             of grep/find/glob. Opt-in per sandbox; the browser Search box uses iq regardless. -->
        <Row icon="search" title="iq code search" description="Let the assistant use the iq search CLI instead of grep / find / glob.">
            <template #control>
                <ToggleSwitch
                    :model-value="settings?.iqSearch ?? false"
                    :disabled="settings === undefined"
                    @update:model-value="(value: boolean) => patch({ iqSearch: value })"
                />
            </template>
            <!-- The same measurement block the terse steer carries, and the same one line about it. Why the arm
                 has to stay pinned for a whole conversation is a paragraph, and it now lives in the (i) where a
                 paragraph can be read — on the row it was three lines of 11px text between a switch and its
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

        <!-- The project map — one question earlier than search. Search answers "where is this thing"; this
             answers "what is this and which part of it am I in", which every new conversation has to buy for
             itself and, left to itself, buys with a folder listing. Read off disk each time a conversation
             opens rather than written down anywhere, which is the whole reason it is a switch here and not a
             paragraph somebody maintains by hand. -->
        <Row
            icon="sitemap"
            title="Project map"
            description="Hand the assistant the main parts of the project it opens in, read fresh from your folders."
        >
            <template #control>
                <ToggleSwitch
                    :model-value="settings?.workspaceMap ?? false"
                    :disabled="settings === undefined"
                    @update:model-value="(value: boolean) => patch({ workspaceMap: value })"
                />
            </template>
            <!-- Nothing below the switch. No holdout, unlike its neighbour: what the map removes is the opening
                 look around, one or two calls on the first message of a conversation — too small a slice of too
                 few turns for a split to say anything before the layout it describes has changed. And nothing to
                 say in 11px text either; where the map lands and which project it follows are both facts about
                 the feature rather than about the click, and the (i) gives them a paragraph each. -->
        </Row>
    </RowGroup>
</template>
