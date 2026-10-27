<script setup lang="ts">
import { useDevice } from "@intentic/ui";
import { useRouter } from "vue-router";
import { globalTerminalSource } from "../../models/terminal/useTerminalPanel";
import TerminalPanel from "./TerminalPanel.vue";
import AccessGate from "../../components/access/AccessGate.vue";
import { useHeldPlace } from "../../components/heldPlace";
import { t } from "@intentic/ui/i18n";

/* The mobile terminal: the same sandbox-global tmux sessions the desktop panel docks below every view, as a full-screen route. */

const router = useRouter();
const { keyboardInset } = useDevice();
// A terminal is a maintainer's: anyone below meets the gate here, never a socket that reconnects into a refusal.
const { open, refused } = useHeldPlace();
</script>

<template>
    <div class="flex h-full flex-col" :style="{ paddingBottom: `${keyboardInset}px` }">
        <TerminalPanel v-if="open" :resizable="false" :poppable="false" :source="globalTerminalSource" storage-key="sandbox" @close="router.back()" />
        <AccessGate v-else-if="refused" :reason="refused" :place="t(`shared.terminal`)" />
    </div>
</template>
