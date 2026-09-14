<script setup lang="ts">
import { useDevice } from "@intentic/ui";
import { useRouter } from "vue-router";
import { globalTerminalSource } from "./useTerminalPanel";
import TerminalPanel from "./TerminalPanel.vue";

/* The mobile terminal: the same sandbox-global tmux sessions the desktop panel docks below every view, as a full-screen route. */

const router = useRouter();
const { keyboardInset } = useDevice();
</script>

<template>
    <div class="h-full" :style="{ paddingBottom: `${keyboardInset}px` }">
        <TerminalPanel :resizable="false" :source="globalTerminalSource" storage-key="sandbox" @close="router.back()" />
    </div>
</template>
