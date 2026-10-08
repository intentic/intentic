<script setup lang="ts">
import { Icon, ResponsiveOverlay, type Tip, toneWash, ui, useDevice } from "@intentic/ui";
import { computed, ref } from "vue";
import { useVocabulary } from "../../../workbench/views/vocabulary";
import { useScopeTitle } from "../health/scopeTitle";
import { useWorkspaceTree } from "./useWorkspaceTree";
import { workspaceAgent } from "../../../app/workspaceScope";
import { useT } from "@intentic/ui/i18n";
import WorkspaceScopePicker from "./WorkspaceScopePicker.vue";

const t = useT();

// Shows whose workspace is open; the scope is otherwise invisible (tree and files look the same for every agent).
// A chip in the existing bar rather than a banner, since the scope is a persistent mode, not a one-off alert.
// Absent on the shared tree: the default needs no marker. A press opens the switcher (WorkspaceScopePicker): a
// searchable list under the board's lanes, not a menu, since a busy sandbox has dozens of copies to choose between.

const { error } = useWorkspaceTree();
const title = useScopeTitle();
const { mobile } = useDevice();

const open = ref(false);
const anchor = ref<HTMLElement>();

// True when an archived agent has lost its checkout (branch kept, checkout gone).
const broken = computed(() => error.value !== undefined);

const words = useVocabulary();
// Whose copy, and what a press does: the name is the fact, the rest one short line.
const tip = computed((): Tip => ({
    title: broken.value ? t(`workspace.workspaceScopeChip.copyUnreadable`) : t(`workspace.words.privateCopy`),
    tone: broken.value ? `warning` : undefined,
    rows: [{ label: words.value.Agent, value: title.value }],
    note: broken.value ? t(`workspace.workspaceScopeChip.clickForShared`) : t(`workspace.workspaceScopeChip.readOnlyClickToSwitch`),
}));
const ariaLabel = computed(() =>
    broken.value
        ? t(`workspace.workspaceScopeChip.brokenAria`, { name: title.value })
        : t(`workspace.workspaceScopeChip.copyAria`, { name: title.value }),
);

const pick = (agent: string | undefined): void => {
    open.value = false;
    workspaceAgent.value = agent;
};
</script>

<template>
    <template v-if="workspaceAgent !== undefined">
        <button
            ref="anchor"
            type="button"
            :class="ui.chip({ on: !broken }, `h-6 shrink-0 px-1.5`, broken && toneWash(`warning`))"
            aria-haspopup="listbox"
            :aria-expanded="open"
            :aria-label="ariaLabel"
            v-tooltip.bottom="open ? undefined : tip"
            @click="open = !open"
        >
            <Icon :name="broken ? `exclamation-triangle` : `robot`" class="shrink-0 text-[0.7rem]" />
            <!-- Name truncates first on narrow panes; icon and tint alone still mark a non-shared scope, tooltip has the rest. -->
            <span class="max-w-28 truncate max-lg:hidden">{{ title }}</span>
            <Icon name="chevron-down" class="shrink-0 text-[0.6rem] opacity-70 transition-transform" :class="{ 'rotate-180': open }" />
        </button>
        <ResponsiveOverlay
            v-model="open"
            :anchor="anchor"
            side="bottom"
            cross="end"
            :header="t(`workspace.workspaceScopeChip.showFilesFrom`)"
            panel-class="w-[23rem] max-w-[calc(100vw-1rem)]"
        >
            <WorkspaceScopePicker :current="workspaceAgent" :autofocus="!mobile" @pick="pick" @close="open = false" />
        </ResponsiveOverlay>
    </template>
</template>
