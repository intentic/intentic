<script setup lang="ts">
import { ContextMenu, Icon } from "@intentic/ui";
import type { MenuItem } from "primevue/menuitem";
import { computed, ref } from "vue";
import { useMenuLink } from "../../../shell/menuLink";
import { useAgents } from "../../agents/fleet/useAgents";
import { useScopeTitle } from "../health/scopeTitle";
import { useWorkspaceTree } from "./useWorkspaceTree";
import { workspaceAgent } from "../health/workspaceScope";

// Shows whose workspace is open; the scope is otherwise invisible (tree and files look the same for every agent).
// A chip in the existing bar rather than a banner, since the scope is a persistent mode, not a one-off alert.
// Absent on the shared tree: the default needs no marker.

const { fleet } = useAgents();
const { error } = useWorkspaceTree();
const link = useMenuLink();
const title = useScopeTitle();

const menu = ref<{ show: (event: Event) => void }>();

// Other agents with a private checkout to switch to (excludes the current one and any without a checkout).
const switchable = computed(() => fleet.value.filter((agent) => agent.branch !== undefined && agent.id !== workspaceAgent.value));

// True when an archived agent has lost its checkout (branch kept, checkout gone).
const broken = computed(() => error.value !== undefined);

const hint = computed(() =>
    broken.value
        ? `${title.value}'s working copy can't be read. Click to go back to the shared workspace.`
        : `Showing ${title.value}'s copy of the workspace: its work hasn't landed yet, so these files are read-only. Click to switch.`,
);

const items = computed<MenuItem[]>(() => [
    {
        label: `Shared workspace`,
        icon: `folder`,
        checked: workspaceAgent.value === undefined,
        command: () => (workspaceAgent.value = undefined),
    },
    ...(switchable.value.length === 0
        ? []
        : [
              { separator: true },
              ...switchable.value.map((agent) => ({
                  label: agent.title ?? `Untitled conversation`,
                  icon: `robot` as const,
                  command: () => (workspaceAgent.value = agent.id),
              })),
          ]),
    // A link, not a command, so it carries its address via useMenuLink.
    ...(workspaceAgent.value === undefined
        ? []
        : [{ separator: true }, { label: `See its changes`, icon: `check-square`, ...link(`/agents/${workspaceAgent.value}`) }]),
]);
</script>

<template>
    <template v-if="workspaceAgent !== undefined">
        <button
            type="button"
            class="ui-chip h-6 shrink-0 px-1.5"
            :class="broken ? `bg-warning/15 text-warning hover:bg-warning/25` : `ui-chip-on`"
            aria-haspopup="menu"
            :aria-label="hint"
            v-tooltip.bottom="hint"
            @click="menu?.show($event)"
        >
            <Icon :name="broken ? `exclamation-triangle` : `robot`" class="shrink-0 text-[0.7rem]" />
            <!-- Name truncates first on narrow panes; icon and tint alone still mark a non-shared scope, tooltip has the rest. -->
            <span class="max-w-28 truncate max-lg:hidden">{{ title }}</span>
            <Icon name="chevron-down" class="shrink-0 text-[0.6rem] opacity-70" />
        </button>
        <ContextMenu ref="menu" :model="items" :min-width="14" />
    </template>
</template>
