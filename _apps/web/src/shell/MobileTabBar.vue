<script setup lang="ts">
import type { IconName } from "@intentic/ui";
import type { ViewBadge } from "@intentic/extension-api";
import { computed } from "vue";
import { RouterLink, useRoute } from "vue-router";
import { badgeClass, badgeText } from "../core-views/viewBadge";
import { useAgents } from "../composables/agents/useAgents";
import { useDrafts } from "../composables/extensions/useDrafts";
import { outgoingMark, outgoingSummary } from "../composables/workspace/outgoingWork";
import { useChanges } from "../composables/workspace/useChanges";
import { useSandboxAttention } from "../composables/sandbox/sandboxAttention";
import { useSandbox } from "../composables/sandbox/useSandbox";

/* The mobile shell's bottom navigation: four fixed thumb-size tabs. Agents is the primary on-the-go surface —
 * glance at the fleet, tap in to drive one — and carries the "agents need you" badge; Review carries the
 * things-to-act-on badge (agent drafts + uncommitted changes); Menu carries what the sandbox needs from its
 * owner, standing in for the desktop rail's sandbox chip, which a phone has nowhere to put. Everything the
 * desktop rail holds beyond these lives on the Menu page. Tabs that talk to the daemon are inert while it's
 * unreachable — Menu stays live because sandbox switching lives there. */

interface Tab {
    readonly to: string;
    readonly label: string;
    readonly icon: IconName;
    // Whether the tab's target needs a reachable daemon (Menu doesn't — it hosts the sandbox switcher).
    readonly needsSandbox: boolean;
    // What the tab says without being opened — the same shape the desktop rail badges with, so one renderer
    // serves all four instead of a hand-rolled span per tab.
    readonly badge?: ViewBadge;
}

const { reachable } = useSandbox();
const { drafts, invalid: invalidDrafts } = useDrafts();
const { attention } = useAgents();
const changes = useChanges();
const { badge: sandboxBadge } = useSandboxAttention();

// Things to act on: agent drafts plus uncommitted changes. Once that total is zero but the workspace still owes
// its remotes a push, the same glyph the desktop rail and the Changes tab wear takes over — so the fact looks
// the same on a phone as on a desk, and the tab never reads as empty over work that is still waiting.
const reviewBadge = computed<ViewBadge | undefined>(() => {
    const count = drafts.value.length + invalidDrafts.value.length + changes.count.value;
    if (count > 0) {
        return { count, tooltip: `${count} to review` };
    }
    const work = changes.outgoing.value;
    return work === undefined ? undefined : { mark: outgoingMark(work), tooltip: outgoingSummary(work) };
});

const tabs = computed<readonly Tab[]>(() => [
    {
        to: `/agents`,
        label: `Agents`,
        icon: `comments`,
        needsSandbox: true,
        ...(attention.value > 0
            ? { badge: { count: attention.value, tooltip: `${attention.value} need${attention.value === 1 ? `s` : ``} you` } }
            : {}),
    },
    { to: `/workspace`, label: `Files`, icon: `folder`, needsSandbox: true },
    { to: `/drafts`, label: `Review`, icon: `send`, needsSandbox: true, ...(reviewBadge.value === undefined ? {} : { badge: reviewBadge.value }) },
    { to: `/menu`, label: `Menu`, icon: `bars`, needsSandbox: false, ...(sandboxBadge.value === undefined ? {} : { badge: sandboxBadge.value }) },
]);

// ONE label per tab, badge included — the rail's tileLabel rule. A badge is a glyph or a bare number, so the
// sentence saying what it counts has nowhere else to go on a form factor with no hover.
const tabLabel = (tab: Tab): string => (tab.badge?.tooltip === undefined ? tab.label : `${tab.label} · ${tab.badge.tooltip}`);

const route = useRoute();
// A tab is active for its route AND any sub-path (a file open on /workspace) — `active-class` compares params
// and drops the highlight once the splat param is set, so match by path prefix instead.
const isNavActive = (to: string): boolean => route.path === to || route.path.startsWith(`${to}/`);
</script>

<template>
    <nav class="flex shrink-0 items-stretch border-t border-line bg-card pb-[env(safe-area-inset-bottom)]">
        <RouterLink
            v-for="tab in tabs"
            :key="tab.to"
            :to="tab.to"
            class="relative flex h-14 min-w-0 flex-1 flex-col items-center justify-center gap-0.5 text-muted transition-colors active:bg-overlay"
            :class="{ 'pointer-events-none opacity-40': tab.needsSandbox && !reachable, 'text-link': isNavActive(tab.to) }"
            :tabindex="tab.needsSandbox && !reachable ? -1 : undefined"
            :aria-disabled="tab.needsSandbox && !reachable"
            :aria-label="tabLabel(tab)"
        >
            <!-- One badge for every tab — a `mark` replaces the number where the amount isn't what you act on.
                 aria-hidden: the link's own label above already says it in words. -->
            <span class="relative">
                <Icon :name="tab.icon" class="text-xl" />
                <span
                    v-if="tab.badge"
                    class="absolute -right-2.5 -top-1 flex min-w-4 items-center justify-center rounded-full px-1 text-center text-[0.6rem] font-semibold leading-4"
                    :class="badgeClass(tab.badge)"
                    aria-hidden="true"
                >
                    <Icon v-if="tab.badge.mark !== undefined" :name="tab.badge.mark as IconName" />
                    <template v-else>{{ badgeText(tab.badge) }}</template>
                </span>
            </span>
            <span class="text-2xs font-medium">{{ tab.label }}</span>
        </RouterLink>
    </nav>
</template>
