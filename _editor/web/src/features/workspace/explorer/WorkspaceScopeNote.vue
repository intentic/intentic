<script setup lang="ts">
import { computed } from "vue";
import { setProjectScope } from "../../../app/projectScope";
import { workspaceDir } from "../health/workspaceScope";
import { useT } from "@intentic/ui/i18n";

// Opening a project, which creating one does, narrows the whole workspace to it (the files, the agents, the checks),
// and a chip in the status strip was the only sign: a new user took the narrowed tree for missing files, pressed the
// active Files tab again and again, and deleted the project. The tree says so where the rest of the files would be,
// with the way back to everything beside it. The same clear as the chip's (WorkspaceDirChip.vue).

const t = useT();

const project = computed(() => (workspaceDir.value === `` ? undefined : workspaceDir.value));
</script>

<template>
    <p v-if="project" class="mx-2 mb-1 flex flex-wrap items-baseline gap-x-1.5 rounded-md bg-content/5 px-2 py-1 text-2xs text-muted" role="status">
        <span class="min-w-0 break-words">{{ t(`workspace.workspaceScopeNote.showingOnly`, { project }) }}</span>
        <button type="button" class="shrink-0 cursor-pointer text-link hover:underline" @click="setProjectScope(undefined)">
            {{ t(`workspace.workspaceScopeNote.showEverything`) }}
        </button>
    </p>
</template>
