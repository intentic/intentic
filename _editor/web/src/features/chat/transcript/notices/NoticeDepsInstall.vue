<script setup lang="ts">
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { openWorkTerminal, useWorkTerminals } from "../../../terminal/useWorkTerminals";
import type { ChatMessage } from "../transcript";

/* Reveals the terminal of a dependency install the daemon started, while it still runs. */

defineProps<{ message: ChatMessage }>();

const t = useT();
const { rows } = useWorkTerminals();
// Install jobs are keyed `<project>--install` (workspace-setup.ts installPanelKey).
const session = computed(() => rows.value.find((row) => row.session.endsWith(`--install`))?.session);
</script>

<template>
    <button v-if="session !== undefined" type="button" class="shrink-0 font-medium text-link hover:underline" @click="openWorkTerminal(session)">
        {{ t(`chat.chatMessageView.watchInstall`) }}
    </button>
</template>
