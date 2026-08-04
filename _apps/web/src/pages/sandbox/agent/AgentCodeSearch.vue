<script setup lang="ts">
import { cmp, Row, RowGroup } from "@intentic/ui";
import ToggleSwitch from "primevue/toggleswitch";
import { computed } from "vue";
import { useSavings } from "../../../composables/sandbox/useSavings";
import { useSandboxSettings } from "../../../composables/sandbox/useSandboxSettings";
import { asPercent, commitPercent } from "./numberInputs";
import CodeSearchInfo from "./CodeSearchInfo.vue";

/* HOW THE ASSISTANT FINDS ITS WAY AROUND THE CODE. Two settings that compose and are easy to confuse, which is
 * exactly why they share a group: the first teaches the assistant to search with iq instead of grep, the second
 * searches for the user's message before the turn starts and hands over the answer with it. */

const { settings, patch } = useSandboxSettings();
const { savings } = useSavings({});

// The pre-injection's measurement control, the same turn-level holdout the terse steer takes.
const iqContextHoldoutPercent = computed<number>(() => asPercent(settings.value?.iqContextHoldout));

// The biggest reason the treated arm went untreated — the daemon already orders these largest-first, so the
// first non-delivery is it. One is enough for a settings card: it separates a gate declining on purpose from a
// deadline eating the feature, and the tail belongs in the ledger.
const largestContextLoss = computed(() => savings.value?.context?.outcomes?.find((row) => row.outcome !== `note`));
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
                     the context it opened with, so the only way to know whether the injected tokens paid for
                     themselves is to leave a slice of turns cold and compare the cost. -->
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
                                :class="cmp.input('w-16 text-right text-xs')"
                                @change="
                                    (event: Event) =>
                                        commitPercent(event, iqContextHoldoutPercent, (iqContextHoldout: number) => patch({ iqContextHoldout }))
                                "
                            />
                            <span class="text-xs text-muted">%</span>
                        </span>
                    </label>
                    <p v-if="savings?.context !== undefined" class="mt-2 border-t border-line pt-2 text-2xs">
                        <template v-if="savings.context.deltaPct !== undefined">
                            <span class="tabular-nums" :class="savings.context.deltaPct < 0 ? `text-success` : `text-muted`">
                                {{ savings.context.deltaPct < 0 ? `↓` : `↑` }}{{ Math.abs(savings.context.deltaPct) }}%
                            </span>
                            <span class="text-muted">
                                cost per turn ± {{ savings.context.marginPct }}pp, over {{ savings.context.on.turns }} retrieved vs
                                {{ savings.context.off.turns }} cold turns.
                            </span>
                        </template>
                        <!-- Both arms are past the threshold and the effect still hasn't separated from zero. Distinct from
                             "measuring": the reader has waited long enough for the arms and the answer is that the spread is
                             wider than the effect, which the old copy hid by repeating "of 30 needed per arm" at 52 turns. -->
                        <span v-else-if="savings.context.marginPct !== undefined" class="text-muted">
                            No effect yet distinguishable from zero — anything real is inside ±{{ savings.context.marginPct }}pp, over
                            {{ savings.context.on.turns }} retrieved vs {{ savings.context.off.turns }} cold turns.
                            <template v-if="savings.context.controlTurnsNeeded !== undefined">
                                Narrowing that to a width worth acting on needs about {{ savings.context.controlTurnsNeeded }} more cold turns.
                            </template>
                        </span>
                        <span v-else class="text-muted">
                            Measuring — {{ savings.context.on.turns }} retrieved and {{ savings.context.off.turns }} cold turns so far, of
                            {{ savings.context.minTurns }} needed per arm.
                        </span>
                        <!-- The arm is intention-to-treat, so most of it may never have been treated. Naming the largest
                             reason is what turns "19% delivered" from an alarm into a fact you can act on. -->
                        <span v-if="savings.context.deliveredPct !== undefined" class="text-muted">
                            The note reached {{ savings.context.deliveredPct }}% of the retrieved arm<template
                                v-if="largestContextLoss !== undefined"
                            >
                                ; most of the rest was {{ largestContextLoss.outcome }} ({{ largestContextLoss.turns }} turns)</template
                            >.
                        </span>
                    </p>
                </template>
            </template>
        </Row>
    </RowGroup>
</template>
