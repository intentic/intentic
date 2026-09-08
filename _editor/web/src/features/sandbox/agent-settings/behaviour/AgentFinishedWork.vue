<script setup lang="ts">
import { Row, RowGroup, SegmentedControl } from "@intentic/ui";
import ToggleSwitch from "primevue/toggleswitch";
import { useSandboxSettings } from "../../overview/useSandboxSettings";
import { NAMED_RULES } from "../../environment/rules";
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
    upsert({
        id: NAMED_RULES.land,
        label: `Land finished work automatically`,
        moment: `agent.finished`,
        action: { kind: `verdict`, verdict: `allow` },
        enabled: true,
    });
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

        <!--
            Daemon-side, not a browser preference, since automation-opened agents (Discord, webhooks, email) finish with
            no browser present. Off by default; per-agent exceptions live on the review panel's hold toggle.
        -->
        <Row
            icon="download"
            title="Land finished work automatically"
            description="Apply completed work directly to workspace as uncommitted changes."
        >
            <template #control>
                <ToggleSwitch :model-value="land()?.enabled ?? false" :disabled="settings === undefined" @update:model-value="setLand" />
            </template>
        </Row>

        <!--
            The Finished lane has no other exit, so without a sweep the board and its worktrees grow indefinitely.
            Archiving is lossless (diffs and history are kept); "Never" keeps every checkout instead.
        -->
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
