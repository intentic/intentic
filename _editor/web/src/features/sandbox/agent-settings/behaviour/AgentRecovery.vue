<script setup lang="ts">
import {
    HANDOFF_MODES,
    type KeepWarmSettings,
    type LimitHandoff,
    KeepWarmSettingsSchema,
    type LimitPolicy,
    type RetryPolicy,
    type RoomPolicy,
    type TurnBreak,
    type TurnBreakPolicy,
} from "@intentic/sandbox-contract";
import { Notice, Row, RowGroup, RowNote, SegmentedControl } from "@intentic/ui";
import ToggleSwitch from "primevue/toggleswitch";
import { computed } from "vue";
import { breakAnswers, breakLabel } from "../../../chat/run/turnBreak";
import { handoffLabel } from "../../../chat/run/handoffChoice";
import { useSandboxSettings } from "../../overview/useSandboxSettings";
import { useT } from "@intentic/ui/i18n";

// The standing answer to each ending's one question, in the same words the chat asks it in (chat/run/turnBreak.ts).
// One answer per row, never a set of switches over the same wall: two independent booleans over a spent allowance
// spelled a fourth posture ("move, else hold") nobody would choose, and left every surface guessing which of them was
// the one in force. Every ending that ran something starts at `wait`: a re-run spends the owner's allowance on a turn
// already sent once. Low memory starts at `resend`: nothing ran, so sending it once there is room spends nothing twice.

const t = useT();

const { settings, patch, refusal } = useSandboxSettings();
// Keep-warm's rows save through a second instance, so a refused write is said under keep-warm, not the turn breaks.
const { patch: patchWarm, refusal: keepWarmRefusal } = useSandboxSettings();

// Built in a computed, not a table at import: `t` reads the active language when it is CALLED
// (docs/architecture/languages.md).
const rowsFor = (ending: TurnBreak) =>
    computed(() => breakAnswers(ending).map((answer) => ({ label: answer.label, value: answer.value, title: { title: answer.label, note: answer.brief } })));
const limitRows = rowsFor(`limit`);
const outageRows = rowsFor(`outage`);
const stoppedRows = rowsFor(`stopped`);
const memoryRows = rowsFor(`memory`);

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
const memoryPolicy = computed<TurnBreakPolicy>({
    get: () => settings.value?.memoryPolicy ?? `resend`,
    set: (value) => patch({ memoryPolicy: value as RoomPolicy }),
});

// How a turn a spent allowance held continues once its cache is cold (chat/run/handoffChoice.ts): the chat's card asks
// each time and preselects this, and a booked send (a move, a resend at the reset) uses it unless someone picked there.
const handoffRows = computed(() => [
    { label: t(`sandbox.agentRecovery.handoffSuggested`), value: `suggested` as LimitHandoff, title: { title: t(`sandbox.agentRecovery.handoffSuggested`), note: t(`sandbox.agentRecovery.handoffSuggestedBrief`) } },
    ...HANDOFF_MODES.map((mode) => ({ label: handoffLabel(mode), value: mode as LimitHandoff, title: { title: handoffLabel(mode), note: t(`chat.handoffChoice.${mode}Brief`) } })),
]);
const limitHandoff = computed<LimitHandoff>({
    get: () => settings.value?.limitHandoff ?? `suggested`,
    set: (value) => patch({ limitHandoff: value }),
});

// The suggestion's two lines. 0 is a real value (never suggest carrying, always suggest a summary); an emptied field
// clamps to the bound rather than falling back to the saved number, and the input is written back so a refused value
// doesn't linger.
const setTokens = (key: `limitMoveCarryUnder` | `handoffSummaryOver`) => (event: Event): void => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement)) {
        return;
    }
    const value = Math.max(0, Math.round(Number(input.value) || 0));
    input.value = String(value);
    patch({ [key]: value });
};
const setLimitMoveCarryUnder = setTokens(`limitMoveCarryUnder`);
const setHandoffSummaryOver = setTokens(`handoffSummaryOver`);

// keep-warm's knobs travel as one object, so every row writes the whole of it back.
const keepWarm = computed((): KeepWarmSettings => settings.value?.keepWarm ?? KeepWarmSettingsSchema.parse({}));
const patchKeepWarm = (change: Partial<KeepWarmSettings>): void => patchWarm({ keepWarm: { ...keepWarm.value, ...change } });

// One clamp for the three numeric keep-warm rows: an emptied field takes the bound, and the input shows what was kept.
const setBounded = (key: `hours` | `minTokens` | `reserve`, min: number, max: number) => (event: Event): void => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement)) {
        return;
    }
    const value = Math.min(max, Math.max(min, Math.round(Number(input.value) || 0)));
    input.value = String(value);
    patchKeepWarm({ [key]: value });
};
const setKeepWarmHours = setBounded(`hours`, 1, 8);
const setKeepWarmMinTokens = setBounded(`minTokens`, 0, 10_000_000);
const setKeepWarmReserve = setBounded(`reserve`, 0, 90);

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
    <RowGroup :label="t(`sandbox.agentRecovery.turnBreaks`)" equal-rows>
        <!-- The default for every conversation; a chat's own control writes an override for that chat alone. -->
        <Row icon="clock" :title="breakLabel(`limit`)" :description="t(`sandbox.agentRecovery.limitPolicyNote`)">
            <template #control>
                <SegmentedControl v-model="limitPolicy" :options="limitRows" size="xs" :wrap="true" :class="{ 'pointer-events-none opacity-60': settings === undefined }" />
            </template>
        </Row>

        <!-- How the held turn continues once its cache is cold: the whole session, a trimmed copy, or a summary. The chat's
             card asks each time and preselects this; measured in sandbox/bench/handoff-bench.ts. -->
        <Row icon="history" :title="t(`sandbox.agentRecovery.handoff`)" :description="t(`sandbox.agentRecovery.handoffNote`)">
            <template #control>
                <SegmentedControl v-model="limitHandoff" :options="handoffRows" size="xs" :wrap="true" :class="{ 'pointer-events-none opacity-60': settings === undefined }" />
            </template>
        </Row>
        <template v-if="limitHandoff === `suggested`">
            <Row icon="history" :title="t(`sandbox.agentRecovery.carryUnder`)" :description="t(`sandbox.agentRecovery.carryUnderNote`)">
                <template #control>
                    <input
                        type="number"
                        min="0"
                        step="10000"
                        :aria-label="t(`sandbox.agentRecovery.carryUnder`)"
                        class="ui-field-box ui-field-sm w-24 text-right"
                        :value="settings?.limitMoveCarryUnder ?? 150000"
                        :disabled="settings === undefined"
                        @change="setLimitMoveCarryUnder"
                    />
                </template>
            </Row>
            <Row icon="align-left" :title="t(`sandbox.agentRecovery.summaryOver`)" :description="t(`sandbox.agentRecovery.summaryOverNote`)">
                <template #control>
                    <input
                        type="number"
                        min="0"
                        step="10000"
                        :aria-label="t(`sandbox.agentRecovery.summaryOver`)"
                        class="ui-field-box ui-field-sm w-24 text-right"
                        :value="settings?.handoffSummaryOver ?? 700000"
                        :disabled="settings === undefined"
                        @change="setHandoffSummaryOver"
                    />
                </template>
            </Row>
        </template>

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

        <!-- The door, not an ending: a message the sandbox held because memory was short, which nothing ran. -->
        <Row icon="cpu" :title="breakLabel(`memory`)" :description="t(`sandbox.agentRecovery.memoryPolicyNote`)">
            <template #control>
                <SegmentedControl v-model="memoryPolicy" :options="memoryRows" size="xs" :wrap="true" :class="{ 'pointer-events-none opacity-60': settings === undefined }" />
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
        <RowNote v-if="refusal !== undefined" variant="block"><Notice :of="refusal" /></RowNote>
    </RowGroup>
    <!-- Off by default: each refresh spends the account's allowance on a chat nobody is using yet. -->
    <RowGroup :label="t(`sandbox.agentRecovery.keepWarmGroup`)" equal-rows>
        <Row icon="sun" :title="t(`sandbox.agentRecovery.keepWarm`)" :description="t(`sandbox.agentRecovery.keepWarmNote`)">
            <template #control>
                <ToggleSwitch
                    :model-value="keepWarm.auto"
                    :disabled="settings === undefined"
                    @update:model-value="(value: boolean) => patchKeepWarm({ auto: value })"
                />
            </template>
        </Row>
        <template v-if="keepWarm.auto">
            <Row icon="clock" :title="t(`sandbox.agentRecovery.keepWarmHours`)" :description="t(`sandbox.agentRecovery.keepWarmHoursNote`)">
                <template #control>
                    <input
                        type="number"
                        min="1"
                        max="8"
                        :aria-label="t(`sandbox.agentRecovery.keepWarmHoursLabel`)"
                        class="ui-field-box ui-field-sm w-16 text-right"
                        :value="keepWarm.hours"
                        @change="setKeepWarmHours"
                    />
                </template>
            </Row>
            <Row icon="database" :title="t(`sandbox.agentRecovery.keepWarmMinTokens`)" :description="t(`sandbox.agentRecovery.keepWarmMinTokensNote`)">
                <template #control>
                    <input
                        type="number"
                        min="0"
                        step="10000"
                        :aria-label="t(`sandbox.agentRecovery.keepWarmMinTokensLabel`)"
                        class="ui-field-box ui-field-sm w-24 text-right"
                        :value="keepWarm.minTokens"
                        @change="setKeepWarmMinTokens"
                    />
                </template>
            </Row>
        </template>
        <Row icon="usage" :title="t(`sandbox.agentRecovery.keepWarmReserve`)" :description="t(`sandbox.agentRecovery.keepWarmReserveNote`)">
            <template #control>
                <input
                    type="number"
                    min="0"
                    max="90"
                    :aria-label="t(`sandbox.agentRecovery.keepWarmReserveLabel`)"
                    class="ui-field-box ui-field-sm w-16 text-right"
                    :value="keepWarm.reserve"
                    :disabled="settings === undefined"
                    @change="setKeepWarmReserve"
                />
            </template>
        </Row>
        <RowNote v-if="keepWarmRefusal !== undefined" variant="block"><Notice :of="keepWarmRefusal" /></RowNote>
    </RowGroup>
</template>
