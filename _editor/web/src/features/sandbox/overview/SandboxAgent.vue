<script setup lang="ts">
import { Notice, type NoticeModel, SegmentedControl } from "@intentic/ui";
import { computed } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useSandbox } from "../client/useSandbox";
import { useSandboxSettings } from "./useSandboxSettings";
import AiAccountSection from "../secrets/AiAccountSection.vue";
import AgentChangelog from "../agent-settings/behaviour/AgentChangelog.vue";
import AgentChecks from "../agent-settings/behaviour/AgentChecks.vue";
import AgentCodeSearch from "../agent-settings/behaviour/AgentCodeSearch.vue";
import AgentCommandOutput from "../agent-settings/behaviour/AgentCommandOutput.vue";
import AgentDependencies from "../agent-settings/behaviour/AgentDependencies.vue";
import AgentFinishedWork from "../agent-settings/behaviour/AgentFinishedWork.vue";
import AgentInstructions from "../agent-settings/skills/AgentInstructions.vue";
import AgentMemory from "../agent-settings/skills/AgentMemory.vue";
import AgentModels from "../agent-settings/models/AgentModels.vue";
import AgentRecovery from "../agent-settings/behaviour/AgentRecovery.vue";
import AgentRules from "../agent-settings/safety/AgentRules.vue";
import AgentSafetyJudge from "../agent-settings/safety/AgentSafetyJudge.vue";
import AgentSafetyLog from "../agent-settings/safety/AgentSafetyLog.vue";
import AgentSafetyPolicy from "../agent-settings/safety/AgentSafetyPolicy.vue";
import AgentSafetyRules from "../agent-settings/safety/AgentSafetyRules.vue";
import AgentSkills from "../agent-settings/skills/AgentSkills.vue";
import AgentSubagents from "../agent-settings/behaviour/AgentSubagents.vue";

// Agent tab: every AI-related setting for this sandbox. Each group reads and writes the same settings object via
// useSandboxSettings; only page-level state (which category, blocked/dropped notices) lives here. Categories are one
// axis, grouped by part of the agent rather than by subject and phase.

const SECTIONS = [
    { label: `Models`, value: `models` },
    { label: `Instructions`, value: `instructions` },
    { label: `Tools`, value: `tools` },
    { label: `Safety`, value: `safety` },
    { label: `Finishing`, value: `finishing` },
] as const;
type Section = (typeof SECTIONS)[number][`value`];
const DEFAULT: Section = `models`;

const route = useRoute();
const router = useRouter();

// Category lives in the query so external links land on the right one; the default writes no param. A `connect`
// param outranks the remembered section, and picking a category clears it so pills don't look stuck.
const section = computed<Section>({
    get: () => {
        if (typeof route.query[`connect`] === `string`) {
            return `models`;
        }
        return SECTIONS.find((entry) => entry.value === route.query[`section`])?.value ?? DEFAULT;
    },
    // Pushed, not replaced, so Back returns to the prior category instead of leaving the page.
    set: (value) => void router.push({ query: { ...route.query, connect: undefined, section: value === DEFAULT ? undefined : value } }),
});

const sandbox = useSandbox();
const { settings, error: settingsError, dropped: settingsDropped } = useSandboxSettings();

// Only surfaces a failed read or an unreachable sandbox; the first-load moment is silent so a notice doesn't flash
// in and shift the layout.
const settingsBlocked = computed<NoticeModel | undefined>(() => {
    if (settings.value !== undefined) {
        return undefined;
    }
    // A failed read is an error; an offline sandbox is a fact about the world, so it's a warning, not a danger tone.
    if (settingsError.value !== undefined) {
        return { tone: `danger`, title: `Couldn't read this sandbox's settings.`, detail: settingsError.value };
    }
    return sandbox.reachable.value
        ? undefined
        : { tone: `warning`, title: `Your sandbox is offline, its settings can't be read or changed from here.` };
});
</script>

<template>
    <div class="flex flex-col gap-6">
        <!--
            No border under the strip: on mobile the hub draws its own bordered pill row above this one, and two bordered
            strips would read as two controls.
        -->
        <SegmentedControl v-model="section" :options="SECTIONS" aria-label="Agent settings category" />

        <!--
            Page-level so it sits above whichever category is showing; every control below is inert while the read is
            pending or failed.
        -->
        <Notice v-if="settingsBlocked" :of="settingsBlocked" />

        <!--
            Daemon accepted the save but dropped a field; the control already reverted, so without this it looks like a
            rejected input.
        -->
        <Notice v-if="settingsDropped" tone="warning">{{ settingsDropped }}</Notice>

        <!-- Accounts first: every model choice below depends on a signed-in provider. -->
        <template v-if="section === `models`">
            <AiAccountSection />
            <AgentModels />
        </template>

        <!-- Ordered by widening scope: told every turn, told per job match, standing rules, then memory across turns. -->
        <template v-else-if="section === `instructions`">
            <AgentInstructions />
            <AgentSkills />
            <AgentRules />
            <AgentMemory />
        </template>

        <!-- What it may reach for and how much comes back, ending with how much of the job it may delegate. -->
        <template v-else-if="section === `tools`">
            <AgentCodeSearch />
            <AgentDependencies />
            <AgentCommandOutput />
            <AgentSubagents />
        </template>

        <!--
            Whether anything judges, then what it judges against; the decision log sits last so it doesn't bury the controls
            above it.
        -->
        <template v-else-if="section === `safety`">
            <AgentSafetyJudge />
            <!-- Between the switch and the policy: what the judge is scoped to precedes the document it judges against. -->
            <AgentSafetyRules />
            <AgentSafetyPolicy />
            <AgentSafetyLog />
        </template>

        <!-- The two ways a turn ends: proof and delivery, then last the recovery path for a turn that broke instead. -->
        <template v-else>
            <AgentChecks />
            <AgentFinishedWork />
            <AgentChangelog />
            <AgentRecovery />
        </template>
    </div>
</template>
