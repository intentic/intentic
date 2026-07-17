<script setup lang="ts">
import type { IconName } from "@intentic-app/ui";
import { computed } from "vue";
import { RouterLink, useRoute } from "vue-router";
import { useAgents } from "../composables/agents/useAgents";
import { useDrafts } from "../composables/extensions/useDrafts";
import { useChanges } from "../composables/workspace/useChanges";
import { useSandbox } from "../composables/sandbox/useSandbox";

/* The mobile shell's bottom navigation: four fixed thumb-size tabs. Agents is the primary on-the-go surface —
 * glance at the fleet, tap in to drive one — and carries the "agents need you" badge; Review carries the
 * things-to-act-on badge (agent drafts + uncommitted changes); everything the desktop rail holds beyond these
 * lives on the Menu page. Tabs that talk to the daemon are inert while it's unreachable — Menu stays live
 * because sandbox switching lives there. */

interface Tab {
    readonly to: string;
    readonly label: string;
    readonly icon: IconName;
    // Whether the tab's target needs a reachable daemon (Menu doesn't — it hosts the sandbox switcher).
    readonly needsSandbox: boolean;
}

const TABS: readonly Tab[] = [
    { to: `/agents`, label: `Agents`, icon: `comments`, needsSandbox: true },
    { to: `/workspace`, label: `Files`, icon: `folder`, needsSandbox: true },
    { to: `/drafts`, label: `Review`, icon: `send`, needsSandbox: true },
    { to: `/menu`, label: `Menu`, icon: `bars`, needsSandbox: false },
];

const { reachable } = useSandbox();
const { drafts, invalid: invalidDrafts } = useDrafts();
const { attention } = useAgents();
const changes = useChanges();
const reviewBadge = computed(() => drafts.value.length + invalidDrafts.value.length + changes.count.value);

const route = useRoute();
// A tab is active for its route AND any sub-path (a file open on /workspace) — `active-class` compares params
// and drops the highlight once the splat param is set, so match by path prefix instead.
const isNavActive = (to: string): boolean => route.path === to || route.path.startsWith(`${to}/`);
</script>

<template>
    <nav class="flex shrink-0 items-stretch border-t border-line bg-card pb-[env(safe-area-inset-bottom)]">
        <RouterLink
            v-for="tab in TABS"
            :key="tab.to"
            :to="tab.to"
            class="relative flex h-14 min-w-0 flex-1 flex-col items-center justify-center gap-0.5 text-muted transition-colors active:bg-overlay"
            :class="{ 'pointer-events-none opacity-40': tab.needsSandbox && !reachable, 'text-link': isNavActive(tab.to) }"
            :tabindex="tab.needsSandbox && !reachable ? -1 : undefined"
            :aria-disabled="tab.needsSandbox && !reachable"
            :aria-label="tab.label"
        >
            <span class="relative">
                <Icon :name="tab.icon" class="text-xl" />
                <span
                    v-if="tab.to === '/drafts' && reviewBadge > 0"
                    class="absolute -right-2.5 -top-1 min-w-4 rounded-full bg-primary-600/15 px-1 text-center text-[0.6rem] font-semibold leading-4 text-link"
                    >{{ reviewBadge > 99 ? "99+" : reviewBadge }}</span
                >
                <span
                    v-if="tab.to === '/agents' && attention > 0"
                    class="absolute -right-2.5 -top-1 min-w-4 rounded-full bg-primary-600/15 px-1 text-center text-[0.6rem] font-semibold leading-4 text-link"
                    >{{ attention > 99 ? "99+" : attention }}</span
                >
            </span>
            <span class="text-2xs font-medium">{{ tab.label }}</span>
        </RouterLink>
    </nav>
</template>
