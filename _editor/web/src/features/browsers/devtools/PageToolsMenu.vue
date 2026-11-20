<script setup lang="ts">
import { Icon, type IconName } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { isApplePlatform } from "@intentic/ui/keys";
import { computed } from "vue";
import type { WindowTools } from "../windowTools";

// The browser menu's page tools, between its window verbs and closing: printing the page, its source, DevTools,
// recording the window, and the window's downloads. Each says its shortcut where one reaches it from the picture.

const { tools } = defineProps<{ tools: WindowTools }>();
const emit = defineEmits<{ done: [] }>();
const t = useT();

// The chords keyIntent.ts routes from the picture, spelled for the person's own keyboard: a Mac has no Ctrl+J for the
// downloads, and opens DevTools on ⌥⌘I where a PC has F12.
const mac = isApplePlatform();
const items = computed<readonly { readonly icon: IconName; readonly label: string; readonly keys?: string | undefined; readonly run: () => void }[]>(() => [
    { icon: `print`, label: t(`browsers.tools.print`), keys: mac ? `⌘P` : `Ctrl+P`, run: () => void tools.page.print() },
    { icon: `code`, label: t(`browsers.tools.viewSource`), run: () => void tools.page.viewSource() },
    { icon: `wrench`, label: t(`browsers.tools.devtools`), keys: mac ? `⌥⌘I` : `F12`, run: tools.page.toggleDevtools },
    tools.page.recording.value === undefined
        ? { icon: `circle-fill` as const, label: t(`browsers.tools.record`), run: () => void tools.page.toggleRecording() }
        : { icon: `stop` as const, label: t(`browsers.tools.stopRecording`), run: () => void tools.page.toggleRecording() },
    ...(tools.downloads.list.value.length > 0 || tools.downloads.open.value
        ? [{ icon: `download` as const, label: t(`browsers.tools.downloads`), keys: mac ? undefined : `Ctrl+J`, run: () => (tools.downloads.open.value = true) }]
        : []),
]);
</script>

<template>
    <div class="mx-2 my-0.5 h-px bg-line" />
    <button
        v-for="item in items"
        :key="item.label"
        type="button"
        class="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-left text-xs text-content transition-colors hover:bg-content/5"
        @click="
            emit(`done`);
            item.run();
        "
    >
        <Icon :name="item.icon" class="shrink-0 text-2xs text-muted" />
        <span class="min-w-0 flex-1 truncate">{{ item.label }}</span>
        <span v-if="item.keys" class="shrink-0 text-3xs text-subtle">{{ item.keys }}</span>
    </button>
    <p v-if="tools.page.error.value" class="px-2 text-3xs text-danger">{{ tools.page.error.value }}</p>
</template>
