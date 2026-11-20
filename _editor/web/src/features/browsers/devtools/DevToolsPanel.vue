<script setup lang="ts">
import { Icon, ui } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import type { PageTools } from "./usePageTools";

// Chromium's own DevTools for the page in front, docked under the picture as a browser docks its own: the real
// frontend, drawn by the person's browser in a frame and talking to the page through the sandbox (devtools-proxy.ts),
// not a picture of one. The picture above shrinks to make room, and the page's viewport with it.

const { tools, title } = defineProps<{ tools: PageTools; title: string | undefined }>();
const t = useT();
</script>

<template>
    <section v-if="tools.devtools.value" class="flex h-2/5 min-h-40 shrink-0 flex-col border-t border-line bg-card" :aria-label="t(`browsers.tools.devtools`)">
        <header class="flex h-7 shrink-0 items-center gap-2 border-b border-line px-2">
            <Icon name="code" class="shrink-0 text-2xs text-muted" />
            <span class="min-w-0 flex-1 truncate text-2xs text-muted">{{ t(`browsers.tools.devtools`) }}<template v-if="title"> · {{ title }}</template></span>
            <button type="button" :class="ui.iconButton()" :aria-label="t(`browsers.tools.closeDevtools`)" v-tooltip.top="t(`ui.action.close`)" @click="tools.closeDevtools()">
                <Icon name="times" class="text-3xs" />
            </button>
        </header>
        <iframe :key="tools.devtools.value.src" :src="tools.devtools.value.src" class="min-h-0 w-full flex-1 border-0 bg-white" :title="t(`browsers.tools.devtools`)" />
    </section>
</template>
