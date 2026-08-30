<script setup lang="ts">
import { Button, Icon } from "@intentic/ui";
import { RouterLink } from "vue-router";
import { useScopeTitle } from "../../composables/workspace/scopeTitle";
import { useWorkspaceTree } from "../../composables/workspace/useWorkspaceTree";
import { workspaceAgent } from "../../composables/workspace/workspaceScope";

/* THE ONE FAILURE THE SCOPE HAS OF ITS OWN, given the whole pane rather than a strip across the top of it.
 *
 * An archived agent keeps its work on its branch but loses its checkout, so there is no tree to read, and a
 * link in that conversation is still a link somebody clicks months later. The daemon says so specifically
 * (PRECONDITION_FAILED, see workspace-scope.ts) and the sentence it sends is shown here.
 *
 * WHY THIS IS NOT A BANNER, when the mode it belongs to no longer is one either: those are opposite arguments
 * reaching the same answer. The mode is permanent and must not cost a band, so it became a chip. This is an
 * EVENT, it deserves weight, and it happens to arrive at the one moment when weight is free: there is no tree
 * and no file, so the pane it would have crowded is empty. A thin strip over a blank screen was the worst of
 * both: too quiet to read as the reason, and sitting on top of nothing. */

const { error } = useWorkspaceTree();
const title = useScopeTitle();
</script>

<template>
    <div class="flex h-full flex-col items-center justify-center gap-5 px-6 text-center">
        <Icon name="robot" class="text-3xl text-subtle" />
        <div class="flex max-w-md flex-col gap-1.5">
            <p class="text-base font-semibold text-content">{{ title }} has no working copy to browse</p>
            <!-- The daemon's own words. It knows WHY (archived, reclaimed, never had one) and this view does
                 not, so it is passed through rather than guessed at ahead of it. -->
            <p class="text-xs text-muted">{{ error }}</p>
        </div>
        <div class="flex flex-wrap items-center justify-center gap-2">
            <!-- The work still exists on the agent's branch, so the route to it is the primary action: this
                 pane's whole job is to be the answer to "then where did it go". A LINK wearing a button, not a
                 button that navigates: this is a destination, and somebody reading a dead checkout is exactly
                 the person who wants to open the diff in a second tab (see navigatingControl.test.ts). -->
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
