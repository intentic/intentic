<script setup lang="ts">
import { onMounted, onUnmounted } from "vue";
import { useSandboxLiveness } from "../features/sandbox/overview/useSandboxLiveness";

// A local window's one live connection, in place of WorkspaceRuntime: the sidecar's event stream, which says the folder
// is reachable (the extension host waits for that) and what moved on disk. Presence, chat, the background loader and
// the restart watch are about a sandbox, which this window has none of.

const liveness = useSandboxLiveness();
onMounted(() => liveness.start());
onUnmounted(() => liveness.stop());
</script>

<template>
    <!-- Nothing drawn: this component is the stream's lifetime. -->
</template>
