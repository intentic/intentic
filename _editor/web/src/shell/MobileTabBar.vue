<script setup lang="ts">
import type { IconName } from "@intentic/ui";
import type { ViewBadge } from "@intentic/extension-api";
import { computed } from "vue";
import { type RouteLocationNormalizedLoaded, RouterLink, useRoute } from "vue-router";
import ViewBadgeChip from "../core-views/ViewBadgeChip.vue";
import { agentsBadge, agentsScopeNote } from "../features/agents/board/agentsTile";
import { useApprovalsTile } from "./mobileTabs";
import { mobileChatPath } from "./tabRoots";
import { useChat } from "../features/chat/run/useChat";
import RailIcon from "./rail/RailIcon.vue";
import TileMark from "./rail/TileMark.vue";
import { RUNNING_MARK_CLASS } from "../core-views/viewBadge";
import { outgoingMark, outgoingSummary } from "../features/workspace/push/outgoingWork";
import { pushBadge } from "../features/workspace/push/pushBadge";
import { useChanges } from "../features/workspace/changes/useChanges";
import { usePushFlow } from "../features/workspace/push/usePushFlow";
import { useSandboxAttention } from "../features/sandbox/overview/sandboxAttention";
import { useSandbox } from "../features/sandbox/client/useSandbox";
import { restartRunning } from "../features/sandbox/live/sandboxRestart";
import { useT } from "@intentic/ui/i18n";

const t = useT();

// Four fixed tabs: Agents (fleet, "needs you" badge), Chat (the conversation you were last in), Review (drafts plus
// uncommitted changes owed), Menu (what the sandbox needs, standing in for the desktop rail's chip); everything else,
// the file tree included, lives on the Menu page. Review's tab reads the approvals extension's registry entry by id,
// for placement only.

interface Tab {
    readonly id: string;
    readonly to: string;
    readonly label: string;
    // What the tab says without being opened: the same shape the desktop rail badges with, so one renderer
    // serves all four instead of a hand-rolled span per tab.
    readonly badge?: ViewBadge;
    // Which workspace panel this tab owns, for Review sharing the workspace path with the Menu's Files; absent otherwise.
    readonly panel?: "changes";
    // A standing fact drawn as a corner glyph and spelled out in the label, like AreaTile.note.
    readonly note?: { readonly icon: IconName; readonly text: string };
    // Which routes light this tab, where a path prefix would light two: Agents owns the board alone and Chat every
    // conversation screen under it.
    readonly match?: (route: RouteLocationNormalizedLoaded) => boolean;
}

const changes = useChanges();
const pushFlow = usePushFlow();
const { badge: sandboxBadge } = useSandboxAttention();
// The Menu tab stands for the sandbox on a phone, so it carries both kinds of news about it: what it needs from its
// owner (the badge) and work under way that ends by replacing it (the turning mark).
const { activeSandboxId } = useSandbox();
const menuBadge = computed<ViewBadge | undefined>(() => {
    const running = restartRunning(activeSandboxId.value);
    const badge = sandboxBadge.value;
    if (badge === undefined && running === undefined) {
        return undefined;
    }
    return { ...badge, ...(running === undefined ? {} : { running }) };
});
// The Chat tab is whichever conversation was last in front: its screen is the agent route (mobileChatPath), and the
// tab wears what that chat is doing, so a turn running or an answer owed shows without opening it.
const { active } = useChat();
const chatBadge = computed<ViewBadge | undefined>(() => {
    switch (active.value.status.value) {
        case `streaming`:
            return { running: `Working on your last message` };
        case `awaiting`:
            return { count: 1, tooltip: t(`shell.mobileTabBar.waitingAnswer`) };
        default:
            return undefined;
    }
});
const chatTab = computed<Tab>(() => ({
    id: `chat`,
    to: mobileChatPath(active.value.conversationId),
    label: t(`shell.mobileTabBar.chat`),
    match: (route) => route.path.startsWith(`/agents/`),
    ...(chatBadge.value === undefined ? {} : { badge: chatBadge.value }),
}));

// Matched by view id (detectActivations); tabBarIds() is the shared promotion list ShellMobile also reads.
const approvalsTile = useApprovalsTile();

// Falls back to the same push-owed glyph as the desktop rail when nothing else needs review.
const reviewBadge = computed<ViewBadge | undefined>(() => {
    // Rides whatever the badge says rather than competing with it: the turning mark has its own corner, and the count
    // is still 0 until the land's patch is in the tree.
    const landing: Pick<ViewBadge, `running`> = changes.landing.value === undefined ? {} : { running: changes.landing.value };
    // A push in flight or unsent comes first: it's happening now, and its panel is two taps away.
    const push = pushBadge(pushFlow.stage.value, pushFlow.question.value, pushFlow.held.value);
    if (push !== undefined) {
        return { ...push, ...landing };
    }
    const count = (approvalsTile.value?.badge?.count ?? 0) + changes.count.value;
    if (count > 0) {
        return { count, tooltip: t(`shell.mobileTabBar.toReview`, { count }), ...landing };
    }
    const work = changes.outgoing.value;
    if (work === undefined) {
        return changes.landing.value === undefined ? undefined : landing;
    }
    return { mark: outgoingMark(work), tooltip: outgoingSummary(work), ...landing };
});

const tabs = computed<readonly Tab[]>(() => [
    {
        id: `agents`,
        to: `/agents`,
        label: t(`shell.mobileTabBar.agents`),
        // The desktop rail's tile, on a phone: one derivation (agentsTile.ts) for both, so a count that follows
        // the board's scope cannot follow it in one shell and not the other.
        ...(agentsBadge.value === undefined ? {} : { badge: agentsBadge.value }),
        ...(agentsScopeNote.value === undefined ? {} : { note: { icon: `boxes` as IconName, text: agentsScopeNote.value } }),
        match: (route) => route.path === `/agents`,
    },
    chatTab.value,
    {
        /* The queue when the pack is on; the workspace's OWN review: its Changes panel, when it is off. */
        id: `approvals`,
        to: approvalsTile.value?.to ?? `/workspace?panel=changes`,
        label: t(`shell.mobileTabBar.review`),
        ...(reviewBadge.value === undefined ? {} : { badge: reviewBadge.value }),
        ...(approvalsTile.value === undefined ? { panel: `changes` as const } : {}),
    },
    { id: `menu`, to: `/menu`, label: t(`shell.mobileTabBar.menu`), ...(menuBadge.value === undefined ? {} : { badge: menuBadge.value }) },
]);

// Same order as the rail's tileLabel; the only spot badge, running work and note are spelled out for a screen reader.
const tabLabel = (tab: Tab): string =>
    [tab.label, tab.badge?.tooltip, tab.badge?.running, tab.note?.text].filter((part) => part !== undefined).join(` · `);

const route = useRoute();
// Matches by path prefix, not active-class (it drops on a splat param), or by the tab's own `match`. When a tab
// declares `panel`, that must also match the query (absent means files), or Review would light up over the Files page.
const isNavActive = (tab: Tab): boolean => {
    if (tab.match !== undefined) {
        return tab.match(route);
    }
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
            <!-- One type size for all three corner marks, the same one the desktop rail sets: each states its own size as a
                 multiple of it, so the badge, the turning mark and the note weigh the same instead of landing on three numbers. -->
            <span class="relative text-[0.625rem]">
                <RailIcon :area="tab.id" class="text-xl" />
                <ViewBadgeChip :badge="tab.badge" class="absolute -right-2.5 -top-1" aria-hidden="true" />
                <!-- Work in flight, in the corner the badge and note both leave free; same mark as the desktop rail. -->
                <TileMark v-if="tab.badge?.running !== undefined" name="spinner" spin :class="[RUNNING_MARK_CLASS, `absolute -bottom-1 -right-2`]" />
                <!-- Sits in the corner the badge doesn't use; aria-hidden like the badge, since the label already carries it. -->
                <TileMark v-if="tab.note" :name="tab.note.icon" class="absolute -bottom-1 -left-2 text-subtle" />
            </span>
            <span class="text-2xs font-medium">{{ tab.label }}</span>
        </RouterLink>
    </nav>
</template>
