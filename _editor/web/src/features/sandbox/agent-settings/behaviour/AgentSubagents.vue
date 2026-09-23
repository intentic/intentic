<script setup lang="ts">
import type { AdmissionRule } from "@intentic/sandbox-contract";
import { ui, Picker, Row, RowGroup } from "@intentic/ui";
import { computed } from "vue";
import { useSandboxSettings } from "../../overview/useSandboxSettings";
import { commitCount } from "../models/numberInputs";
import { type Posture, postureOf, postures, withPosture } from "../safety/spawnPosture";
import { useT } from "@intentic/ui/i18n";

// Four rows over one activity: whether it may delegate at all, how wide one fan-out is, the lifetime budget per
// conversation, and how deep delegation nests. Raising only the width just hits the per-conversation ceiling
// later. Bounds mirror SandboxSettingsSchema so the box never accepts a number the save would reject.
const t = useT();

const { settings, patch } = useSandboxSettings();

const AT_ONCE = { min: 1, max: 200 };
const PER_TURN = { min: 1, max: 2000 };
const DEPTH = { min: 1, max: 10 };

// Stored in `actionRules` (allow/ask/refuse), not a number: the only row here that isn't a ceiling. Postures
// and the merge logic live in spawnPosture.ts.
const rules = computed<Readonly<Record<string, AdmissionRule>>>(() => settings.value?.actionRules ?? {});
const posture = computed<Posture>(() => postureOf(rules.value));
const setPosture = (next: Posture): void => patch({ actionRules: withPosture(rules.value, next) });

// Whether the three ceilings below bound anything, since a denied posture makes tuning them moot.
const spawnDenied = computed(() => posture.value === `deny`);
</script>

<template>
    <RowGroup :label="t(`shared.subagents`)">
        <!-- Leads the group: narrows from "may it delegate" to "how far", the natural reading order. -->
        <Row icon="robot" :title="t(`sandbox.agentSubagents.startAgentsOwn`)" :description="t(`sandbox.agentSubagents.childAgentSpendsSame`)">
            <template #control>
                <Picker
                    :model-value="posture"
                    :options="postures()"
                    :disabled="settings === undefined"
                    class="w-36 justify-between text-xs"
                    :aria-label="t(`sandbox.agentSubagents.startAgentsOwn`)"
                    :header="t(`sandbox.agentSubagents.startAgentsOwn`)"
                    @update:model-value="(next: Posture | undefined) => next !== undefined && setPosture(next)"
                />
            </template>
            <template v-if="spawnDenied" #below>
                <p class="text-2xs text-muted">
                    {{ t(`sandbox.agentSubagents.delegationRefusedOutrightThree`) }}
                </p>
            </template>
        </Row>

        <!-- First ceiling a fan-out hits; the assistant stops rather than retries here, so a low number serializes work instead of failing it. -->
        <Row
            icon="users"
            :title="t(`sandbox.agentSubagents.subagentsAtOnce`)"
            :description="t(`sandbox.agentSubagents.maximumDelegatedAgentsRunning`)"
        >
            <template #control>
                <input
                    type="number"
                    :min="AT_ONCE.min"
                    :max="AT_ONCE.max"
                    :value="settings?.subagentsAtOnce ?? 20"
                    :disabled="settings === undefined"
                    :aria-label="t(`sandbox.agentSubagents.subagentsAtOnce`)"
                    :class="ui.inputSm('w-20 text-right')"
                    @change="
                        (event: Event) =>
                            commitCount(event, settings?.subagentsAtOnce ?? 20, AT_ONCE, (subagentsAtOnce: number) => patch({ subagentsAtOnce }))
                    "
                />
            </template>
        </Row>

        <!-- Bounds a long conversation's total rather than one burst: twenty rounds of five reach the same count as one round of a hundred. -->
        <Row
            icon="clone"
            :title="t(`sandbox.agentSubagents.subagentsPerConversation`)"
            :description="t(`sandbox.agentSubagents.totalDelegatedAgentsAllowed`)"
        >
            <template #control>
                <input
                    type="number"
                    :min="PER_TURN.min"
                    :max="PER_TURN.max"
                    :value="settings?.subagentsPerTurn ?? 200"
                    :disabled="settings === undefined"
                    :aria-label="t(`sandbox.agentSubagents.subagentsPerConversation`)"
                    :class="ui.inputSm('w-20 text-right')"
                    @change="
                        (event: Event) =>
                            commitCount(event, settings?.subagentsPerTurn ?? 200, PER_TURN, (subagentsPerTurn: number) => patch({ subagentsPerTurn }))
                    "
                />
            </template>
        </Row>

        <!-- The only one of the three whose runaway case multiplies rather than widens. -->
        <Row icon="sitemap" :title="t(`sandbox.agentSubagents.nestingDepth`)" :description="t(`sandbox.agentSubagents.maximumDelegationDepth`)">
            <template #control>
                <input
                    type="number"
                    :min="DEPTH.min"
                    :max="DEPTH.max"
                    :value="settings?.subagentDepth ?? 3"
                    :disabled="settings === undefined"
                    :aria-label="t(`sandbox.agentSubagents.nestingDepth`)"
                    :class="ui.inputSm('w-20 text-right')"
                    @change="
                        (event: Event) => commitCount(event, settings?.subagentDepth ?? 3, DEPTH, (subagentDepth: number) => patch({ subagentDepth }))
                    "
                />
            </template>
        </Row>
    </RowGroup>
</template>
