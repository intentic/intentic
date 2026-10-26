<script setup lang="ts">
import { CopyButton } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { agentPanel, info } from "./machine";

// WHICH BUILD THIS IS, at the foot of This device: the first thing anyone helping with a problem asks, on the one page
// the main window always has, with no account and no sandbox. The copy is the same facts in one line for a bug report,
// left in English since whoever reads it is debugging. The tray's update row says the version too (update.rs), for a
// window that will not draw.

const t = useT();
const line = computed((): string | undefined => {
    const app = info.value;
    if (app === undefined) {
        return undefined;
    }
    const agent = agentPanel.value?.version;
    return `Intentic ${app.version} (${app.os})${agent === undefined ? `` : `, machine agent ${agent}`}`;
});
</script>

<template>
    <footer v-if="info && line" class="flex items-center gap-1.5 text-2xs text-subtle" data-app-build>
        <span class="font-mono" v-tooltip.top="line">{{ t(`desktop.device.appVersion`, { version: info.version }) }}</span>
        <CopyButton :text="line" />
    </footer>
</template>
