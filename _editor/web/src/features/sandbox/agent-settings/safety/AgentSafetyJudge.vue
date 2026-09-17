<script setup lang="ts">
import { Button, Row, RowGroup, RowNote, SegmentedControl } from "@intentic/ui";
import { computed } from "vue";
import { RouterLink } from "vue-router";
import { modelChoiceLabel } from "../../../chat/models/modelPins";
import { useRoleModel } from "../../../chat/accounts/roleModel";
import { useSandboxSettings } from "../../overview/useSandboxSettings";
import { useT } from "@intentic/ui/i18n";

// On/off/watch switch for whether the safety judge runs; the policy below only applies when this is not off. Watch
// judges and logs every command without holding any. The judge's model is chosen on the Models tab, not here.

const t = useT();

const { settings, patch } = useSandboxSettings();
const judge = useRoleModel(`safety-judge`);

// Off, watch, on, in escalating order; watch records a verdict but never holds the command.
const MODES = computed(() => [
    { label: t(`sandbox.agentSafetyJudge.off`), value: `off` },
    { label: t(`sandbox.agentSafetyJudge.watch`), value: `watch` },
    { label: t(`sandbox.agentSafetyJudge.on`), value: `on` },
]);

const mode = computed(() => settings.value?.commandJudge ?? `on`);

// Resolved chain for role `safety-judge`; empty means no model set, judge falls back to the standing rule.
const judgeChain = computed<readonly string[]>(() => judge.chain.value.map(modelChoiceLabel));
</script>

<template>
    <RowGroup :label="t(`sandbox.agentSafetyJudge.safetyJudge`)">
        <Row icon="shield" :title="t(`sandbox.agentSafetyJudge.toJudge`)" :description="t(`sandbox.agentSafetyJudge.whetherVerdictStopCommand`)">
            <template #control>
                <SegmentedControl
                    :model-value="mode"
                    :options="MODES"
                    @update:model-value="(commandJudge: string) => patch({ commandJudge: commandJudge as `off` | `watch` | `on` })"
                />
            </template>
            <template #below>
                <div class="flex flex-col gap-2">
                    <p v-if="mode === `off`" class="text-2xs text-muted">
                        {{ t(`sandbox.agentSafetyJudge.nothingJudgedNothingRecorded`) }}
                    </p>
                    <p v-else-if="mode === `watch`" class="text-2xs text-muted">
                        {{ t(`sandbox.agentSafetyJudge.everyFlaggedCommandJudged`) }}
                        <span class="text-content">{{ t(`sandbox.agentSafetyJudge.recentDecisions`) }}</span>
                        {{ t(`sandbox.agentSafetyJudge.toSeeWhatPolicy`) }}
                    </p>
                    <p v-else class="text-2xs text-muted">{{ t(`sandbox.agentSafetyJudge.verdictDecidesAllowedSilently`) }}</p>
                </div>
            </template>
        </Row>

        <!-- Read-only here: a reader wants which model applies, not a way to change it; editing happens on Models. -->
        <Row icon="sparkles" :title="t(`sandbox.agentSafetyJudge.judgeModel`)" :description="t(`sandbox.agentSafetyJudge.modelReadsPolicy`)">
            <!-- `as` keeps native link behavior (hover preview, cmd-click new tab) while Button supplies the control styling. -->
            <template #control>
                <Button :as="RouterLink" :to="{ name: `sandbox`, params: { tab: `agent` }, query: {} }" size="small" :text="true">
                    {{ t(`sandbox.agentSafetyJudge.changeInModels`) }}
                </Button>
            </template>
            <template #below>
                <div class="flex flex-col gap-2">
                    <p v-if="mode === `off`" class="text-2xs text-subtle">{{ t(`sandbox.agentSafetyJudge.nothingJudgesCommandsAt`) }}</p>
                    <p v-else-if="judgeChain.length > 0" class="text-2xs text-muted">
                        <span class="text-content">{{ t(`sandbox.agentSafetyJudge.judgedBy`) }}</span
                        >: {{ judgeChain.join(t(`sandbox.agentSafetyJudge.then`)) }}.
                    </p>
                    <!-- Judge on but no model set: nothing reads the policy; flagged commands fall back to the standing rule. -->
                    <p v-else-if="settings !== undefined" class="text-2xs text-warning">
                        <span class="font-medium">{{ t(`sandbox.agentSafetyJudge.noModelSetJudge`) }}</span
                        >{{ t(`sandbox.agentSafetyJudge.nothingReadsPolicyEvery`) }}
                    </p>

                    <!-- The only automatic judge that reads a command whose text may itself be arguing for its own approval. -->
                    <p v-if="mode !== `off`" class="text-2xs text-subtle">
                        {{ t(`sandbox.agentSafetyJudge.worthBetterModelThan`) }}
                    </p>
                </div>
            </template>
        </Row>
    </RowGroup>
</template>
