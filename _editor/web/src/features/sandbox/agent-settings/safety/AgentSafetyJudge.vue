<script setup lang="ts">
import { Button, InfoDialog, Notice, Row, RowGroup, RowNote, SegmentedControl } from "@intentic/ui";
import { computed } from "vue";
import { RouterLink } from "vue-router";
import { modelChoiceLabel } from "../../../chat/models/modelPins";
import { useRoleModel } from "../../../chat/accounts/roleModel";
import { useSandboxSettings } from "../../overview/useSandboxSettings";
import { useT } from "@intentic/ui/i18n";
import AgentSafetyRules from "./AgentSafetyRules.vue";

// On/off/watch switch for whether the safety judge runs; the policy below only applies when this is not off. Watch
// judges and logs every command without holding any. The judge's model is chosen on the Models tab, not here.

const t = useT();

const { settings, patch, refusal } = useSandboxSettings();
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
        <!-- Which commands reach this gate at all is reference, not a setting: behind the (i), so the page holds controls. -->
        <template #info>
            <InfoDialog :title="t(`sandbox.agentSafetyRules.whatGetsStopped`)" size="lg"><AgentSafetyRules /></InfoDialog>
        </template>
        <Row icon="shield" :title="t(`sandbox.agentSafetyJudge.toJudge`)" :description="t(`sandbox.agentSafetyJudge.whetherVerdictStopCommand`)">
            <template #control>
                <SegmentedControl
                    :model-value="mode"
                    :options="MODES"
                    @update:model-value="(commandJudge: string) => patch({ commandJudge: commandJudge as `off` | `watch` | `on` })"
                />
            </template>
        </Row>

        <!-- Read-only here: a reader wants which model applies, not a way to change it; editing happens on Models. -->
        <Row icon="sparkles" :title="t(`sandbox.agentSafetyJudge.judgeModel`)" :description="t(`sandbox.agentSafetyJudge.modelReadsPolicy`)">
            <!-- `as` keeps native link behavior (hover preview, cmd-click new tab) while Button supplies the control styling. -->
            <!-- Names the job, so Models opens on the judge's own row rather than on a Simple view that has none. -->
            <template #control>
                <Button :as="RouterLink" :to="{ name: `sandbox`, params: { tab: `agent` }, query: { job: `safety-judge` } }" size="small" tier="quiet" tone="accent">
                    {{ t(`sandbox.agentSafetyJudge.changeInModels`) }}
                </Button>
            </template>
            <template v-if="mode !== `off`" #below>
                <div class="flex flex-col gap-2">
                    <p v-if="judgeChain.length > 0" class="text-2xs text-muted">
                        <span class="text-content">{{ t(`sandbox.agentSafetyJudge.judgedBy`) }}</span
                        >: {{ judgeChain.join(t(`sandbox.agentSafetyJudge.then`)) }}.
                    </p>
                    <!-- Judge on but no model set: nothing reads the policy; flagged commands fall back to the standing rule. -->
                    <p v-else-if="settings !== undefined" class="text-2xs text-warning">
                        <span class="font-medium">{{ t(`sandbox.agentSafetyJudge.noModelSetJudge`) }}</span
                        >{{ t(`sandbox.agentSafetyJudge.nothingReadsPolicyEvery`) }}
                    </p>
                </div>
            </template>
        </Row>
        <RowNote v-if="refusal !== undefined" variant="block"><Notice :of="refusal" /></RowNote>
    </RowGroup>
</template>
