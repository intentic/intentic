<script setup lang="ts">
import { Button, Row, RowGroup, RowNote, SegmentedControl } from "@intentic/ui";
import { computed } from "vue";
import { RouterLink } from "vue-router";
import { modelChoiceLabel } from "../../../chat/models/modelPins";
import { useRoleModel } from "../../../chat/accounts/roleModel";
import { useSandboxSettings } from "../../overview/useSandboxSettings";

// On/off/watch switch for whether the safety judge runs; the policy below only applies when this is not off. Watch
// judges and logs every command without holding any. The judge's model is chosen on the Models tab, not here.

const { settings, patch } = useSandboxSettings();
const judge = useRoleModel(`safety-judge`);

// Off, watch, on, in escalating order; watch records a verdict but never holds the command.
const MODES = [
    { label: `Off`, value: `off` },
    { label: `Watch`, value: `watch` },
    { label: `On`, value: `on` },
];

const mode = computed(() => settings.value?.commandJudge ?? `on`);

// Resolved chain for role `safety-judge`; empty means no model set, judge falls back to the standing rule.
const judgeChain = computed<readonly string[]>(() => judge.chain.value.map(modelChoiceLabel));
</script>

<template>
    <RowGroup label="Safety judge">
        <RowNote>
            Before a flagged command runs, a model reads your policy below and decides whether to allow it, ask you, or refuse it. This is whether
            that happens.
        </RowNote>

        <Row icon="shield" title="When to judge" description="Whether a verdict can stop a command.">
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
                        Nothing is judged, nothing is recorded, and no card is raised. Your policy is not read at all.
                    </p>
                    <p v-else-if="mode === `watch`" class="text-2xs text-muted">
                        Every flagged command is judged and the verdict is recorded below, and nothing is ever held. Read a few days of
                        <span class="text-content">Recent decisions</span> to see what your policy would have stopped before letting it stop
                        anything.
                    </p>
                    <p v-else class="text-2xs text-muted">The verdict decides: allowed silently, held on a card, or refused.</p>
                </div>
            </template>
        </Row>

        <!-- Read-only here: a reader wants which model applies, not a way to change it; editing happens on Models. -->
        <Row icon="sparkles" title="Judge model" description="Which model reads the policy.">
            <!-- `as` keeps native link behavior (hover preview, cmd-click new tab) while Button supplies the control styling. -->
            <template #control>
                <Button :as="RouterLink" :to="{ name: `sandbox`, params: { tab: `agent` }, query: {} }" size="small" :text="true">
                    Change in Models
                </Button>
            </template>
            <template #below>
                <div class="flex flex-col gap-2">
                    <p v-if="mode === `off`" class="text-2xs text-subtle">Nothing judges commands at the moment, so no model is in use.</p>
                    <p v-else-if="judgeChain.length > 0" class="text-2xs text-muted">
                        <span class="text-content">Judged by</span>: {{ judgeChain.join(`, then `) }}.
                    </p>
                    <!-- Judge on but no model set: nothing reads the policy; flagged commands fall back to the standing rule. -->
                    <p v-else-if="settings !== undefined" class="text-2xs text-warning">
                        <span class="font-medium">No model is set for the judge</span>, so nothing reads your policy and every flagged command falls back
                        to the standing rule alone. Set one in Models.
                    </p>

                    <!-- The only automatic judge that reads a command whose text may itself be arguing for its own approval. -->
                    <p v-if="mode !== `off`" class="text-2xs text-subtle">
                        Worth a better model than the rest of the automatic jobs: it reads the command as data, and on a turn that has taken in
                        something from outside, that text may be arguing for its own approval.
                    </p>
                </div>
            </template>
        </Row>
    </RowGroup>
</template>
