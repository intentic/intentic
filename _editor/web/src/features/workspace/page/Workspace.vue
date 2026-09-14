<script setup lang="ts">
import { useDevice } from "@intentic/ui";
import { asyncView } from "../../../components/asyncView";

/* The workspace route uses resizable panes on desktop and a drill-down viewer on mobile. */

const WorkspaceDesktop = asyncView(() => import("./WorkspaceDesktop.vue"));
const WorkspaceMobile = asyncView(() => import("./WorkspaceMobile.vue"));

const { mobile } = useDevice();
</script>

<template>
    <WorkspaceMobile v-if="mobile" />
    <WorkspaceDesktop v-else />
</template>
