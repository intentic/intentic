<script setup lang="ts">
import { ContextMenu, Icon } from "@intentic/ui";
import type { MenuItem } from "primevue/menuitem";
import { computed, ref } from "vue";
import { useMenuLink } from "../../composables/menuLink";
import { useAgents } from "../../composables/agents/useAgents";
import { useScopeTitle } from "../../composables/workspace/scopeTitle";
import { useWorkspaceTree } from "../../composables/workspace/useWorkspaceTree";
import { workspaceAgent } from "../../composables/workspace/workspaceScope";

/* WHOSE WORKSPACE AM I LOOKING AT, as a CONTROL rather than as a sentence.
 *
 * The scope is what makes a file address complete (workspaceScope) and it is otherwise invisible: the tree
 * looks like a tree and a file looks like a file. A reader who followed a link out of a conversation, kept
 * browsing, and had no way to know that the `README.md` in front of them was one agent's unlanded draft has
 * been given one silent wrong answer in place of another.
 *
 * IT USED TO BE A BANNER, and a banner was the wrong shape for it twice over. A banner is the ALERT channel:
 * transient, caused by something that just happened, read once. This is a MODE: it is true until somebody
 * changes it, which means a strip narrating it pays rent on every file for the rest of the session and, worse,
 * stops being seen at exactly the hour it starts mattering. And a banner can only be dismissed or obeyed: it
 * offered the way OUT of a scope and no way INTO another, so a reader who wanted a different agent's copy had
 * to go back to a chat and hunt for a link.
 *
 * So: a chip in a bar that already exists (no new band), stating the mode, opening every move. The container
 * itself carries the ambient half of the signal (see `.ws-scoped` in WorkspaceDesktop) the way a private
 * browsing window does, which is what makes this safe to keep small.
 *
 * ABSENT ON THE SHARED TREE, deliberately: the default needs no marker, and a chip that is always there is a
 * chip nobody reads when it changes. */

const { fleet } = useAgents();
const { error } = useWorkspaceTree();
const link = useMenuLink();
const title = useScopeTitle();

const menu = ref<{ show: (event: Event) => void }>();

/* The other copies this view could be pointed at: a live conversation with a private checkout of its own
 * (`branch`). An agent working directly in the shared tree has no copy to show, and an archived one has lost
 * its checkout, so neither is offered: a switcher whose entries open a broken view is worse than a short one. */
const switchable = computed(() => fleet.value.filter((agent) => agent.branch !== undefined && agent.id !== workspaceAgent.value));

// The daemon's own sentence when the scope cannot be read at all (an archived agent keeps its branch but loses
// its checkout, see workspace-scope.ts). The pane says the whole of it; the chip only has to stop claiming
// everything is fine.
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
    /* The route to the work itself, which is the ONE thing still worth reaching when the checkout is gone. A
     * PLACE rather than a verb, so it carries its address (useMenuLink): the reader who wants an agent's diff
     * while keeping the file they are on open is the reader this row was put here for. */
    ...(workspaceAgent.value === undefined
        ? []
        : [{ separator: true }, { label: `See its changes`, icon: `check-square`, ...link(`/agents/${workspaceAgent.value}`) }]),
]);
</script>

<template>
    <template v-if="workspaceAgent !== undefined">
        <button
            type="button"
            class="flex h-6 shrink-0 items-center gap-1.5 rounded-md px-1.5 text-2xs transition-colors"
            :class="broken ? `bg-warning/15 text-warning hover:bg-warning/25` : `bg-primary-600/15 text-link hover:bg-primary-600/25`"
            aria-haspopup="menu"
            :aria-label="hint"
            v-tooltip.bottom="hint"
            @click="menu?.show($event)"
        >
            <Icon :name="broken ? `exclamation-triangle` : `robot`" class="shrink-0 text-[0.7rem]" />
            <!-- The NAME is the payload, so it is the first thing to go when the bar runs out of room: under a
                 narrow pane the glyph and its tint still say "not the shared tree", which is the half that
                 must never be lost, and the tooltip carries the rest. -->
            <span class="max-w-28 truncate max-lg:hidden">{{ title }}</span>
            <Icon name="chevron-down" class="shrink-0 text-[0.6rem] opacity-70" />
        </button>
        <ContextMenu ref="menu" :model="items" :min-width="14" />
    </template>
</template>
