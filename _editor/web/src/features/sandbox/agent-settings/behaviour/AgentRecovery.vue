<script setup lang="ts">
import type { LimitPolicy, RetryPolicy, TurnBreak, TurnBreakPolicy } from "@intentic/sandbox-contract";
import { Row, RowGroup, SegmentedControl } from "@intentic/ui";
import ToggleSwitch from "primevue/toggleswitch";
import { computed } from "vue";
import { breakAnswers, breakLabel } from "../../../chat/run/turnBreak";
import { useSandboxSettings } from "../../overview/useSandboxSettings";
import { useT } from "@intentic/ui/i18n";

// The standing answer to each ending's one question, in the same words the chat asks it in (chat/run/turnBreak.ts).
// One answer per row, never a set of switches over the same wall: two independent booleans over a spent allowance
// spelled a fourth posture ("move, else hold") nobody would choose, and left every surface guessing which of them was
// the one in force. Every ending starts at `wait`: a re-run spends the owner's allowance on a turn already sent once.

const t = useT();

const { settings, patch } = useSandboxSettings();

// Built in a computed, not a table at import: `t` reads the active language when it is CALLED
// (docs/architecture/languages.md).
const rowsFor = (ending: TurnBreak) => computed(() => breakAnswers(ending).map((answer) => ({ label: answer.label, value: answer.value, title: answer.note })));
const limitRows = rowsFor(`limit`);
const outageRows = rowsFor(`outage`);
const stoppedRows = rowsFor(`stopped`);

const limitPolicy = computed<TurnBreakPolicy>({
    get: () => settings.value?.limitPolicy ?? `wait`,
    set: (value) => patch({ limitPolicy: value as LimitPolicy }),
});
const outagePolicy = computed<TurnBreakPolicy>({
    get: () => settings.value?.outagePolicy ?? `wait`,
    set: (value) => patch({ outagePolicy: value as RetryPolicy }),
});
const stopPolicy = computed<TurnBreakPolicy>({
    get: () => settings.value?.stopPolicy ?? `wait`,
    set: (value) => patch({ stopPolicy: value as RetryPolicy }),
});

// 0 is a real value (never carry); an emptied field clamps to the bound rather than falling back to the saved
// number, and the input is written back so a refused value doesn't linger.
const setLimitMoveCarryUnder = (event: Event): void => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement)) {
        return;
    }
    const limitMoveCarryUnder = Math.max(0, Math.round(Number(input.value) || 0));
    input.value = String(limitMoveCarryUnder);
    patch({ limitMoveCarryUnder });
};

const setAutomationFailureLimit = (event: Event): void => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement)) {
        return;
    }
    const automationFailureLimit = Math.min(20, Math.max(0, Math.round(Number(input.value) || 0)));
    input.value = String(automationFailureLimit);
    patch({ automationFailureLimit });
};
</script>

<template>
    <RowGroup :label="t(`sandbox.agentRecovery.turnBreaks`)">
        <!-- The default for every conversation; a chat's own control writes an override for that chat alone. -->
        <Row icon="clock" :title="breakLabel(`limit`)" :description="t(`sandbox.agentRecovery.limitPolicyNote`)">
            <template #control>
                <SegmentedControl v-model="limitPolicy" :options="limitRows" size="xs" :wrap="true" :class="{ 'pointer-events-none opacity-60': settings === undefined }" />
            </template>
        </Row>

        <!-- Carrying re-reads the whole context once and keeps what the model knew; starting fresh costs the measured brief plus a capped copy and loses the rest. -->
        <Row
            v-if="limitPolicy === `move`"
            icon="user"
            :title="t(`sandbox.agentRecovery.carrySessionContextUnder`)"
            :description="t(`sandbox.agentRecovery.tokensUnderMoveKeeps`)"
        >
            <template #control>
                <input
                    type="number"
                    min="0"
                    step="1000"
                    :aria-label="t(`sandbox.agentRecovery.contextSizeInTokens`)"
                    class="ui-field-box ui-field-sm w-24 text-right"
                    :value="settings?.limitMoveCarryUnder ?? 100000"
                    :disabled="settings === undefined"
                    @change="setLimitMoveCarryUnder"
                />
            </template>
        </Row>

        <Row icon="refresh" :title="breakLabel(`outage`)" :description="t(`sandbox.agentRecovery.outagePolicyNote`)">
            <template #control>
                <SegmentedControl v-model="outagePolicy" :options="outageRows" size="xs" :wrap="true" :class="{ 'pointer-events-none opacity-60': settings === undefined }" />
            </template>
        </Row>

        <Row icon="pause" :title="breakLabel(`stopped`)" :description="t(`sandbox.agentRecovery.stopPolicyNote`)">
            <template #control>
                <SegmentedControl v-model="stopPolicy" :options="stoppedRows" size="xs" :wrap="true" :class="{ 'pointer-events-none opacity-60': settings === undefined }" />
            </template>
        </Row>

        <!-- The one ending with nobody watching it, so it asks no question in chat and stays a switch: an update, an
             environment approval, or an image rebuild recreating the container under a running turn. -->
        <Row icon="refresh" :title="t(`sandbox.agentRecovery.resumeTurnsAfterRestart`)" :description="t(`sandbox.agentRecovery.pickUpInFlight`)">
            <template #control>
                <ToggleSwitch
                    :model-value="settings?.autoResumeOnRestart ?? false"
                    :disabled="settings === undefined"
                    @update:model-value="(value: boolean) => patch({ autoResumeOnRestart: value })"
                />
            </template>
        </Row>

        <!-- Jobs failing every run stop instead of consuming another scheduled turn. -->
        <Row
            icon="stop"
            :title="t(`sandbox.agentRecovery.stopFailingAutomation`)"
            :description="t(`sandbox.agentRecovery.disableAutomationAfterConsecutive`)"
        >
            <template #control>
                <input
                    type="number"
                    min="0"
                    max="20"
                    :aria-label="t(`sandbox.agentRecovery.consecutiveFailuresBeforeAutomation`)"
                    class="ui-field-box ui-field-sm w-16 text-right"
                    :value="settings?.automationFailureLimit ?? 0"
                    :disabled="settings === undefined"
                    @change="setAutomationFailureLimit"
                />
            </template>
        </Row>
    </RowGroup>
</template>
