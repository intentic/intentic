<script setup lang="ts">
import { cmp } from "@intentic/ui";
import { computed } from "vue";
import { useSandbox } from "../../composables/sandbox/useSandbox";
import { useSandboxSettings } from "../../composables/sandbox/useSandboxSettings";
import AiAccountSection from "./AiAccountSection.vue";
import AgentChecks from "./agent/AgentChecks.vue";
import AgentCodeSearch from "./agent/AgentCodeSearch.vue";
import AgentCommandOutput from "./agent/AgentCommandOutput.vue";
import AgentFinishedWork from "./agent/AgentFinishedWork.vue";
import AgentInstructions from "./agent/AgentInstructions.vue";
import AgentMemory from "./agent/AgentMemory.vue";
import AgentModels from "./agent/AgentModels.vue";
import AgentRecovery from "./agent/AgentRecovery.vue";
import AgentRules from "./agent/AgentRules.vue";
import AgentSubagents from "./agent/AgentSubagents.vue";

/* The Sandbox hub's "Agent" tab — the home for everything about the AI the sandbox runs. The provider accounts
 * it authenticates as, and then one group per question the owner might be here to answer: which models get spent
 * when nobody is at the composer, what the assistant is told, how it searches, how much shell output it is
 * handed, how much of the work it may hand to other agents, what proves its work, what happens when it finishes,
 * every other standing instruction it has been given, and who picks a turn back up when it breaks.
 * Accounts and memory live INSIDE the sandbox, never on the platform, which is why this is a sandbox tab.
 *
 * Every group reads and writes the SAME settings object through useSandboxSettings — a vue-query cache, so they
 * share one read and one optimistic write path without this file threading anything down. What stays here is
 * only what is true of the page as a whole: why the controls are inert, and that the daemon dropped a field. */

const sandbox = useSandbox();
const { settings, error: settingsError, dropped: settingsDropped } = useSandboxSettings();

// Only states that need explaining: a failed read, or a sandbox that isn't answering. The first-load moment is
// deliberately silent — the controls are disabled for it either way, and a line that appears and then vanishes
// would shove every row down and back on each visit.
const settingsBlocked = computed(() => {
    if (settings.value !== undefined) {
        return undefined;
    }
    if (settingsError.value !== undefined) {
        return settingsError.value;
    }
    return sandbox.reachable.value ? undefined : `Your sandbox is offline — its settings can't be read or changed from here.`;
});
</script>

<template>
    <div class="flex flex-col gap-6">
        <!-- The AI accounts the agent signs in as: the provider switcher, one row per connection, and the
             live sign-in each row can unfold. Its own component — it is the only stateful, network-driven part
             of this page, and everything below is a settings toggle. -->
        <AiAccountSection />

        <!-- Why every control below is inert, whenever it is: a settings read that hasn't landed (or failed)
             disables all of them, and an unexplained dead switch is indistinguishable from a broken page. -->
        <p v-if="settingsBlocked" :class="settingsError ? cmp.alertDanger() : 'px-0.5 text-xs text-muted'">{{ settingsBlocked }}</p>

        <!-- A save the daemon accepted but stored WITHOUT one of its fields: the control has already snapped
             back to its old value, and without this line that reads as an input refusing to be typed into
             rather than as a sandbox that predates the setting. Page-level because any group can trip it. -->
        <p v-if="settingsDropped" :class="cmp.alertWarning()">{{ settingsDropped }}</p>

        <!-- Directly under the accounts, because it is a choice OVER them. -->
        <AgentModels />
        <AgentInstructions />
        <AgentCodeSearch />
        <AgentCommandOutput />
        <AgentSubagents />
        <AgentChecks />
        <AgentFinishedWork />
        <!-- Directly under the two groups whose rows ARE rules, because it is the same table seen whole: the
             three switches above are the common instructions, this is everything else the owner has told the
             sandbox to do, and reading them in that order is what makes the connection obvious. -->
        <AgentRules />
        <AgentRecovery />
        <AgentMemory />
    </div>
</template>
