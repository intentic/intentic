<script setup lang="ts">
import type { IconName } from "@intentic/ui";
import type { ViewBadge } from "@intentic/extension-api";
import { computed } from "vue";
import { RouterLink, useRoute } from "vue-router";
import { badgeChip, badgeClass, badgeText } from "../core-views/viewBadge";
import { agentsBadge, agentsScopeNote } from "../features/agents/board/agentsTile";
import { useApprovalsTile } from "./mobileTabs";
import RailIcon from "./rail/RailIcon.vue";
import RunningMark from "./rail/RunningMark.vue";
import { outgoingMark, outgoingSummary } from "../features/workspace/push/outgoingWork";
import { pushBadge } from "../features/workspace/push/pushBadge";
import { useChanges } from "../features/workspace/changes/useChanges";
import { usePushFlow } from "../features/workspace/push/usePushFlow";
import { useSandboxAttention } from "../features/sandbox/overview/sandboxAttention";

// Four fixed tabs: Agents (fleet, "needs you" badge), Review (drafts plus uncommitted changes owed),
// Menu (what the sandbox needs, standing in for the desktop rail's chip); everything else lives on
// the Menu page. Review's tab reads the approvals extension's registry entry by id, for placement only.

interface Tab {
    readonly id: string;
    readonly to: string;
    readonly label: string;
    // What the tab says without being opened: the same shape the desktop rail badges with, so one renderer
    // serves all four instead of a hand-rolled span per tab.
    readonly badge?: ViewBadge;
    // Which workspace panel this tab owns, for Files and Review sharing the workspace path; absent otherwise.
    readonly panel?: "files" | "changes";
    // A standing fact drawn as a corner glyph and spelled out in the label, like AreaTile.note.
    readonly note?: { readonly icon: IconName; readonly text: string };
}

const changes = useChanges();
const pushFlow = usePushFlow();
const { badge: sandboxBadge } = useSandboxAttention();

// Matched by view id (detectActivations); TAB_BAR_IDS is the shared promotion list ShellMobile also reads.
const approvalsTile = useApprovalsTile();

// Falls back to the same push-owed glyph as the desktop rail when nothing else needs review.
const reviewBadge = computed<ViewBadge | undefined>(() => {
    // A push in flight or unsent comes first: it's happening now, and its panel is two taps away.
    const push = pushBadge(pushFlow.stage.value, pushFlow.question.value, pushFlow.held.value);
    if (push !== undefined) {
        return push;
    }
    const count = (approvalsTile.value?.badge?.count ?? 0) + changes.count.value;
    if (count > 0) {
        return { count, tooltip: `${count} to review` };
    }
    const work = changes.outgoing.value;
    return work === undefined ? undefined : { mark: outgoingMark(work), tooltip: outgoingSummary(work) };
});

const tabs = computed<readonly Tab[]>(() => [
    {
        id: `agents`,
        to: `/agents`,
        label: `Agents`,
        // The desktop rail's tile, on a phone: one derivation (agentsTile.ts) for both, so a count that follows
        // the board's scope cannot follow it in one shell and not the other.
        ...(agentsBadge.value === undefined ? {} : { badge: agentsBadge.value }),
        ...(agentsScopeNote.value === undefined ? {} : { note: { icon: `boxes` as IconName, text: agentsScopeNote.value } }),
    },
    { id: `workspace`, to: `/workspace`, label: `Files`, panel: `files` },
    {
        /* The queue when the pack is on; the workspace's OWN review: its Changes panel, when it is off.
         * `?panel=changes` rather than the bare path the Files tab already owns: two tabs at one address are
         * one tab's worth of navigation and two highlights (WorkspaceMobile reads the query). */
        id: `approvals`,
        to: approvalsTile.value?.to ?? `/workspace?panel=changes`,
        label: `Review`,
        ...(reviewBadge.value === undefined ? {} : { badge: reviewBadge.value }),
        ...(approvalsTile.value === undefined ? { panel: `changes` as const } : {}),
    },
    { id: `menu`, to: `/menu`, label: `Menu`, ...(sandboxBadge.value === undefined ? {} : { badge: sandboxBadge.value }) },
]);

// Same order as the rail's tileLabel; the only spot badge and note are spelled out for a screen reader.
const tabLabel = (tab: Tab): string => [tab.label, tab.badge?.tooltip, tab.note?.text].filter((part) => part !== undefined).join(` · `);

const route = useRoute();
// Matches by path prefix, not active-class (it drops on a splat param). When a tab declares `panel`,
// that must also match the query (absent means files), or both Files and Review would light up together.
const isNavActive = (tab: Tab): boolean => {
    const path = tab.to.split(`?`)[0] ?? tab.to;
    if (!(route.path === path || route.path.startsWith(`${path}/`))) {
        return false;
    }
    if (tab.panel === undefined) {
        return true;
    }
    const showing = route.query[`panel`];
    return (typeof showing === `string` ? showing : `files`) === tab.panel;
};
</script>

<template>
    <nav class="flex shrink-0 items-stretch border-t border-line bg-card pb-[env(safe-area-inset-bottom)]">
        <RouterLink
            v-for="tab in tabs"
            :key="tab.label"
            :to="tab.to"
            class="relative flex h-14 min-w-0 flex-1 flex-col items-center justify-center gap-0.5 text-muted transition-colors active:bg-overlay"
            :class="{ 'text-link': isNavActive(tab) }"
            :aria-label="tabLabel(tab)"
        >
            <!-- mark replaces the count when the amount isn't what you act on; aria-hidden, the label already says it. -->
            <span class="relative">
                <RailIcon :area="tab.id" class="text-xl" />
                <span
                    v-if="tab.badge && badgeChip(tab.badge)"
                    class="absolute -right-2.5 -top-1 flex min-w-4 items-center justify-center rounded-full px-1 text-center text-[0.6rem] font-semibold leading-4"
                    :class="badgeClass(tab.badge)"
                    aria-hidden="true"
                >
                    <Icon v-if="tab.badge.mark !== undefined" :name="tab.badge.mark as IconName" />
                    <template v-else>{{ badgeText(tab.badge) }}</template>
                </span>
                <!-- Work in flight, in the corner the badge and note both leave free; same mark as the desktop rail. -->
                <RunningMark v-if="tab.badge?.running !== undefined" class="absolute -bottom-1 -right-2" />
                <!-- Sits in the corner the badge doesn't use; aria-hidden like the badge, since the label already carries it. -->
                <span v-if="tab.note" class="absolute -bottom-1 -left-2 flex leading-none text-subtle" aria-hidden="true">
                    <Icon :name="tab.note.icon" class="text-[0.6rem]" />
                </span>
            </span>
            <span class="text-2xs font-medium">{{ tab.label }}</span>
        </RouterLink>
    </nav>
</template>
