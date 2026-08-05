<script setup lang="ts">
import { useDevice } from "@intentic/ui";
import { defineAsyncComponent } from "vue";

/* The /workspace route, split by form factor: the VSCode-like explorer + tabs + resizable panes under a
 * pointer, a drill-down list + full-screen viewer on mobile. Both read the same singletons (tree, tabs,
 * review), so crossing the breakpoint keeps the open file and unreviewed counts. */

const WorkspaceDesktop = defineAsyncComponent(() => import("./WorkspaceDesktop.vue"));
const WorkspaceMobile = defineAsyncComponent(() => import("./WorkspaceMobile.vue"));

const { mobile } = useDevice();
</script>

<template>
    <WorkspaceMobile v-if="mobile" />
    <WorkspaceDesktop v-else />
</template>
