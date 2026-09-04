<script setup lang="ts">
import { Notice, type NoticeModel, SegmentedControl } from "@intentic/ui";
import { computed } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useSandbox } from "../../composables/sandbox/useSandbox";
import { useSandboxSettings } from "../../composables/sandbox/useSandboxSettings";
import AiAccountSection from "./AiAccountSection.vue";
import AgentChangelog from "./agent/AgentChangelog.vue";
import AgentChecks from "./agent/AgentChecks.vue";
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

/* The Sandbox hub's "Agent" tab: everything about the AI this sandbox runs. Accounts and memory live INSIDE the
 * sandbox, never on the platform, which is why this is a sandbox tab rather than a personal setting.
 *
 * Every group reads and writes the SAME settings object through useSandboxSettings: a vue-query cache, so they
 * share one read and one optimistic write path without this file threading anything down. What stays here is
 * only what is true of the page as a whole: which category is showing, why the controls are inert, and that the
 * daemon dropped a field.
 *
 * THE CATEGORIES ARE ONE AXIS, and keeping them on one is the point. Eighteen groups stacked in a single scroll
 * were unusable, but the first split was made on two axes at once: three categories named a SUBJECT (accounts,
 * instructions, safety) and two named a PHASE of a turn ("How it runs", "Landing work"). Nothing tells a reader
 * which axis their question is on, so a setting was found by sweeping all five. Worse, two of the five had no
 * subject at all — "How it runs" held code search, registry checks, output trimming, delegation ceilings and
 * outage recovery, which share only that they happen while a turn is going.
 *
 * So every category now names a PART OF THE AGENT, and each one is a question somebody arrives with:
 *
 *   MODELS      which AI does which job, and on whose account. The account list leads it because signing in is
 *               a step toward picking a model, never the errand itself: a pin cannot name a provider this
 *               sandbox has no credential for, so the order on the page IS the dependency. This is also the
 *               only place a model is chosen — including the safety judge's, which used to sit three tabs away
 *               and made "where do I set a model" a question with two answers.
 *   INSTRUCTIONS what it is told, in widening scope.
 *   TOOLS       what it may reach for during a turn, and how much comes back. Delegation is here rather than
 *               under Safety, and as ONE group rather than two: whether a turn may start agents of its own and
 *               how many it may run were a switch on the Safety tab and three numbers on the phase tab, which
 *               is one concept under two names on two screens. Starting an agent costs money; it does not
 *               destroy anything, which is what the gate next door is for.
 *   SAFETY      what it may do without stopping to ask. These rules are consulted per command, bind on every
 *               runtime, and are the only settings here whose wrong value is unrecoverable rather than annoying.
 *   FINISHING   what happens when a turn ends, either way it ends: what proves the work, what carries it to the
 *               user, and what picks the turn up when it breaks instead.
 *
 * Checks moved into Finishing from the old phase category because that is when they run: a check that proves
 * work before it is handed over belongs beside what happens to the work, not beside the search tool.
 *
 * Five short labels come to well under half the body column, which is the measurement that matters: the hub's
 * own index left this strip for a column at twelve destinations because twelve pills overflowed. */

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

/* THE CATEGORY LIVES IN THE ADDRESS, and it has to: several places link into this page aimed at one setting —
 * the composer's connect gate, its "turn it off for every chat" link, Usage's experiment cards — and with the
 * page split they would otherwise land on a category that doesn't hold what they promised. Derived from the
 * query rather than mirrored into a ref, so there is one direction of flow. The default writes no param, so no
 * category has two URLs, and `/sandbox/agent#models` still lands on the Models group with no query at all.
 *
 * A `?connect=` link OUTRANKS the param outright: it is a request to sign an account in, and the group that
 * does it leads Models whatever the address last remembered. Picking a category by hand therefore clears it:
 * otherwise the getter would keep pulling the page back and the pills would read as dead. */
const section = computed<Section>({
    get: () => {
        if (typeof route.query[`connect`] === `string`) {
            return `models`;
        }
        return SECTIONS.find((entry) => entry.value === route.query[`section`])?.value ?? DEFAULT;
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

        <!-- Which AI does which job. The accounts first, because every model choice under them is a choice
             OVER them and cannot name a provider that isn't signed in. -->
        <template v-if="section === `models`">
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

        <!-- What it may reach for, and how much comes back: how it finds things, what it checks a dependency
             against, how much of a command's output it is handed, and then the biggest tool of all — how much
             of the job it may hand to agents of its own. -->
        <template v-else-if="section === `tools`">
            <AgentCodeSearch />
            <AgentDependencies />
            <AgentCommandOutput />
            <AgentSubagents />
        </template>

        <!-- What it may do without stopping to ask: whether anything is judging at all, and the document that
             judge applies. The log of recent decisions sits at the end so its longer, expandable activity feed
             does not bury the standing controls above it — and it is here rather than anywhere else because a
             policy whose effects you cannot see is a policy you cannot write. -->
        <template v-else-if="section === `safety`">
            <AgentSafetyJudge />
            <AgentSafetyPolicy />
            <AgentSafetyLog />
        </template>

        <!-- The end of a turn, both ways it can end. First the good one, in the order it happens to the work:
             it gets proved, it gets applied to the workspace, and the commit recording it says what it meant
             for a user. Then the other one, last, because it is the exception rather than the path. -->
        <template v-else>
            <AgentChecks />
            <AgentFinishedWork />
            <AgentChangelog />
            <AgentRecovery />
        </template>
    </div>
</template>
