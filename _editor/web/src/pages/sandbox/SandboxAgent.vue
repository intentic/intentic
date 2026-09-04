<script setup lang="ts">
import { Notice, type NoticeModel, SegmentedControl } from "@intentic/ui";
import { computed } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useSandbox } from "../../composables/sandbox/useSandbox";
import { useSandboxSettings } from "../../composables/sandbox/useSandboxSettings";
import AiAccountSection from "./AiAccountSection.vue";
import AgentChangelog from "./agent/AgentChangelog.vue";
import AgentChecks from "./agent/AgentChecks.vue";
import AgentChildAgents from "./agent/AgentChildAgents.vue";
import AgentCodeSearch from "./agent/AgentCodeSearch.vue";
import AgentCommandOutput from "./agent/AgentCommandOutput.vue";
import AgentDependencies from "./agent/AgentDependencies.vue";
import AgentFinishedWork from "./agent/AgentFinishedWork.vue";
import AgentInstructions from "./agent/AgentInstructions.vue";
import AgentMemory from "./agent/AgentMemory.vue";
import AgentModels from "./agent/AgentModels.vue";
import AgentRecovery from "./agent/AgentRecovery.vue";
import AgentRules from "./agent/AgentRules.vue";
import AgentSafetyJudge from "./agent/AgentSafetyJudge.vue";
import AgentSafetyLog from "./agent/AgentSafetyLog.vue";
import AgentSafetyPolicy from "./agent/AgentSafetyPolicy.vue";
import AgentSkills from "./agent/AgentSkills.vue";
import AgentSubagents from "./agent/AgentSubagents.vue";

/* The Sandbox hub's "Agent" tab: the home for everything about the AI the sandbox runs. The provider accounts
 * it authenticates as, and then one group per question the owner might be here to answer: which models get spent
 * when nobody is at the composer, what the assistant is told, how it searches, how much shell output it is
 * handed, how much of the work it may hand to other agents, what proves its work, what happens when it finishes,
 * every other standing instruction it has been given, and who picks a turn back up when it breaks.
 * Accounts and memory live INSIDE the sandbox, never on the platform, which is why this is a sandbox tab.
 *
 * Every group reads and writes the SAME settings object through useSandboxSettings: a vue-query cache, so they
 * share one read and one optimistic write path without this file threading anything down. What stays here is
 * only what is true of the page as a whole: which category is showing, why the controls are inert, and that the
 * daemon dropped a field.
 *
 * THE GROUPS ARE CATEGORISED, and the strip is what this file mostly is now. Stacked, they ran to thirteen
 * sections: one of which (AI account) is a page in its own right, with a provider switcher, a row per
 * connection and a live sign-in that unfolds inside it. That is not a long form, it is four different errands
 * sharing a scrollbar: who the agent signs in as and what gets spent, what it is told, how a turn actually
 * runs, and what happens to the work when it is done. Four is what a <SegmentedControl> is FOR: a few exclusive views
 * of one subject, and four short labels come to well under half the body column, which is the measurement that
 * matters here: the hub's own index left this strip for a column at twelve destinations because twelve pills
 * overflowed. The same control at four is the case it was built for, not a repeat of that failure. */

const SECTIONS = [
    // "How it runs" holds the mechanics of a turn INCLUDING the one that fails: a turn that breaks is still a
    // turn running, where "Landing work" is only ever about work that finished.
    { label: `Accounts`, value: `accounts` },
    { label: `Instructions`, value: `instructions` },
    { label: `How it runs`, value: `running` },
    /* …and "Safety" is what it may DO, which is a different question from how a turn works: these rules are
     * consulted per command, they bind on every runtime, and they are the only settings here whose wrong value
     * is unrecoverable rather than merely annoying. It sits between the two for that reason — after the turn
     * mechanics, before what happens to finished work. */
    { label: `Safety`, value: `safety` },
    { label: `Landing work`, value: `landing` },
] as const;
type Section = (typeof SECTIONS)[number][`value`];
const DEFAULT: Section = `accounts`;

const route = useRoute();
const router = useRouter();

/* THE CATEGORY LIVES IN THE ADDRESS, and it has to: three places already link into this page aimed at one
 * setting: the composer's connect gate, and Usage's two experiment cards, and with the page split they would
 * otherwise land on a category that doesn't hold what they promised. Derived from the query rather than mirrored
 * into a ref, so there is one direction of flow. The default writes no param, so no category has two URLs.
 *
 * A `?connect=` link OUTRANKS the param outright: it is a request to sign an account in, and the group that
 * does it is Accounts whatever the address last remembered. Picking a category by hand therefore clears it:
 * otherwise the getter would keep pulling the page back and the pills would read as dead. */
const section = computed<Section>({
    get: () => {
        if (typeof route.query[`connect`] === `string`) {
            return `accounts`;
        }
        const asked = route.query[`section`] ?? (route.query[`security`] === `safety` ? `safety` : undefined);
        return SECTIONS.find((entry) => entry.value === asked)?.value ?? DEFAULT;
    },
    // Pushed, not replaced: these are destinations like the hub's own sections, so Back should return to the
    // category you came from rather than out of the page entirely.
    set: (value) => void router.push({ query: { ...route.query, connect: undefined, section: value === DEFAULT ? undefined : value } }),
});

const sandbox = useSandbox();
const { settings, error: settingsError, dropped: settingsDropped } = useSandboxSettings();

// Only states that need explaining: a failed read, or a sandbox that isn't answering. The first-load moment is
// deliberately silent: the controls are disabled for it either way, and a line that appears and then vanishes
// would shove every row down and back on each visit.
const settingsBlocked = computed<NoticeModel | undefined>(() => {
    if (settings.value !== undefined) {
        return undefined;
    }
    // A failed read is a fault and reads as one; an offline sandbox is a fact about the world, so it is a
    // warning rather than an alarm: the controls are disabled either way and there is nothing to fix here.
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
        <!-- No rule under the strip, deliberately. On a phone the hub draws its OWN pill row above this one,
             under a border: two bordered strips stacked read as two controls at the same level, when one of
             them is the page and the other is a part of it. Bare pills sitting in the content column are what
             says which is which. -->
        <SegmentedControl v-model="section" :options="SECTIONS" aria-label="Agent settings category" />

        <!-- Both page-level, so they sit above whichever category is showing rather than inside one.

             Why every control below is inert, whenever it is: a settings read that hasn't landed (or failed)
             disables all of them, and an unexplained dead switch is indistinguishable from a broken page. -->
        <Notice v-if="settingsBlocked" :of="settingsBlocked" />

        <!-- A save the daemon accepted but stored WITHOUT one of its fields: the control has already snapped
             back to its old value, and without this line that reads as an input refusing to be typed into
             rather than as a sandbox that predates the setting. Page-level because any group can trip it. -->
        <Notice v-if="settingsDropped" tone="warning">{{ settingsDropped }}</Notice>

        <!-- Who the agent is and what it spends. The accounts it signs in as, and: directly under them,
             because it is a choice OVER them, which models get spent when nobody is at the composer. -->
        <template v-if="section === `accounts`">
            <AiAccountSection />
            <AgentModels />
        </template>

        <!-- Everything the agent is TOLD, in widening scope: what it hears on every turn, what it is handed
             when a job matches, every other standing instruction, and what it remembers between turns. Reading
             them in that order is what makes a skill legible as an instruction rather than as a plugin, and
             Rules as the same table the switches above are rows of. -->
        <template v-else-if="section === `instructions`">
            <AgentInstructions />
            <AgentSkills />
            <AgentRules />
            <AgentMemory />
        </template>

        <!-- The mechanics of a turn: how it finds things, how much of what it runs comes back, how much of the
             job it may hand to other agents, and who picks the turn up when it breaks. -->
        <template v-else-if="section === `running`">
            <AgentCodeSearch />
            <AgentDependencies />
            <AgentCommandOutput />
            <AgentSubagents />
            <AgentRecovery />
        </template>

        <!-- What it may do without stopping to ask, read in the order the question is actually asked: whether
             anything is judging at all and on which model, then the document that judge applies, then the
             evidence for both. Nobody can write a rule for behaviour they cannot see, so the log of recent
             decisions sits directly under the policy it is teaching them to edit — and it is also what makes the
             judge's Watch state worth having. Helper agents last, because it is the one thing here still
             answered by a switch rather than by the policy (AgentChildAgents says why). -->
        <template v-else-if="section === `safety`">
            <AgentSafetyJudge />
            <AgentSafetyPolicy />
            <AgentSafetyLog />
            <AgentChildAgents />
        </template>

        <!-- What happens to work once it is done, in the order it happens to it: it gets proved, it gets
             applied to the workspace, and the commit recording it says what it meant for a user. -->
        <template v-else>
            <AgentChecks />
            <AgentFinishedWork />
            <AgentChangelog />
        </template>
    </div>
</template>
