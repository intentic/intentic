<!-- The star at the end of the address bar: hollow for a page not kept, filled for one that is. Pressed (or Ctrl+D, which
     LiveBrowser.vue routes to `toggle`), a page not kept is bookmarked at once, onto the bar, with its tab's icon, and a
     small card opens to rename it or file it in a folder, as a browser's does; on a page already kept the same card
     opens, with Remove. Bookmarks are the person's own (`_own`), whichever window the page is in. -->
<script setup lang="ts">
import type { BookmarkNode } from "@intentic/sandbox-contract/schemas/bookmarks";
import type { BrowserPage } from "@intentic/sandbox-contract/schemas/terminal";
import { AnchoredOverlay, Button, Icon, Picker, ui } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, nextTick, ref } from "vue";
import { bookmarkable, bookmarkFor, folderChoices } from "./bookmarkTree";
import { type BookmarkChange, type NewBookmark, useBookmarks } from "./useBookmarks";

const { page } = defineProps<{
    // The page in front, when it is a web page.
    page: BrowserPage | undefined;
}>();

const t = useT();
const bookmarks = useBookmarks();
const kept = computed<BookmarkNode | undefined>(() => bookmarkFor(bookmarks.nodes.value, page?.url));
const usable = computed(() => bookmarkable(page?.url));

const star = ref<HTMLElement | undefined>();
const open = ref(false);
// Whether the card is for a bookmark just made, which it says, or one being edited.
const fresh = ref(false);
const name = ref(``);
const folder = ref<string | undefined>(`bar`);
const nameField = ref<HTMLInputElement | undefined>();

const folderOptions = computed(() =>
    folderChoices(bookmarks.nodes.value, (root) => (root === `bar` ? t(`browsers.bookmarks.bar`) : t(`browsers.bookmarks.other`))).map((choice) => ({
        value: choice.id,
        label: choice.path,
        icon: `folder` as const,
    })),
);

const showCard = (node: BookmarkNode, made: boolean): void => {
    fresh.value = made;
    name.value = node.title;
    folder.value = node.parent ?? `bar`;
    open.value = true;
    void nextTick(() => nameField.value?.select());
};

/** The star's press and Ctrl+D: keep the page and open the card, or open the card on the bookmark it already is. */
const toggle = async (): Promise<void> => {
    if (!usable.value || page === undefined) {
        return;
    }
    if (kept.value !== undefined) {
        showCard(kept.value, false);
        return;
    }
    // With the tab's own icon, so the bar and the address bar's rows show it before the page is visited again.
    const bookmark: NewBookmark = { kind: `url`, title: page.title ?? page.url, url: page.url };
    if (page.favicon !== undefined) {
        bookmark.favicon = page.favicon;
    }
    const made = await bookmarks.add(bookmark);
    if (made !== undefined) {
        showCard(made, true);
    }
};

const done = (): void => {
    const node = kept.value;
    open.value = false;
    const title = name.value.trim();
    if (node === undefined) {
        return;
    }
    const change: BookmarkChange = {};
    if (title !== `` && title !== node.title) {
        change.title = title;
    }
    if (folder.value !== undefined && folder.value !== node.parent) {
        change.parent = folder.value;
    }
    if (change.title !== undefined || change.parent !== undefined) {
        void bookmarks.edit(node.id, change);
    }
};

const remove = (): void => {
    const node = kept.value;
    open.value = false;
    if (node !== undefined) {
        void bookmarks.remove(node.id);
    }
};

defineExpose({ toggle });
</script>

<template>
    <button
        v-if="usable"
        ref="star"
        type="button"
        :class="ui.iconButton({ round: true }, `shrink-0`)"
        :aria-pressed="kept !== undefined"
        :aria-label="kept ? t(`browsers.bookmarks.edit`) : t(`browsers.bookmarks.add`)"
        v-tooltip.bottom="kept ? t(`browsers.bookmarks.edit`) : t(`browsers.bookmarks.add`)"
        @click="toggle"
    >
        <Icon :name="kept ? `star-fill` : `star`" class="text-2xs" :class="kept ? 'text-warning' : ''" />
    </button>
    <AnchoredOverlay v-model="open" :anchor="star" side="bottom" cross="end" @update:model-value="(shown: boolean) => shown || done()">
        <form class="flex w-72 flex-col gap-3 p-3" @submit.prevent="done">
            <p class="text-xs font-medium text-content">{{ fresh ? t(`browsers.bookmarks.added`) : t(`browsers.bookmarks.edit`) }}</p>
            <label class="flex flex-col gap-1">
                <span class="text-2xs text-muted">{{ t(`browsers.bookmarks.name`) }}</span>
                <input ref="nameField" v-model="name" type="text" class="ui-field-box ui-field-sm w-full" />
            </label>
            <label class="flex flex-col gap-1">
                <span class="text-2xs text-muted">{{ t(`browsers.bookmarks.folder`) }}</span>
                <Picker v-model="folder" :options="folderOptions" :aria-label="t(`browsers.bookmarks.folder`)" :header="t(`browsers.bookmarks.folder`)" />
            </label>
            <div class="flex justify-end gap-1.5">
                <Button size="small" tier="quiet" tone="danger" @click="remove">{{ t(`ui.action.remove`) }}</Button>
                <Button size="small" tier="accent" type="submit">{{ t(`browsers.bookmarks.done`) }}</Button>
            </div>
        </form>
    </AnchoredOverlay>
</template>
