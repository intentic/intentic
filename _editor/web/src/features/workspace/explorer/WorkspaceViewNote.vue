<script setup lang="ts">
import { Icon } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { isShared, SHARED_SCOPE, workspaceView } from "../../../app/workspaceScope";
import { useScopeTitle } from "../health/scopeTitle";

// Another copy on screen (a branch, a conversation's own), said at the explorer's foot where the project scope is
// (WorkspaceScopeNote.vue): that it is only a look, read-only, that only the files changed (search, the Changes panel,
// terminals and previews still work on the shared workspace), and the way back. The chip in the bar says which copy;
// this says what that means, in words, since a lit chip alone left readers searching a branch for a file only it had.

const t = useT();
const title = useScopeTitle();
const shown = computed(() => !isShared(workspaceView.value));
const onBranch = computed(() => workspaceView.value.branch !== undefined);
</script>

<template>
    <div v-if="shown" class="flex shrink-0 flex-col gap-0.5 border-t border-line px-2.5 py-1.5 text-2xs text-subtle" role="status">
        <div class="flex items-center gap-1.5">
            <Icon :name="onBranch ? `git-branch` : `robot`" class="shrink-0 text-[0.65rem]" />
            <span class="min-w-0 flex-1 truncate">{{ t(`workspace.workspaceViewNote.readOnly`, { name: title }) }}</span>
            <button
                type="button"
                class="shrink-0 cursor-pointer rounded-sm px-1 text-muted transition-colors hover:bg-content/5 hover:text-content"
                @click="workspaceView = SHARED_SCOPE"
            >
                {{ t(`workspace.workspaceViewNote.backToShared`) }}
            </button>
        </div>
        <p>{{ t(`workspace.workspaceScopeChip.staysShared`) }}</p>
    </div>
</template>
