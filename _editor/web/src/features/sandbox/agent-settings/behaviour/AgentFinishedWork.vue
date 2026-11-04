<script setup lang="ts">
import { Button, Notice, Row, RowGroup, RowNote, SegmentedControl } from "@intentic/ui";
import ToggleSwitch from "primevue/toggleswitch";
import { useRole } from "../../../../client/sandbox/useRole";
import { useSandboxMode } from "../../../../models/sandbox/mode/useSandboxMode";
import { useSandboxSettings } from "../../../../models/sandbox/useSandboxSettings";
import { autoLandRule, autoPushRule, autoVersionRule, NAMED_RULES } from "../../../../models/sandbox/environment/rules";
import { useRules } from "../../../../models/sandbox/environment/useRules";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";

// What happens after an agent stops: whether finished work reaches the user by itself, whether it is committed and kept
// up with what others pushed, and how long the agent that produced it keeps its card and checkout.

const t = useT();

const { settings, patch, refusal } = useSandboxSettings();
const { byId, upsert, remove, refusal: rulesRefusal } = useRules();
// Two saves write this group, the settings' own and the rules'; either one refused is said once, under the group.
const groupRefusal = computed(() => refusal.value ?? rulesRefusal.value);

// A HANDS-OFF SANDBOX OWNS THE FIRST THREE ROWS (settings `mode`, sandbox-mode.ts): its settings store keeps landing,
// saving and backing up switched on whatever a save says, so each row says what the sandbox does instead of offering a
// switch that would snap back. Setting them by hand is one press away, and that press is the switch to hands-on, which
// keeps all three as they stand.
const { mode, switchTo, saving: switching } = useSandboxMode();
const { canShip } = useRole();
const handsOff = computed(() => mode.value === `hands-off`);
const setMyself = (): void => void switchTo(`hands-on`);

// A verdict rule (allow/hold, the same vocabulary as permission rules), not a bool: the landing pass always
// runs, the rule decides which way. No rule means held, so switching off deletes the rule rather than writing `hold`.
const land = () => byId(NAMED_RULES.land);

const setLand = (on: boolean): void => {
    if (!on) {
        remove(NAMED_RULES.land);
        return;
    }
    upsert(autoLandRule());
};

// The versioner built-in, a rule like the land verdict above: absent means the owner commits, as a developer does.
const version = () => byId(NAMED_RULES.version);

// Switching the version off takes the back-up with it: with nothing committed by a land, it would push nothing.
const setVersion = (on: boolean): void => {
    if (!on) {
        remove(NAMED_RULES.version, NAMED_RULES.push);
        return;
    }
    upsert(autoVersionRule());
};

// The back-up built-in: what the version above committed is pushed, opt-in. Absent means the owner presses Back up.
const versioned = computed(() => version()?.enabled === true);
const backUp = () => byId(NAMED_RULES.push);

const setBackUp = (on: boolean): void => {
    if (!on) {
        remove(NAMED_RULES.push);
        return;
    }
    upsert(autoPushRule());
};

// Days; `0` disables the sweep. Values are string spellings since SegmentedControl works in strings.
const RETENTION_OPTIONS = computed(() => [
    { label: t(`sandbox.agentFinishedWork.n1Day`), value: `1` },
    { label: t(`sandbox.agentFinishedWork.n3Days`), value: `3` },
    { label: t(`sandbox.agentFinishedWork.n1Week`), value: `7` },
    { label: t(`sandbox.words.never`), value: `0` },
]);
const HELD_RETENTION_OPTIONS = computed(() => [
    ...RETENTION_OPTIONS.value.slice(0, -1),
    { label: t(`sandbox.agentFinishedWork.held14Days`), value: `14` },
    ...RETENTION_OPTIONS.value.slice(-1),
]);
</script>

<template>
    <RowGroup data-setting="agent-finished-work" :label="t(`sandbox.agentFinishedWork.finishedWork`)">
        <!-- Hands-off: what the next three rows are, said once above them, with the one way to take them over. -->
        <RowNote v-if="handsOff" variant="block" data-finished-work-hands-off>
            <div class="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
                <span class="min-w-0 flex-1 text-xs text-muted">{{ t(`sandbox.mode.finishedWork.note`) }}</span>
                <Button
                    v-if="canShip"
                    size="small"
                    tier="boring"
                    :label="t(`sandbox.mode.finishedWork.setMyself`)"
                    :loading="switching"
                    @click="setMyself"
                />
            </div>
        </RowNote>

        <!-- Daemon-side, not a browser preference, since automation-opened agents (Discord, webhooks, email) finish with no browser present. -->
        <Row
            icon="download"
            :title="t(`sandbox.words.landFinishedWorkAutomatically`)"
            :description="t(`sandbox.agentFinishedWork.applyCompletedWorkDirectly`)"
        >
            <template #control>
                <span v-if="handsOff" class="text-xs text-muted">{{ t(`sandbox.mode.finishedWork.byItself`) }}</span>
                <ToggleSwitch v-else :model-value="land()?.enabled ?? false" :disabled="settings === undefined" @update:model-value="setLand" />
            </template>
        </Row>

        <!-- Worktrees are cut from HEAD, so an owner who never commits would start every agent on a tree without the last one's work. -->
        <Row icon="history" :title="t(`sandbox.words.saveVersionAcceptedWork`)" :description="t(`sandbox.agentFinishedWork.commitWhatEachLanded`)">
            <template #control>
                <span v-if="handsOff" class="text-xs text-muted">{{ t(`sandbox.mode.finishedWork.byItself`) }}</span>
                <ToggleSwitch v-else :model-value="version()?.enabled ?? false" :disabled="settings === undefined" @update:model-value="setVersion" />
            </template>
        </Row>

        <!-- Under the versioner, and only with it on: it pushes what a land's version committed, nothing else. -->
        <Row icon="upload" :title="t(`sandbox.agentFinishedWork.backUpSaved`)" :description="t(`sandbox.agentFinishedWork.backUpSavedNote`)">
            <template #control>
                <span v-if="handsOff" class="text-xs text-muted">{{ t(`sandbox.mode.finishedWork.byItself`) }}</span>
                <ToggleSwitch
                    v-else
                    :model-value="versioned && (backUp()?.enabled ?? false)"
                    :disabled="settings === undefined || !versioned"
                    @update:model-value="setBackUp"
                />
            </template>
        </Row>

        <!-- Under the versioner: once work is committed here, what others pushed meanwhile is merged in within minutes, so
             an agent meets a clash with it at its own land instead of the owner at their next pull. -->
        <Row icon="sync" :title="t(`sandbox.agentFinishedWork.followOrigin`)" :description="t(`sandbox.agentFinishedWork.followOriginNote`)">
            <template #control>
                <ToggleSwitch
                    :model-value="settings?.followOrigin ?? true"
                    :disabled="settings === undefined"
                    @update:model-value="(value: boolean) => patch({ followOrigin: value })"
                />
            </template>
        </Row>

        <!-- The Finished lane has no other exit, so without a sweep the board and its worktrees grow indefinitely. -->
        <Row
            icon="box"
            :title="t(`sandbox.agentFinishedWork.archiveFinishedAgents`)"
            :description="t(`sandbox.agentFinishedWork.archiveQuietAgentsReclaim`)"
        >
            <template #control>
                <SegmentedControl
                    :model-value="String(settings?.agentRetentionDays ?? 3)"
                    :options="RETENTION_OPTIONS"
                    @update:model-value="(days: string) => patch({ agentRetentionDays: Number(days) })"
                />
            </template>
        </Row>
        <Row icon="box" :title="t(`sandbox.agentFinishedWork.heldCheckout`)" :description="t(`sandbox.agentFinishedWork.heldCheckoutNote`)">
            <template #control>
                <SegmentedControl
                    :model-value="String(settings?.heldCheckoutDays ?? 7)"
                    :options="HELD_RETENTION_OPTIONS"
                    @update:model-value="(days: string) => patch({ heldCheckoutDays: Number(days) })"
                />
            </template>
        </Row>
        <RowNote v-if="groupRefusal !== undefined" variant="block"><Notice :of="groupRefusal" /></RowNote>
    </RowGroup>
</template>
