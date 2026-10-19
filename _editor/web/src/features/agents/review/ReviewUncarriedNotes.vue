<script setup lang="ts">
import type { Tip } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import type { OutsideCheckout } from "@intentic/sandbox-contract/schemas/git/git";
import { computed } from "vue";
import { draftStrayAsk } from "../../../models/fleet/agentActions";
import type { useAgentChanges } from "./useAgentChanges";

// The review's two quiet lines about work no land carries (AgentReviewPanel draws them under its bar): copies stranded
// on a branch of their own, and files written where no checkout of a repository stood.

const t = useT();

const { agentId, at, changes } = defineProps<{
    agentId: string;
    // Sandbox this agent's worktree is on, absent for the active one: the ask goes only into a chat on this one.
    at?: string;
    changes: ReturnType<typeof useAgentChanges>;
}>();

// A notice that needs no decision: one line under the bar, no box, so only the bar reads as something to act on.
const NOTE_LINE = `mx-2 mt-1.5 flex shrink-0 items-center gap-1.5 px-2 text-2xs text-muted`;

// Files written where the copy carries no repository, said as what it means: they are on no branch, so nothing lands
// them. Why each folder is outside is the hover's, with what clears it.
const outside = computed(() => changes.review.value?.outside ?? []);
const outsideFiles = computed(() => outside.value.reduce((total, hole) => total + hole.files, 0));
const outsideRepos = computed(() => outside.value.map((hole) => hole.repo).join(`, `));
// Each wording spelled as its own call, so the catalog check can see every message asked for.
const OUTSIDE_REASONS = {
    unborn: () => t(`agents.agentReviewPanel.outsideUnborn`),
    unreadable: () => t(`agents.agentReviewPanel.outsideUnreadable`),
    "not-carried": () => t(`agents.agentReviewPanel.outsideNotCarried`),
} satisfies Record<OutsideCheckout["reason"], () => string>;
const outsideTip = computed(
    (): Tip => ({
        title: t(`agents.agentReviewPanel.outsideTitle`),
        rows: outside.value.map((hole) => ({ label: hole.repo, value: OUTSIDE_REASONS[hole.reason]() })),
    }),
);

// Copies on a branch of their own whose commits there did not reach this conversation's branch: work no land carries.
// A copy that was carried is not news to the reader (it lands like the rest), so only the stranded ones are said.
// Absent `carried` is a sandbox too old to copy them, which never did.
const stranded = computed(() => changes.elsewhere.value.filter((stray) => stray.carried !== true));
const strandedRepos = computed(() => stranded.value.map((stray) => stray.repo).join(`, `));
// Where each copy stands, for whoever wants the git of it; the line itself says only what it means.
const strandedTip = computed(
    (): Tip => ({
        title: t(`agents.agentReviewPanel.offBranch`),
        rows: stranded.value.map((stray) => ({ label: stray.repo, value: stray.branch ?? t(`agents.agentReviewPanel.noBranch`) })),
    }),
);
</script>

<template>
    <!-- Work no land carries, said as what it means; where each copy stands is the hover's. The ask goes into the
         agent's composer, not straight to it, so a running turn is never steered by a press made here. -->
    <div v-if="stranded.length > 0" :class="NOTE_LINE">
        <Icon name="exclamation-triangle" class="shrink-0 text-2xs text-warning" />
        <span class="min-w-0 flex-1" v-tooltip.bottom="strandedTip">{{
            t(`agents.agentReviewPanel.strandedWork`, { repos: strandedRepos })
        }}</span>
        <button
            v-if="at === undefined"
            type="button"
            class="shrink-0 text-link underline-offset-2 hover:underline"
            @click="draftStrayAsk(agentId, stranded)"
        >
            {{ t(`agents.agentReviewPanel.askAgent`) }}
        </button>
    </div>

    <!-- Work no land carries because no checkout of its repository stood where it was written. -->
    <div v-if="outside.length > 0" :class="NOTE_LINE">
        <Icon name="exclamation-triangle" class="shrink-0 text-2xs text-warning" />
        <span class="min-w-0 flex-1" v-tooltip.bottom="outsideTip">{{
            t(`agents.agentReviewPanel.outsideWork`, { count: outsideFiles, repos: outsideRepos }, outsideFiles)
        }}</span>
    </div>
</template>
