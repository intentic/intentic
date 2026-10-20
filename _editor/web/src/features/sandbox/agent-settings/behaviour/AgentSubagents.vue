<script setup lang="ts">
import { Icon, ui, Notice, Row, RowGroup, RowNote } from "@intentic/ui";
import ToggleSwitch from "primevue/toggleswitch";
import { computed } from "vue";
import { RouterLink } from "vue-router";
import { useSandboxSettings } from "../../../../models/sandbox/useSandboxSettings";
import { commitCount } from "../models/numberInputs";
import { postureOf } from "../../guardrails/spawnPosture";
import { useT } from "@intentic/ui/i18n";

// Three ceilings over one activity, starting subagents, and how long a subagent refused for a spent allowance waits for
// its reset before it stops instead (childRerunHorizonHours): how wide one fan-out is, the lifetime budget per conversation,
// and how deep delegation nests. Then the allowance plan (subagentBudget, subagentReservePercent): whether the daemon starts
// a subagent only where an account can carry it, and how much of each window it leaves for the owner's own chats. They bound every subagent, spawned or started in-process by the runtime's own Agent
// tool. Raising only the width just hits the per-conversation ceiling later. Bounds mirror SandboxSettingsSchema so the
// box never accepts a number the save would reject. Whether it may spawn one at all (a conversation of its own, on any
// provider) is a guardrail, set on Guardrails beside every other thing it may do without asking; it led this group
// until 2026-10-16, and the group still says when it is refused, since that changes what these bound.
const t = useT();

const { settings, patch, refusal } = useSandboxSettings();

const AT_ONCE = { min: 1, max: 200 };
const PER_TURN = { min: 1, max: 2000 };
const DEPTH = { min: 1, max: 10 };
const RERUN_HOURS = { min: 0, max: 24 };
const RESERVE = { min: 0, max: 50 };

// Whether spawning is refused, which leaves the ceilings below bounding only the subagents a runtime starts itself.
const spawnDenied = computed(() => postureOf(settings.value?.actionRules ?? {}) === `deny`);
const GUARDRAILS = { name: `sandbox`, params: { tab: `guardrails` } } as const;
</script>

<template>
    <RowGroup data-setting="agent-subagents" :label="t(`shared.subagents`)" equal-rows>
        <RowNote>
            {{ spawnDenied ? t(`sandbox.agentSubagents.spawningRefusedOutright`) : t(`sandbox.agentSubagents.whetherInGuardrails`) }}
            <RouterLink :to="GUARDRAILS" :class="ui.textButton()"
                >{{ t(`sandbox.sandboxNav.guardrails`) }}<Icon name="arrow-right" class="text-2xs"
            /></RouterLink>
        </RowNote>

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
                    :class="ui.input({ size: `sm` }, 'w-20 text-right')"
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
                    :class="ui.input({ size: `sm` }, 'w-20 text-right')"
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
                    :class="ui.input({ size: `sm` }, 'w-20 text-right')"
                    @change="
                        (event: Event) => commitCount(event, settings?.subagentDepth ?? 3, DEPTH, (subagentDepth: number) => patch({ subagentDepth }))
                    "
                />
            </template>
        </Row>
        <!-- Nobody watches a subagent, so a spent allowance either waits for the reset by itself or ends and says where else the work can go. -->
        <Row icon="clock" :title="t(`sandbox.agentSubagents.waitForReset`)" :description="t(`sandbox.agentSubagents.waitForResetHours`)">
            <template #control>
                <input
                    type="number"
                    :min="RERUN_HOURS.min"
                    :max="RERUN_HOURS.max"
                    :value="settings?.childRerunHorizonHours ?? 6"
                    :disabled="settings === undefined"
                    :aria-label="t(`sandbox.agentSubagents.waitForReset`)"
                    :class="ui.input({ size: `sm` }, 'w-20 text-right')"
                    @change="
                        (event: Event) =>
                            commitCount(event, settings?.childRerunHorizonHours ?? 6, RERUN_HOURS, (childRerunHorizonHours: number) =>
                                patch({ childRerunHorizonHours }),
                            )
                    "
                />
            </template>
        </Row>
        <!-- The daemon's own answer to a fan-out wider than an account carries: it places each child, and holds the rest as pending. -->
        <Row icon="usage" :title="t(`sandbox.agentSubagents.planByAllowance`)" :description="t(`sandbox.agentSubagents.planByAllowanceDescription`)">
            <template #control>
                <ToggleSwitch
                    :model-value="settings?.subagentBudget ?? true"
                    :disabled="settings === undefined"
                    :aria-label="t(`sandbox.agentSubagents.planByAllowance`)"
                    @update:model-value="(subagentBudget: boolean) => patch({ subagentBudget })"
                />
            </template>
        </Row>
        <Row icon="user" :title="t(`sandbox.agentSubagents.keepRoomForYou`)" :description="t(`sandbox.agentSubagents.keepRoomForYouDescription`)">
            <template #control>
                <input
                    type="number"
                    :min="RESERVE.min"
                    :max="RESERVE.max"
                    :value="settings?.subagentReservePercent ?? 10"
                    :disabled="settings === undefined || settings.subagentBudget === false"
                    :aria-label="t(`sandbox.agentSubagents.keepRoomForYou`)"
                    :class="ui.input({ size: `sm` }, 'w-20 text-right')"
                    @change="
                        (event: Event) =>
                            commitCount(event, settings?.subagentReservePercent ?? 10, RESERVE, (subagentReservePercent: number) =>
                                patch({ subagentReservePercent }),
                            )
                    "
                />
            </template>
        </Row>
        <RowNote v-if="refusal !== undefined" variant="block"><Notice :of="refusal" /></RowNote>
    </RowGroup>
</template>
