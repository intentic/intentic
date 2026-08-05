<script setup lang="ts">
import { useDevice } from "@intentic/ui";
import { useRouter } from "vue-router";
import { globalTerminalSource } from "../composables/terminal/useTerminalPanel";
import TerminalPanel from "./TerminalPanel.vue";

/* The mobile terminal: the same sandbox-global tmux sessions the desktop panel docks below every view, as a
 * full-screen route. Same storage key, so the focused tab follows across form factors; the session cache in
 * useTerminal keeps shells and scrollback alive across navigation either way. The panel pads itself above
 * the on-screen keyboard. */

const router = useRouter();
const { keyboardInset } = useDevice();
</script>

<template>
    <div class="h-full" :style="{ paddingBottom: `${keyboardInset}px` }">
        <TerminalPanel :resizable="false" :source="globalTerminalSource" storage-key="sandbox" @close="router.back()" />
    </div>
</template>
