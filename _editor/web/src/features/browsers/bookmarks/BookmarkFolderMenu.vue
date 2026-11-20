<!-- One bookmarks folder as a menu, for the bar's folders: its pages and its folders, a folder opening in place with a
     way back, so a deep tree never spills across the screen. A page opens where Enter in the address bar would send it,
     or in a new tab of the person's own with Ctrl, ⌘ or the middle button. -->
<script setup lang="ts">
import type { BookmarkNode } from "@intentic/sandbox-contract/schemas/bookmarks";
import { Icon } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, ref } from "vue";
import { childrenOf, wantsNewTab } from "./bookmarkTree";

const { nodes, folder } = defineProps<{
    nodes: readonly BookmarkNode[];
    // The folder the menu opens on.
    folder: string;
}>();

const emit = defineEmits<{ open: [url: string, newTab: boolean] }>();

const t = useT();
// The folders opened since, deepest last.
const trail = ref<readonly BookmarkNode[]>([]);
const shown = computed(() => trail.value.at(-1)?.id ?? folder);
const items = computed(() => childrenOf(nodes, shown.value));

const pick = (node: BookmarkNode, event: MouseEvent): void => {
    if (node.kind === `folder`) {
        trail.value = [...trail.value, node];
        return;
    }
    if (node.url !== undefined) {
        emit(`open`, node.url, wantsNewTab(event));
    }
};
</script>

<template>
    <div class="flex max-h-[min(28rem,70vh)] w-64 flex-col gap-0.5 overflow-y-auto p-1" role="menu">
        <button
            v-if="trail.length > 0"
            type="button"
            role="menuitem"
            class="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-left text-xs text-muted transition-colors hover:bg-content/5"
            @click="trail = trail.slice(0, -1)"
        >
            <Icon name="arrow-left" class="shrink-0 text-2xs" />
            <span class="min-w-0 flex-1 truncate">{{ trail.at(-1)?.title }}</span>
        </button>
        <button
            v-for="node in items"
            :key="node.id"
            type="button"
            role="menuitem"
            :title="node.url"
            class="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-left text-xs text-content transition-colors hover:bg-content/5"
            @click="pick(node, $event)"
            @auxclick="pick(node, $event)"
        >
            <img v-if="node.favicon" :src="node.favicon" alt="" class="size-4 shrink-0 rounded-sm object-contain" />
            <Icon v-else :name="node.kind === `folder` ? `folder` : `globe`" class="shrink-0 text-2xs text-subtle" />
            <span class="min-w-0 flex-1 truncate">{{ node.title || node.url }}</span>
            <Icon v-if="node.kind === `folder`" name="chevron-right" class="shrink-0 text-3xs text-subtle" />
        </button>
        <p v-if="items.length === 0" class="px-2 py-1 text-xs text-muted">{{ t(`browsers.bookmarks.emptyFolder`) }}</p>
    </div>
</template>
