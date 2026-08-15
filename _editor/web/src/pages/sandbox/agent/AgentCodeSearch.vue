<script setup lang="ts">
import { ui, Row, RowGroup } from "@intentic/ui";
import ToggleSwitch from "primevue/toggleswitch";
import { computed } from "vue";
import { useSavings } from "../../../composables/sandbox/useSavings";
import { useSandboxSettings } from "../../../composables/sandbox/useSandboxSettings";
import { asPercent, commitPercent } from "./numberInputs";
import { dilutionOf, readingVerdict } from "../savingsChart";
import CodeSearchInfo from "./CodeSearchInfo.vue";

/* HOW THE ASSISTANT FINDS ITS WAY AROUND THE CODE. Two settings that compose and are easy to confuse, which is
 * exactly why they share a group: the first teaches the assistant to search with iq instead of grep, the second
 * searches for the user's message before the turn starts and hands over the answer with it. */

const { settings, patch } = useSandboxSettings();
const { savings } = useSavings({});

// The pre-injection's measurement control, the same turn-level holdout the terse steer takes.
const iqContextHoldoutPercent = computed<number>(() => asPercent(settings.value?.iqContextHoldout));
// Search teaching is session state, so this holdout flips whole conversations and never individual turns.
const iqSearchHoldoutPercent = computed<number>(() => asPercent(settings.value?.iqSearchHoldout));

const searchReadings = computed(() => {
    const experiment = savings.value?.search;
    if (experiment === undefined) {
        return [];
    }
    return experiment.metrics.map((reading) => ({
        verdict: readingVerdict(reading, experiment.minTurns, experiment.sampleUnit),
        on: reading.on.turns,
        off: reading.off.turns,
    }));
});

/* WHAT THE EXPERIMENT SAYS SO FAR, one line per reading, worded exactly as the Savings card words it — the two
 * screens read the same report and a settings row that paraphrased it would be a second opinion.
 *
 * The retrieval is judged on searches, not on what the turn cost. Cost per turn spent nine days reporting a
 * ±25-point interval that turned out to be the coin flip handing one arm the bigger jobs; searches are what the
 * mechanism actually removes, so they are what can see it. */
const contextReadings = computed(() => {
    const experiment = savings.value?.context;
    if (experiment === undefined) {
        return [];
    }
    // The arms travel alongside the verdict because this row has no chart to carry them, and a figure with no
    // account of how much data is behind it is one a reader cannot weigh. On the Savings card the bars say it.
    return experiment.metrics.map((reading) => ({
        verdict: readingVerdict(reading, experiment.minTurns),
        on: reading.on.turns,
        off: reading.off.turns,
    }));
});

// …and how much of the assigned arm the retrieval actually reached, with the biggest reason it didn't. Said
// once under both readings, since it qualifies them equally. The daemon orders the outcomes largest-first, so
// the first non-delivery is the one worth naming; the tail belongs in the ledger.
const contextDilution = computed(() => (savings.value?.context === undefined ? `` : dilutionOf(savings.value.context)));
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
            <template #below>
                <template v-if="settings?.iqSearch === true">
                    <label class="flex items-center justify-between gap-3">
                        <span class="flex min-w-0 flex-col">
                            <span class="text-xs text-content">Measure it</span>
                            <span class="text-2xs text-muted">
                                Run this % of conversations without the iq teaching. The arm stays fixed for the conversation so a session that
                                already learned it cannot later count as cold; both arms need ~30 conversations.
                            </span>
                        </span>
                        <span class="flex shrink-0 items-center gap-1">
                            <input
                                type="number"
                                min="0"
                                max="100"
                                :value="iqSearchHoldoutPercent"
                                :class="ui.input('w-16 text-right text-xs')"
                                @change="
                                    (event: Event) =>
                                        commitPercent(event, iqSearchHoldoutPercent, (iqSearchHoldout: number) => patch({ iqSearchHoldout }))
                                "
                            />
                            <span class="text-xs text-muted">%</span>
                        </span>
                    </label>
                    <div v-if="searchReadings.length > 0" class="mt-2 flex flex-col gap-1 border-t border-line pt-2 text-2xs">
                        <p v-for="row in searchReadings" :key="row.verdict.unit" class="text-muted">
                            <span class="tabular-nums" :class="row.verdict.tone === `success` ? `text-success` : `text-muted`">{{
                                row.verdict.value
                            }}</span>
                            {{ row.verdict.unit }} — {{ row.verdict.detail }}, over {{ row.on }} taught vs {{ row.off }} cold conversations.
                        </p>
                    </div>
                </template>
            </template>
        </Row>

        <!-- Retrieve before the turn — the daemon searches for the message and hands the ranked answer to the
             assistant with it, so a turn that would have opened with two or three searches opens with the
             anchors. Directly under iq code search because they compose and are easy to confuse: that one
             teaches the assistant to search, this one answers before it decides to. -->
        <Row
            icon="forward"
            title="Retrieve before the turn"
            description="Search the workspace for each message up front and hand the assistant the answer with it."
        >
            <template #control>
                <ToggleSwitch
                    :model-value="settings?.iqContext ?? false"
                    :disabled="settings === undefined"
                    @update:model-value="(value: boolean) => patch({ iqContext: value })"
                />
            </template>
            <template #below>
                <!-- Same control the terse steer takes, for the same reason: a turn cannot be re-run without
                     the context it opened with, so the only way to know whether the retrieval saved the turn
                     any searching is to leave a slice of turns cold and count what they searched. -->
                <template v-if="settings?.iqContext === true">
                    <label class="flex items-center justify-between gap-3">
                        <span class="flex min-w-0 flex-col">
                            <span class="text-xs text-content">Measure it</span>
                            <span class="text-2xs text-muted">
                                Run this % of turns without the retrieved context, as a control. Both arms need ~30 turns before anything is reported,
                                and a figure only once the effect clears the turn-to-turn noise — which takes considerably more.
                            </span>
                        </span>
                        <span class="flex shrink-0 items-center gap-1">
                            <input
                                type="number"
                                min="0"
                                max="100"
                                :value="iqContextHoldoutPercent"
                                :class="ui.input('w-16 text-right text-xs')"
                                @change="
                                    (event: Event) =>
                                        commitPercent(event, iqContextHoldoutPercent, (iqContextHoldout: number) => patch({ iqContextHoldout }))
                                "
                            />
                            <span class="text-xs text-muted">%</span>
                        </span>
                    </label>
                    <!-- One line per reading, both off the same coin flip: every search a turn ran, and the ones
                         it ran before it opened a file. Judged on searches rather than on what the turn cost —
                         cost is dominated by how big the job was, which is not what the retrieval changes. -->
                    <div v-if="contextReadings.length > 0" class="mt-2 flex flex-col gap-1 border-t border-line pt-2 text-2xs">
                        <!-- The verdict is the only span, and the rest of the sentence is the paragraph's own
                             text: two adjacent elements separated by a line break have that break COMPILED AWAY,
                             which ran "Measuring" into "searches per turn". Same shape the Savings card uses. -->
                        <p v-for="row in contextReadings" :key="row.verdict.unit" class="text-muted">
                            <span class="tabular-nums" :class="row.verdict.tone === `success` ? `text-success` : `text-muted`">{{
                                row.verdict.value
                            }}</span>
                            {{ row.verdict.unit }} — {{ row.verdict.detail }}, over {{ row.on }} retrieved vs {{ row.off }} cold turns.
                        </p>
                        <!-- The arm is intention-to-treat, so most of it may never have been treated. Naming the largest
                             reason is what turns "19% delivered" from an alarm into a fact you can act on. -->
                        <p v-if="contextDilution !== ``" class="text-muted">{{ contextDilution }}</p>
                    </div>
                </template>
            </template>
        </Row>
    </RowGroup>
</template>
