<script setup lang="ts">
import { Row, RowGroup, Segmented } from "@intentic/ui";
import ToggleSwitch from "primevue/toggleswitch";
import { useSandboxSettings } from "../../../composables/sandbox/useSandboxSettings";
import FinishedWorkInfo from "./FinishedWorkInfo.vue";

/* WHAT HAPPENS AFTER AN AGENT STOPS — to its work, and then to the agent. Both answer the same question at
 * different distances: does finished work reach the user by itself, and how long does the agent that produced
 * it keep its card and its checkout. */

const { settings, patch } = useSandboxSettings();

// How long a finished agent stays on the fleet board before the daemon archives it (and reclaims its worktree
// checkout). Days, because the sweep runs hourly and the whole point is "after you've stopped thinking about
// it"; 0 turns the sweep off entirely. Segmented speaks strings, the setting is a number of days — so the
// option values are the decimal spellings and this is where they come back.
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

        <!-- Auto-land — the sandbox's standing answer to "does finished work reach my workspace by itself".
             Daemon-side rather than a browser preference, because automation-opened agents (Discord, webhooks,
             email) finish turns with no browser in the room. Off is the default and turns every clean completion
             into a "Ready to land" card; per-agent exceptions live on the review panel's hold toggle. -->
        <Row
            icon="download"
            title="Land finished work automatically"
            description="When an agent finishes cleanly, apply its work to your workspace as uncommitted changes right away. Off, it waits on the agent's branch until you land it."
        >
            <template #control>
                <ToggleSwitch
                    :model-value="settings?.autoLand ?? false"
                    :disabled="settings === undefined"
                    @update:model-value="(value: boolean) => patch({ autoLand: value })"
                />
            </template>
        </Row>

        <!-- Agent retention — how long a finished agent keeps its card AND its worktree checkout. The Finished
             lane has no exit of its own, so without this the board (and the disk behind it) grows for the life
             of the sandbox. Archiving is lossless, which is what makes an automatic sweep acceptable at all:
             "Never" is offered, but it costs a checkout per agent forever. -->
        <Row
            icon="box"
            title="Archive finished agents"
            description="Take a finished agent off the board after it has been quiet this long, and reclaim its worktree. Its branch, diff and conversation are kept — restore it any time from the board's archive."
        >
            <template #control>
                <Segmented
                    :model-value="String(settings?.agentRetentionDays ?? 3)"
                    :options="RETENTION_OPTIONS"
                    @update:model-value="(days: string) => patch({ agentRetentionDays: Number(days) })"
                />
            </template>
        </Row>
    </RowGroup>
</template>
