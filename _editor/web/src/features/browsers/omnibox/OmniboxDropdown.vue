<!-- The address bar's suggestions, hung under the field: what Enter does first, then pages from history, open tabs, the
     search and the engine's suggestions (rank.ts orders them). A listbox the field owns (ARIA's combobox pattern): the
     keyboard stays in the field, which names the highlighted row as its active descendant, and a press on a row never
     takes the focus away from it. -->
<script setup lang="ts">
import { Icon, type IconName, ui } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import type { OmniboxRow, Segment } from "./rank";

const { rows, highlight, listId, variant = `bar` } = defineProps<{
    rows: readonly OmniboxRow[];
    highlight: number;
    // The listbox's id, which the field's aria-controls names; each row's id is this and its index.
    listId: string;
    variant?: `bar` | `hero`;
}>();

const emit = defineEmits<{ choose: [row: OmniboxRow]; hover: [index: number]; remove: [row: OmniboxRow] }>();

const t = useT();

// A page's slot shows its site's icon once pages carry one; a globe stands in until then.
const glyphOf = (row: OmniboxRow): IconName => {
    switch (row.kind) {
        case `history`:
        case `address`:
            return `globe`;
        case `tab`:
            return `window-maximize`;
        case `suggestion`:
            return row.past ? `history` : `search`;
        case `search`:
        case `keyword`:
            return `search`;
    }
};

const plain = (text: string): Segment[] => [{ text, match: false }];

const faviconOf = (row: OmniboxRow): string | undefined => (row.kind === `history` ? row.favicon : row.kind === `tab` ? row.tab.favicon : undefined);

// The row's first line and the quieter part after it, an address drawn as a link.
interface RowParts {
    readonly main: Segment[];
    readonly note: Segment[] | undefined;
    readonly link: boolean;
}

const textOf = (segments: readonly Segment[]): string => segments.map((segment) => segment.text).join(``);

const partsOf = (row: OmniboxRow): RowParts => {
    switch (row.kind) {
        case `history`:
            // A page with no title of its own shows its address once, not twice.
            return { main: row.title, note: textOf(row.title) === textOf(row.address) ? undefined : row.address, link: true };
        case `address`:
            return { main: row.address, note: undefined, link: false };
        case `tab`:
            return { main: row.title, note: row.address, link: true };
        case `search`:
            return { main: plain(row.query), note: plain(t(`browsers.omnibox.engineSearch`, { engine: row.engine })), link: false };
        case `keyword`:
            return { main: plain(row.query), note: plain(t(`browsers.omnibox.siteSearch`, { site: row.site.name })), link: false };
        case `suggestion`:
            return { main: row.text, note: undefined, link: false };
    }
};
</script>

<template>
    <div
        :id="listId"
        role="listbox"
        :aria-label="t(`browsers.omnibox.suggestions`)"
        class="absolute inset-x-0 top-full z-40 mt-1 flex max-h-[min(28rem,60vh)] flex-col gap-px overflow-y-auto rounded-xl border border-line bg-card p-1 shadow-lg"
        @mousedown.prevent
    >
        <div
            v-for="(row, index) in rows"
            :id="`${listId}-${index}`"
            :key="row.id"
            role="option"
            :aria-selected="index === highlight"
            class="ui-row-select group/row flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5"
            :class="[index === highlight ? 'ui-row-select-on' : '', variant === 'hero' ? 'py-2 text-sm' : 'py-1.5 text-xs']"
            @mousemove="index === highlight || emit(`hover`, index)"
            @click="emit(`choose`, row)"
        >
            <!-- The site's icon where a bookmark or an open tab carries one, else the row's glyph: a fixed square, so rows
                 line up whatever fills it. -->
            <span class="flex size-4 shrink-0 items-center justify-center text-subtle" aria-hidden="true">
                <img v-if="faviconOf(row)" :src="faviconOf(row)" alt="" class="size-4 rounded-sm object-contain" />
                <Icon v-else :name="glyphOf(row)" class="text-2xs" />
            </span>
            <span class="flex min-w-0 flex-1 items-baseline gap-1.5 truncate">
                <span class="truncate text-content">
                    <template v-for="(segment, at) in partsOf(row).main" :key="at">
                        <b v-if="segment.match" class="font-semibold">{{ segment.text }}</b>
                        <template v-else>{{ segment.text }}</template>
                    </template>
                </span>
                <template v-if="partsOf(row).note">
                    <span class="shrink-0 text-subtle" aria-hidden="true">–</span>
                    <span class="truncate" :class="partsOf(row).link ? 'text-link' : 'text-muted'">
                        <template v-for="(segment, at) in partsOf(row).note" :key="at">
                            <b v-if="segment.match" class="font-semibold">{{ segment.text }}</b>
                            <template v-else>{{ segment.text }}</template>
                        </template>
                    </span>
                </template>
            </span>
            <Icon v-if="row.kind === `history` && row.bookmarked" name="star-fill" class="shrink-0 text-3xs text-warning" :aria-label="t(`browsers.bookmarks.bookmarked`)" />
            <span v-if="row.kind === `tab`" :class="ui.chip({ size: `sm` }, `shrink-0 text-content`)">{{ t(`browsers.omnibox.switchToTab`) }}</span>
            <!-- Shift+Delete does the same from the keyboard. -->
            <button
                v-if="row.kind === `history`"
                type="button"
                tabindex="-1"
                class="flex size-5 shrink-0 items-center justify-center rounded-full text-subtle opacity-0 transition-opacity hover:bg-content/10 hover:text-content group-hover/row:opacity-100"
                :class="index === highlight ? 'opacity-100' : ''"
                :aria-label="t(`browsers.omnibox.remove`)"
                v-tooltip.bottom="t(`ui.action.remove`)"
                @click.stop="emit(`remove`, row)"
            >
                <Icon name="times" class="text-3xs" />
            </button>
        </div>
    </div>
</template>
