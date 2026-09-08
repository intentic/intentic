<script setup lang="ts">
import { Button, Icon } from "@intentic/ui";
import { RouterLink } from "vue-router";
import { useScopeTitle } from "../health/scopeTitle";
import { useWorkspaceTree } from "./useWorkspaceTree";
import { workspaceAgent } from "../health/workspaceScope";

// Shown when an archived agent has lost its checkout (work stays on its branch): the daemon's
// PRECONDITION_FAILED, see workspace-scope.ts. Full pane, not a banner: the tree is already empty here.

const { error } = useWorkspaceTree();
const title = useScopeTitle();
</script>

<template>
    <div class="flex h-full flex-col items-center justify-center gap-5 px-6 text-center">
        <Icon name="robot" class="text-3xl text-subtle" />
        <div class="flex max-w-md flex-col gap-1.5">
            <p class="text-base font-semibold text-content">{{ title }} has no working copy to browse</p>
            <!-- Daemon's own message: it knows why (archived, reclaimed, never had one), this view doesn't. -->
            <p class="text-xs text-muted">{{ error }}</p>
        </div>
        <div class="flex flex-wrap items-center justify-center gap-2">
            <!-- A link styled as a button, not a button that navigates: it's a destination, meant to open in a new tab. -->
            <Button size="small" :as="RouterLink" :to="`/agents/${workspaceAgent}`">
                <Icon name="check-square" />
                See its changes
            </Button>
            <Button size="small" severity="secondary" @click="workspaceAgent = undefined">
                <Icon name="folder" class="text-[0.7rem]" />
                Back to the shared workspace
            </Button>
        </div>
    </div>
</template>
