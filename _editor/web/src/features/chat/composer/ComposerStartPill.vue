<!-- WHERE A NEW AGENT STARTS, on the composer's row (ChatPane): the main line by default, waiting in the overflow as
     "Start from: main"; a branch of one repository, or another agent's copy, as a pill naming it. Either opens the same
     list the Workspace's scope chip does (WorkspaceScopePicker), for a start rather than a look: the shared workspace's
     main line, each repository's branches, the copies a new agent can start on. A draft's alone (composerStartFrom.ts). -->
<script setup lang="ts">
import { Icon, ResponsiveOverlay, type Tip, useDevice } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, ref } from "vue";
import { branchLabel, type ViewScope } from "../../../app/workspaceScope";
import type { Conversation } from "../../../models/conversations/session/conversation";
import { agentDisplayTitle } from "../../../models/agent-status/agentStatus-meta";
import { startOnBranch, startOnCopy, startOnMainLine, startScopeOf } from "../../../models/fleet/branches/branchStart";
import { useAgents } from "../../../models/fleet/useAgents";
import WorkspaceScopePicker from "../../../parts/workspace/scope/WorkspaceScopePicker.vue";
import type { useStartFrom } from "./composerStartFrom";

const t = useT();

const { start, conversation, ride, fallback } = defineProps<{
    start: ReturnType<typeof useStartFrom>;
    conversation: Conversation;
    // Set off the main line, so it rides the row (composerMore.ts ridesRow); otherwise its row is in the overflow.
    ride: boolean;
    // Where the list opens when it was reached from the overflow.
    fallback: HTMLElement | undefined;
}>();

const { mobile } = useDevice();
const { agentById } = useAgents();
const pill = ref<HTMLElement>();

const scope = computed(() => startScopeOf(conversation));
const label = computed(() => {
    const { agent, repo, branch } = scope.value;
    if (branch !== undefined) {
        return branchLabel({ repo, branch });
    }
    const origin = agent === undefined ? undefined : agentById(agent);
    return origin === undefined ? t(`agents.freshSession.anotherChat`) : agentDisplayTitle(origin);
});

// What it starts from, by kind and name; the press opens the list.
const tip = computed((): Tip => ({
    title: t(`chat.composerMore.startFrom`),
    rows: [{ label: scope.value.branch === undefined ? t(`workspace.words.privateCopy`) : t(`agents.sessionIdentity.branch`), value: label.value }],
}));

const pick = (picked: ViewScope): void => {
    start.open.value = false;
    const { agent, repo, branch } = picked;
    const origin = agent === undefined ? undefined : agentById(agent);
    if (branch !== undefined) {
        startOnBranch(conversation, { repo, branch });
    } else if (origin !== undefined) {
        startOnCopy(conversation, origin);
    } else {
        startOnMainLine(conversation);
    }
};
</script>

<template>
    <button
        v-if="ride"
        ref="pill"
        type="button"
        class="composer-ghost composer-glyph composer-active h-8 shrink-0 gap-1.5 px-2.5 text-2xs font-medium max-md:h-11"
        :aria-expanded="start.open.value"
        :aria-label="t(`chat.composerMore.startFromNamed`, { name: label })"
        v-tooltip.top="start.open.value ? undefined : tip"
        @click="start.open.value = !start.open.value"
    >
        <Icon :name="scope.branch === undefined ? `robot` : `git-branch`" class="text-2xs text-link" />
        <span class="max-w-40 truncate @max-lg:hidden">{{ label }}</span>
        <Icon name="chevron-down" class="text-2xs text-subtle @max-lg:hidden" />
    </button>
    <ResponsiveOverlay
        v-model="start.open.value"
        :anchor="ride ? pill : fallback"
        cross="end"
        :header="t(`chat.composerMore.startFrom`)"
        panel-class="w-[23rem] max-w-[calc(100vw-1rem)]"
    >
        <WorkspaceScopePicker :current="scope" purpose="start" :main-line="start.mainLine.value" :autofocus="!mobile" @pick="pick" @close="start.open.value = false" />
    </ResponsiveOverlay>
</template>
