<script setup lang="ts">
import { Icon, type Tip } from "@intentic/ui";
import { computed } from "vue";
import { setProjectScope } from "../../../app/projectScope";
import { workspaceDir } from "../../../app/workspaceScope";
import { useT } from "@intentic/ui/i18n";

// Opening a project, which creating one does, narrows the whole workspace to it (the files, the agents, the checks),
// and a chip in the status strip was the only sign: a new user took the narrowed tree for missing files, pressed the
// active Files tab again and again, and deleted the project. So the explorer says it too. It used to say it as a card
// above the first row, in the link colour, and that read as a prompt to press: readers lifted the scope they had just
// opened and worked from the root (2026-10-17). It now sits at the foot of the explorer, one muted line that is there
// to be found, not pressed: the project's name and a quiet way back to everything. The same clear as the chip's
// (WorkspaceDirChip.vue).

const t = useT();

const project = computed(() => (workspaceDir.value === `` ? undefined : workspaceDir.value));

const hint = computed((): Tip => ({
    title: t(`workspace.workspaceScopeNote.title`),
    rows: [{ label: t(`workspace.workspaceScopeNote.project`), value: project.value ?? `` }],
    note: t(`workspace.workspaceScopeNote.showingOnly`),
}));
</script>

<template>
    <div
        v-if="project"
        class="flex h-6 shrink-0 items-center gap-1.5 border-t border-line px-2.5 text-2xs text-subtle"
        role="status"
        v-tooltip.top="hint"
    >
        <Icon name="folder-open" class="shrink-0 text-[0.65rem]" />
        <span class="min-w-0 flex-1 truncate">{{ t(`workspace.workspaceScopeNote.onlyProject`, { project }) }}</span>
        <button
            type="button"
            class="shrink-0 cursor-pointer rounded-sm px-1 text-muted transition-colors hover:bg-content/5 hover:text-content"
            @click="setProjectScope(undefined)"
        >
            {{ t(`workspace.workspaceScopeNote.showEverything`) }}
        </button>
    </div>
</template>
