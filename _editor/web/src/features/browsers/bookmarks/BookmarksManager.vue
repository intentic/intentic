<!-- The bookmarks manager, beside the history page in the browser's library (BrowserLibrary.vue): the folders down the
     side, the open folder's pages and folders in their order, a search across all of them, each one renamed or
     readdressed from its pencil, removed from its ×, and dragged to a new place in its folder or onto a folder at the
     side to file it there. -->
<script setup lang="ts">
import type { BookmarkNode } from "@intentic/sandbox-contract/schemas/bookmarks";
import { AnchoredOverlay, Button, EmptyState, Icon, SearchBar, ui } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, nextTick, ref } from "vue";
import { childrenOf, dropIndex, folderChoices, isWithin, type OpenGesture, searchBookmarks, wantsNewTab } from "./bookmarkTree";
import { useBookmarks } from "./useBookmarks";

const emit = defineEmits<{ open: [url: string, newTab: boolean]; close: [] }>();

const t = useT();
const bookmarks = useBookmarks();
const { nodes } = bookmarks;
const rootTitle = (root: `bar` | `other`): string => (root === `bar` ? t(`browsers.bookmarks.bar`) : t(`browsers.bookmarks.other`));
const folders = computed(() => folderChoices(nodes.value, rootTitle));

const folder = ref(`bar`);
const search = ref(``);
const shown = computed(() => (search.value.trim() === `` ? childrenOf(nodes.value, folder.value) : searchBookmarks(nodes.value, search.value)));
const folderTitle = computed(() => folders.value.find((choice) => choice.id === folder.value)?.path ?? ``);

const pick = (node: BookmarkNode, gesture: OpenGesture): void => {
    if (node.kind === `folder`) {
        folder.value = node.id;
        search.value = ``;
    } else if (node.url !== undefined) {
        emit(`open`, node.url, wantsNewTab(gesture));
    }
};

// One card for every edit: a bookmark's name and address, a folder's name, or the name of a folder being made.
const card = ref<{ readonly node: BookmarkNode | undefined; readonly anchor: HTMLElement }>();
const cardOpen = computed({
    get: () => card.value !== undefined,
    set: (open) => {
        if (!open) {
            card.value = undefined;
        }
    },
});
const name = ref(``);
const address = ref(``);
const nameField = ref<HTMLInputElement>();
const editCard = (node: BookmarkNode | undefined, event: MouseEvent): void => {
    if (!(event.currentTarget instanceof HTMLElement)) {
        return;
    }
    card.value = { node, anchor: event.currentTarget };
    name.value = node?.title ?? t(`browsers.bookmarks.newFolderName`);
    address.value = node?.url ?? ``;
    void nextTick(() => nameField.value?.select());
};
const saveCard = (): void => {
    const editing = card.value;
    card.value = undefined;
    const title = name.value.trim();
    if (editing === undefined || title === ``) {
        return;
    }
    if (editing.node === undefined) {
        void bookmarks.add({ kind: `folder`, title, parent: folder.value });
        return;
    }
    const url = address.value.trim();
    void bookmarks.edit(editing.node.id, editing.node.kind === `url` && url !== `` ? { title, url } : { title });
};

// Dragging: a row onto another row lands before it, in that row's folder; onto a folder at the side, last in it.
const dragged = ref<string>();
const over = ref<string>();
const canDrop = (target: string): boolean => dragged.value !== undefined && !isWithin(nodes.value, target, dragged.value);
const dropOnRow = (target: BookmarkNode): void => {
    const id = dragged.value;
    dragged.value = undefined;
    over.value = undefined;
    if (id === undefined || id === target.id || target.parent === undefined || !canDrop(target.parent)) {
        return;
    }
    void bookmarks.move(id, target.parent, dropIndex(nodes.value, id, target));
};
const dropOnFolder = (target: string): void => {
    const id = dragged.value;
    dragged.value = undefined;
    over.value = undefined;
    if (id !== undefined && canDrop(target)) {
        void bookmarks.move(id, target, childrenOf(nodes.value, target).filter((node) => node.id !== id).length);
    }
};
</script>

<template>
    <section class="flex h-full min-h-0 flex-col bg-card" :aria-label="t(`browsers.bookmarks.title`)">
        <header class="flex shrink-0 flex-col gap-2 border-b border-line px-4 pb-3 pt-3">
            <div class="flex items-center gap-2">
                <slot name="heading">
                    <h2 class="min-w-0 flex-1 truncate text-sm font-medium text-content">{{ t(`browsers.bookmarks.title`) }}</h2>
                </slot>
                <button
                    type="button"
                    :class="ui.iconButton({ size: `md`, round: true })"
                    :aria-label="t(`browsers.history.close`)"
                    v-tooltip.bottom="t(`ui.action.close`)"
                    @click="emit(`close`)"
                >
                    <Icon name="times" class="text-xs" />
                </button>
            </div>
            <div class="flex flex-wrap items-center gap-2">
                <SearchBar
                    v-model="search"
                    variant="field"
                    clearable
                    class="min-w-48 flex-1"
                    :placeholder="t(`browsers.bookmarks.search`)"
                    :aria-label="t(`browsers.bookmarks.search`)"
                />
                <Button
                    :label="t(`browsers.bookmarks.newFolder`)"
                    size="small"
                    tier="boring"
                    class="shrink-0"
                    @click="(event: MouseEvent) => editCard(undefined, event)"
                >
                    <template #icon><Icon name="plus" /></template>
                </Button>
            </div>
        </header>

        <div class="flex min-h-0 flex-1">
            <nav class="w-56 shrink-0 overflow-y-auto border-r border-line p-2 max-md:hidden" :aria-label="t(`browsers.bookmarks.folders`)">
                <button
                    v-for="choice in folders"
                    :key="choice.id"
                    type="button"
                    class="ui-row-select flex w-full items-center gap-2 rounded-md py-1.5 pr-2 text-left text-xs"
                    :class="[folder === choice.id && search === `` ? 'ui-row-select-on' : '', over === choice.id ? 'ring-1 ring-inset ring-primary-500' : '']"
                    :style="{ paddingLeft: `${0.5 + choice.depth * 0.75}rem` }"
                    @click="
                        folder = choice.id;
                        search = ``;
                    "
                    @dragover.prevent="over = canDrop(choice.id) ? choice.id : undefined"
                    @dragleave="over = over === choice.id ? undefined : over"
                    @drop.prevent="dropOnFolder(choice.id)"
                >
                    <Icon :name="folder === choice.id ? `folder-open` : `folder`" class="shrink-0 text-2xs text-subtle" />
                    <span class="min-w-0 flex-1 truncate text-content">{{ choice.title }}</span>
                </button>
            </nav>

            <div class="min-h-0 min-w-0 flex-1 overflow-y-auto">
                <div class="mx-auto flex w-full max-w-3xl flex-col px-2 py-3">
                    <h3 class="px-2 pb-1 text-2xs font-medium text-muted">{{ search.trim() === `` ? folderTitle : t(`browsers.bookmarks.found`) }}</h3>
                    <EmptyState
                        v-if="shown.length === 0"
                        icon="star"
                        :title="search.trim() === `` ? t(`browsers.bookmarks.emptyFolder`) : t(`browsers.history.noMatch`, { query: search.trim() })"
                    />
                    <div
                        v-for="node in shown"
                        :key="node.id"
                        role="button"
                        tabindex="0"
                        draggable="true"
                        class="ui-row-select group/entry flex cursor-pointer items-center gap-3 rounded-md px-2 py-1.5 text-xs"
                        :class="[over === `row:${node.id}` ? 'shadow-[inset_0_2px_0_var(--color-primary-500)]' : '', dragged === node.id ? 'opacity-50' : '']"
                        @click="pick(node, $event)"
                        @auxclick="pick(node, $event)"
                        @keydown.enter="pick(node, $event)"
                        @dragstart="dragged = node.id"
                        @dragend="
                            dragged = undefined;
                            over = undefined;
                        "
                        @dragover.prevent="over = `row:${node.id}`"
                        @drop.prevent="dropOnRow(node)"
                    >
                        <img v-if="node.favicon" :src="node.favicon" alt="" class="size-4 shrink-0 rounded-sm object-contain" />
                        <Icon v-else :name="node.kind === `folder` ? `folder` : `globe`" class="shrink-0 text-2xs text-subtle" />
                        <span class="flex min-w-0 flex-1 items-baseline gap-2">
                            <span class="truncate text-content">{{ node.title || node.url }}</span>
                            <span v-if="node.url" class="truncate text-subtle">{{ node.url.replace(/^https?:\/\//, ``).replace(/\/$/, ``) }}</span>
                        </span>
                        <button
                            type="button"
                            class="flex size-6 shrink-0 items-center justify-center rounded-full text-subtle opacity-0 transition-opacity hover:bg-content/10 hover:text-content focus-visible:opacity-100 group-hover/entry:opacity-100"
                            :aria-label="t(`browsers.bookmarks.edit`)"
                            v-tooltip.bottom="t(`browsers.bookmarks.edit`)"
                            @click.stop="editCard(node, $event)"
                        >
                            <Icon name="pencil" class="text-3xs" />
                        </button>
                        <button
                            type="button"
                            class="flex size-6 shrink-0 items-center justify-center rounded-full text-subtle opacity-0 transition-opacity hover:bg-content/10 hover:text-content focus-visible:opacity-100 group-hover/entry:opacity-100"
                            :aria-label="t(`ui.action.remove`)"
                            v-tooltip.bottom="t(`ui.action.remove`)"
                            @click.stop="bookmarks.remove(node.id)"
                        >
                            <Icon name="times" class="text-3xs" />
                        </button>
                    </div>
                </div>
            </div>
        </div>

        <AnchoredOverlay v-model="cardOpen" :anchor="card?.anchor" side="bottom" cross="end">
            <form class="flex w-72 flex-col gap-3 p-3" @submit.prevent="saveCard">
                <label class="flex flex-col gap-1">
                    <span class="text-2xs text-muted">{{ t(`browsers.bookmarks.name`) }}</span>
                    <input ref="nameField" v-model="name" type="text" class="ui-field-box ui-field-sm w-full" />
                </label>
                <label v-if="card?.node?.kind === `url`" class="flex flex-col gap-1">
                    <span class="text-2xs text-muted">{{ t(`browsers.bookmarks.address`) }}</span>
                    <input v-model="address" type="url" class="ui-field-box ui-field-sm w-full" />
                </label>
                <div class="flex justify-end gap-1.5">
                    <Button size="small" tier="quiet" @click="card = undefined">{{ t(`ui.action.cancel`) }}</Button>
                    <Button size="small" tier="accent" type="submit">{{ card?.node ? t(`ui.action.save`) : t(`browsers.bookmarks.create`) }}</Button>
                </div>
            </form>
        </AnchoredOverlay>
    </section>
</template>
