<script setup lang="ts">
import { Row, RowGroup, SegmentedControl } from "@intentic/ui";
import ToggleSwitch from "primevue/toggleswitch";
import { useSandboxSettings } from "../../overview/useSandboxSettings";
import { autoLandRule, autoVersionRule, NAMED_RULES } from "../../environment/rules";
import { useRules } from "../../environment/useRules";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";

// What happens after an agent stops: whether finished work reaches the user by itself, and how long the agent
// that produced it keeps its card and checkout.

const t = useT();

const { settings, patch } = useSandboxSettings();
const { byId, upsert, remove } = useRules();

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

const setVersion = (on: boolean): void => {
    if (!on) {
        remove(NAMED_RULES.version);
        return;
    }
    upsert(autoVersionRule());
};

// Days; `0` disables the sweep. Values are string spellings since SegmentedControl works in strings.
const RETENTION_OPTIONS = computed(() => [
    { label: t(`sandbox.agentFinishedWork.n1Day`), value: `1` },
    { label: t(`sandbox.agentFinishedWork.n3Days`), value: `3` },
    { label: t(`sandbox.agentFinishedWork.n1Week`), value: `7` },
    { label: t(`shared.never`), value: `0` },
]);
</script>

<template>
    <RowGroup :label="t(`sandbox.agentFinishedWork.finishedWork`)">
        <!-- Daemon-side, not a browser preference, since automation-opened agents (Discord, webhooks, email) finish with no browser present. -->
        <Row
            icon="download"
            :title="t(`shared.landFinishedWorkAutomatically`)"
            :description="t(`sandbox.agentFinishedWork.applyCompletedWorkDirectly`)"
        >
            <template #control>
                <ToggleSwitch :model-value="land()?.enabled ?? false" :disabled="settings === undefined" @update:model-value="setLand" />
            </template>
        </Row>

        <!-- Worktrees are cut from HEAD, so an owner who never commits would start every agent on a tree without the last one's work. -->
        <Row icon="history" :title="t(`shared.saveVersionAcceptedWork`)" :description="t(`sandbox.agentFinishedWork.commitWhatEachLanded`)">
            <template #control>
                <ToggleSwitch :model-value="version()?.enabled ?? false" :disabled="settings === undefined" @update:model-value="setVersion" />
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
    </RowGroup>
</template>
