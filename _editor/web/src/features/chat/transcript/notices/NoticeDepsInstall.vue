<script setup lang="ts">
import { Button, type ButtonTier } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { openWorkTerminal, useWorkTerminals } from "../../../../models/terminal/useWorkTerminals";
import type { ChatMessage } from "../../../../models/conversations/transcript/transcript";

/* Reveals the terminal of a dependency install the daemon started, while it still runs. */

const { tier = `quiet` } = defineProps<{ message: ChatMessage; tier?: ButtonTier }>();

const t = useT();
const { rows } = useWorkTerminals();
// Install jobs are keyed `<project>--install` (workspace-setup.ts installPanelKey).
const session = computed(() => rows.value.find((row) => row.session.endsWith(`--install`))?.session);
</script>

<template>
    <Button v-if="session !== undefined" size="small" :tier="tier" class="shrink-0" @click="openWorkTerminal(session)">
        {{ t(`chat.chatMessageView.watchInstall`) }}
    </Button>
</template>
