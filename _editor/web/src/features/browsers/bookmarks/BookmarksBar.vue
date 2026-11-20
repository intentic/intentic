<!-- The bookmarks bar under the toolbar (off by default; the menu and Ctrl+Shift+B switch it, bookmarksBar.ts): the
     bar folder's pages and folders in their order, a folder opening as a menu, and the other bookmarks at the far end, as
     a browser draws its own. A page opens where Enter in the address bar would send it, or in a new tab of the person's
     own with Ctrl, ⌘ or the middle button. -->
<script setup lang="ts">
import type { BookmarkNode } from "@intentic/sandbox-contract/schemas/bookmarks";
import { AnchoredOverlay, Icon, ui } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, ref } from "vue";
import BookmarkFolderMenu from "./BookmarkFolderMenu.vue";
import { childrenOf, wantsNewTab } from "./bookmarkTree";
import { useBookmarks } from "./useBookmarks";

const emit = defineEmits<{ open: [url: string, newTab: boolean] }>();

const t = useT();
const { nodes, loaded } = useBookmarks();
const items = computed(() => childrenOf(nodes.value, `bar`));
const others = computed(() => childrenOf(nodes.value, `other`));

// The folder whose menu is open, and what it hangs from.
const menu = ref<string>();
const anchor = ref<HTMLElement>();
const menuOpen = computed({
    get: () => menu.value !== undefined,
    set: (shown) => {
        if (!shown) {
            menu.value = undefined;
        }
    },
});

const press = (node: BookmarkNode, event: MouseEvent): void => {
    if (node.kind === `folder`) {
        anchor.value = event.currentTarget instanceof HTMLElement ? event.currentTarget : undefined;
        menu.value = menu.value === node.id ? undefined : node.id;
        return;
    }
    if (node.url !== undefined) {
        emit(`open`, node.url, wantsNewTab(event));
    }
};

const opened = (url: string, newTab: boolean): void => {
    menu.value = undefined;
    emit(`open`, url, newTab);
};
</script>

<template>
    <nav class="flex h-8 shrink-0 items-center gap-0.5 border-b border-line bg-card px-2" :aria-label="t(`browsers.bookmarks.bar`)">
        <div class="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto [scrollbar-width:none]">
            <button
                v-for="node in items"
                :key="node.id"
                type="button"
                :title="node.url ?? node.title"
                :class="ui.chip({ on: menu === node.id }, `max-w-44 shrink-0 text-content`)"
                :aria-haspopup="node.kind === `folder` ? `menu` : undefined"
                :aria-expanded="node.kind === `folder` ? menu === node.id : undefined"
                @click="press(node, $event)"
                @auxclick="press(node, $event)"
            >
                <img v-if="node.favicon" :src="node.favicon" alt="" class="size-3.5 shrink-0 rounded-sm object-contain" />
                <Icon v-else :name="node.kind === `folder` ? `folder` : `globe`" class="shrink-0 text-3xs text-subtle" />
                <span class="truncate">{{ node.title || node.url }}</span>
            </button>
            <span v-if="loaded && items.length === 0" class="truncate px-2 text-2xs text-muted">{{ t(`browsers.bookmarks.barEmpty`) }}</span>
        </div>
        <button
            v-if="others.length > 0"
            type="button"
            :class="ui.chip({ on: menu === `other` }, `shrink-0 text-content`)"
            aria-haspopup="menu"
            :aria-expanded="menu === `other`"
            @click="press({ id: `other`, kind: `folder`, title: ``, added: 0 }, $event)"
        >
            <Icon name="folder" class="shrink-0 text-3xs text-subtle" />
            <span class="truncate">{{ t(`browsers.bookmarks.other`) }}</span>
        </button>
        <AnchoredOverlay v-model="menuOpen" :anchor="anchor" side="bottom" cross="start">
            <BookmarkFolderMenu v-if="menu" :key="menu" :nodes="nodes" :folder="menu" @open="opened" />
        </AnchoredOverlay>
    </nav>
</template>
