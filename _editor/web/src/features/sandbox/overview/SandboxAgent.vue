<script setup lang="ts">
import { Icon, Notice, type NoticeModel, SegmentedControl, ui } from "@intentic/ui";
import { computed, watch } from "vue";
import { RouterLink, useRoute, useRouter } from "vue-router";
import { MODELS_PATH, modelsPath } from "../../../lib/routes/modelsPath";
import { useSandbox } from "../../../client/sandbox/useSandbox";
import { useSandboxSettings } from "./useSandboxSettings";
import AgentChangelog from "../agent-settings/behaviour/AgentChangelog.vue";
import AgentChecks from "../agent-settings/behaviour/AgentChecks.vue";
import AgentClock from "../agent-settings/behaviour/AgentClock.vue";
import AgentCodeSearch from "../agent-settings/behaviour/AgentCodeSearch.vue";
import AgentCommandOutput from "../agent-settings/behaviour/AgentCommandOutput.vue";
import AgentFinishedWork from "../agent-settings/behaviour/AgentFinishedWork.vue";
import AgentInstructions from "../agent-settings/skills/AgentInstructions.vue";
import AgentMemory from "../agent-settings/skills/AgentMemory.vue";
import AgentMemoryImport from "../agent-settings/skills/AgentMemoryImport.vue";
import AgentModels from "../agent-settings/models/AgentModels.vue";
import AgentRecovery from "../agent-settings/behaviour/AgentRecovery.vue";
import AgentRepoChecks from "../agent-settings/behaviour/AgentRepoChecks.vue";
import AgentPrivacyShield from "../agent-settings/safety/AgentPrivacyShield.vue";
import AgentProjectInstalls from "../agent-settings/safety/AgentProjectInstalls.vue";
import AgentSafetyJudge from "../agent-settings/safety/AgentSafetyJudge.vue";
import AgentSafetyLog from "../agent-settings/safety/AgentSafetyLog.vue";
import AgentSafetyPolicy from "../agent-settings/safety/AgentSafetyPolicy.vue";
import AgentSkills from "../agent-settings/skills/AgentSkills.vue";
import AgentSubagents from "../agent-settings/behaviour/AgentSubagents.vue";
import AgentOffload from "../agent-settings/behaviour/AgentOffload.vue";
import { useT } from "@intentic/ui/i18n";

// Agent tab: how the agent works in this sandbox. Each group reads and writes the same settings object via
// useSandboxSettings; only page-level state (which category, blocked/dropped notices) lives here. Categories are one
// axis, grouped by part of the agent rather than by subject and phase.
//
// What it runs on is not here: accounts, subscriptions, local models and endpoints are Sandbox ▸ Models, since they are
// what this box holds rather than how the agent behaves. Jobs, first, is the hinge between the two: which of those
// models does which job.

const t = useT();

const SECTIONS = computed(
    () =>
        [
            { label: t(`sandbox.sandboxAgent.jobs`), value: `jobs` },
            { label: t(`sandbox.words.instructions`), value: `instructions` },
            { label: t(`sandbox.sandboxAgent.tools`), value: `tools` },
            { label: t(`sandbox.sandboxAgent.safety`), value: `safety` },
            { label: t(`sandbox.sandboxAgent.finishing`), value: `finishing` },
        ] as const,
);
type Section = (typeof SECTIONS.value)[number][`value`];
const DEFAULT: Section = `jobs`;
// The first category's address before it was named for what it holds; an older link still lands on it.
const aliasOf = (named: string): Section | undefined => (named === `models` ? `jobs` : undefined);

const route = useRoute();
const router = useRouter();

// Category lives in the query so external links land on the right one; the default writes no param.
const section = computed<Section>({
    get: () => {
        const named = String(route.query[`section`] ?? ``);
        return SECTIONS.value.find((entry) => entry.value === named)?.value ?? aliasOf(named) ?? DEFAULT;
    },
    // Pushed, not replaced, so Back returns to the prior category instead of leaving the page.
    set: (value) => void router.push({ query: { ...route.query, section: value === DEFAULT ? undefined : value } }),
});

// `?connect=<provider>` opened a provider's accounts here, back when they lived on this tab. They are Sandbox ▸ Models
// now, which reads the same request as `?provider=`, so the old link is forwarded there rather than broken.
watch(
    () => String(route.query[`connect`] ?? ``),
    (asked) => {
        if (asked !== ``) {
            void router.replace(modelsPath({ provider: asked }));
        }
    },
    { immediate: true },
);

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
        return { tone: `danger`, title: t(`sandbox.sandboxAgent.couldntReadSandboxsSettings`), detail: settingsError.value };
    }
    return sandbox.reachable.value ? undefined : { tone: `warning`, title: t(`sandbox.sandboxAgent.sandboxOfflineSettingsCant`) };
});
</script>

<template>
    <!-- `@container`: every category below thins against this pane, which the docked chat can leave a third of the window's width. -->
    <div class="@container flex flex-col gap-6">
        <!-- No border under the strip: on mobile the hub draws its own bordered pill row above this one, and two bordered strips would read as two controls. -->
        <SegmentedControl v-model="section" :options="SECTIONS" :aria-label="t(`sandbox.sandboxAgent.agentSettingsCategory`)" />

        <!-- Page-level so it sits above whichever category is showing; every control below is inert while the read is pending or failed. -->
        <Notice v-if="settingsBlocked" :of="settingsBlocked" />

        <!-- Daemon accepted the save but dropped a field; the control already reverted, so without this it looks like a rejected input. -->
        <Notice v-if="settingsDropped" tone="warning">{{ settingsDropped }}</Notice>

        <!-- Every pick below chooses among what Models holds; said once, where the pick is made, with the way there. -->
        <template v-if="section === `jobs`">
            <p class="flex flex-wrap items-center gap-x-1.5 text-xs text-muted">
                {{ t(`sandbox.sandboxAgent.jobsFromModels`) }}
                <RouterLink :to="MODELS_PATH" :class="ui.linkButton(`text-xs`)">
                    {{ t(`sandbox.sandboxAgent.manageModels`) }}<Icon name="arrow-right" class="text-2xs" />
                </RouterLink>
            </p>
            <AgentModels />
        </template>

        <!-- Ordered by widening scope: told every turn, told per job match, memory, then import from elsewhere. -->
        <template v-else-if="section === `instructions`">
            <AgentInstructions />
            <AgentSkills />
            <AgentMemory />
            <AgentMemoryImport />
        </template>

        <!-- Finding code, feedback after edits, command output, then how much of the job it may delegate. -->
        <template v-else-if="section === `tools`">
            <AgentCodeSearch />
            <AgentRepoChecks />
            <AgentCommandOutput />
            <AgentSubagents />
            <!-- Last: not what it may reach for but where the heaviest of it runs, which only matters once a machine has a runner. -->
            <AgentOffload />
        </template>

        <!-- Whether anything judges, then what it judges against; the decision log sits last so it doesn't bury the controls above it. -->
        <template v-else-if="section === `safety`">
            <AgentSafetyJudge />
            <!-- Beside the judge: the other answer to whether a person is asked before an agent's command runs. -->
            <AgentProjectInstalls />
            <AgentSafetyPolicy />
            <!-- After the command gate, before its log: the other thing kept from leaving, personal data bound for a model provider, and the log still sits last. -->
            <AgentPrivacyShield />
            <AgentSafetyLog />
        </template>

        <!-- Whether main's failing CI gets a fix agent, then delivery, and last the recovery path for a turn that broke instead. -->
        <template v-else>
            <AgentChecks />
            <AgentFinishedWork />
            <AgentChangelog />
            <AgentRecovery />
            <!-- Beside the automation failure limit above, which is the other setting that only matters once
                 something runs on a clock rather than because somebody pressed send. -->
            <AgentClock />
        </template>
    </div>
</template>
