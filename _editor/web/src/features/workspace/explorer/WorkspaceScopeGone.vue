<script setup lang="ts">
import { Button, EmptyState, Icon } from "@intentic/ui";
import { RouterLink } from "vue-router";
import { useScopeTitle } from "../health/scopeTitle";
import { useWorkspaceTree } from "../../../models/workspace/tree/useWorkspaceTree";
import { SHARED_SCOPE, workspaceAgent, workspaceView } from "../../../app/workspaceScope";
import { useT } from "@intentic/ui/i18n";

// Shown when the copy on screen cannot be read: an archived agent that lost its checkout (work stays on its branch), the
// daemon's PRECONDITION_FAILED (workspace-scope.ts), or a branch that is gone. Full pane, not a banner: the tree is
// already empty here.

const t = useT();

const { error } = useWorkspaceTree();
const title = useScopeTitle();
</script>

<template>
    <!-- The line is the daemon's own message: it knows why (archived, reclaimed, never had one), this view doesn't. -->
    <EmptyState icon="robot" size="page" :title="t(`workspace.workspaceScopeGone.noWorkingCopyTo`, { title })" :line="error" class="h-full">
        <template #actions>
            <!-- A link styled as a button, not a button that navigates: it's a destination, meant to open in a new tab. -->
            <Button v-if="workspaceAgent !== undefined" tier="accent" size="small" :as="RouterLink" :to="`/agents/${workspaceAgent}`">
                <Icon name="check-square" />
                {{ t(`workspace.words.seeChanges`) }}
            </Button>
            <Button size="small" :tier="workspaceAgent === undefined ? `accent` : `boring`" @click="workspaceView = SHARED_SCOPE">
                <Icon name="folder" class="text-[0.7rem]" />
                {{ t(`workspace.workspaceScopeGone.backToSharedWorkspace`) }}
            </Button>
        </template>
    </EmptyState>
</template>
