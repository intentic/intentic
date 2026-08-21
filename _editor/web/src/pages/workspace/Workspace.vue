<script setup lang="ts">
import { useDevice } from "@intentic/ui";
import { asyncView } from "../../components/asyncView";

/* The /workspace route, split by form factor: the VSCode-like explorer + tabs + resizable panes under a
 * pointer, a drill-down list + full-screen viewer on mobile. Both read the same singletons (tree, tabs,
 * review), so crossing the breakpoint keeps the open file and unreviewed counts.
 *
 * Through asyncView rather than defineAsyncComponent, for the same reasons the route table switched (see
 * components/asyncView.ts): a bare async component renders NOTHING while its chunk downloads, a blank pane
 * where the editor is about to be, with no failure surface and no stale-chunk recovery, and it re-fetches
 * nothing the idle prefetcher (router/prefetch.ts) has already pulled. No outline: the editor's honest
 * placeholder is the shell's background, and WorkspaceDesktop draws its own inner skeletons once mounted. */

const WorkspaceDesktop = asyncView(() => import("./WorkspaceDesktop.vue"));
const WorkspaceMobile = asyncView(() => import("./WorkspaceMobile.vue"));

const { mobile } = useDevice();
</script>

<template>
    <WorkspaceMobile v-if="mobile" />
    <WorkspaceDesktop v-else />
</template>
