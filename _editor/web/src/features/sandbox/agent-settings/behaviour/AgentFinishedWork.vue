<script setup lang="ts">
import { Row, RowGroup, SegmentedControl } from "@intentic/ui";
import ToggleSwitch from "primevue/toggleswitch";
import { useSandboxSettings } from "../../overview/useSandboxSettings";
import { AUTO_LAND_RULE, AUTO_VERSION_RULE, NAMED_RULES } from "../../environment/rules";
import { useRules } from "../../environment/useRules";
import FinishedWorkInfo from "./FinishedWorkInfo.vue";

// What happens after an agent stops: whether finished work reaches the user by itself, and how long the agent
// that produced it keeps its card and checkout.

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
    upsert(AUTO_LAND_RULE);
};

// The versioner built-in, a rule like the land verdict above: absent means the owner commits, as a developer does.
const version = () => byId(NAMED_RULES.version);

const setVersion = (on: boolean): void => {
    if (!on) {
        remove(NAMED_RULES.version);
        return;
    }
    upsert(AUTO_VERSION_RULE);
};

// Days; `0` disables the sweep. Values are string spellings since SegmentedControl works in strings.
const RETENTION_OPTIONS = [
    { label: `1 day`, value: `1` },
    { label: `3 days`, value: `3` },
    { label: `1 week`, value: `7` },
    { label: `Never`, value: `0` },
];
</script>

<template>
    <RowGroup label="Finished work">
        <template #info><FinishedWorkInfo /></template>

<!-- Daemon-side, not a browser preference, since automation-opened agents (Discord, webhooks, email) finish with no browser present. -->
        <Row
            icon="download"
            title="Land finished work automatically"
            description="Apply completed work directly to workspace as uncommitted changes."
        >
            <template #control>
                <ToggleSwitch :model-value="land()?.enabled ?? false" :disabled="settings === undefined" @update:model-value="setLand" />
            </template>
        </Row>

<!-- Worktrees are cut from HEAD, so an owner who never commits would start every agent on a tree without the last one's work. -->
        <Row
            icon="history"
            title="Save a version of accepted work"
            description="Commit what each landed agent changed, under a subject written for it, and your own edits before the next agent starts."
        >
            <template #control>
                <ToggleSwitch :model-value="version()?.enabled ?? false" :disabled="settings === undefined" @update:model-value="setVersion" />
            </template>
        </Row>

<!-- The Finished lane has no other exit, so without a sweep the board and its worktrees grow indefinitely. -->
        <Row
            icon="box"
            title="Archive finished agents"
            description="Archive quiet agents and reclaim worktrees (diffs and history are kept)."
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
