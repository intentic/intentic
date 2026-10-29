<!-- The views Home can show of every sandbox (lib/routes/homeSection.ts): its home conversation, then the sections the
     selected sandbox's own rail offers (sectionTiles.ts), its Chat ranked among them. Mounted only while the
     list is open (HomeSectionPicker.vue), so the tiles are read only then; keyed and filtered as Show a file's list is
     (workspace/home/HomeCoverPicker.vue). -->
<script setup lang="ts">
import { SearchBar, useListNavigation } from "@intentic/ui";
import Icon from "@intentic/ui/icon";
import { useT } from "@intentic/ui/i18n";
import { computed, nextTick, onMounted, ref } from "vue";
import type { HomeSection } from "../../lib/routes/homeSection";
import RailIcon from "./RailIcon.vue";
import { type SectionTile, useSectionTiles } from "./sectionTiles";

const { chosen } = defineProps<{ chosen: HomeSection | undefined }>();
const emit = defineEmits<{ choose: [section: HomeSection | undefined] }>();

const t = useT();
// The Chat heads the sandbox's sections, as on its rail when it docks there.
const { tiles } = useSectionTiles(() => [{ id: `chat`, to: `/chat`, label: t(`shared.chat`), icon: `comments` }]);

const sectionOf = ({ id, to, label, icon, monogram }: SectionTile): HomeSection => {
    let section: HomeSection = { id, to, label };
    if (icon !== undefined) {
        section = { ...section, icon };
    }
    if (monogram !== undefined) {
        section = { ...section, monogram };
    }
    return section;
};

// The home conversation first, the way back to Home's own page; `undefined` is that choice.
interface Row {
    readonly key: string;
    readonly label: string;
    readonly section: HomeSection | undefined;
}
const HOME = `\u0000home`;
const query = ref(``);
const rows = computed<readonly Row[]>(() => {
    const needle = query.value.trim().toLowerCase();
    const all: Row[] = [
        { key: HOME, label: t(`home.section.homeConversation`), section: undefined },
        ...tiles.value.map((tile): Row => ({ key: tile.to, label: tile.label, section: sectionOf(tile) })),
    ];
    return all.filter((row) => row.label.toLowerCase().includes(needle));
});
const keyOf = (row: Row): string => row.key;
const { activeIndex, activeRow, move, setRowEl } = useListNavigation(rows, keyOf);
const isChosen = (row: Row): boolean => row.section?.to === chosen?.to;

const pick = (row: Row | undefined): void => {
    if (row !== undefined) {
        emit(`choose`, row.section);
    }
};

// Opens on the view already chosen, the field ready for a name.
const field = ref<InstanceType<typeof SearchBar>>();
onMounted(async () => {
    await nextTick();
    activeIndex.value = Math.max(rows.value.findIndex(isChosen), 0);
    field.value?.focus();
});

const onFieldKey = (event: KeyboardEvent): void => {
    if (event.key === `ArrowDown` || event.key === `ArrowUp`) {
        event.preventDefault();
        move(event.key === `ArrowDown` ? 1 : -1);
        return;
    }
    if (event.key === `Enter`) {
        event.preventDefault();
        pick(activeRow.value);
        return;
    }
    // A typed name is cleared before the list closes, the way every filter field here answers Escape.
    if (event.key === `Escape` && query.value !== ``) {
        event.stopPropagation();
        query.value = ``;
    }
};
</script>

<template>
    <SearchBar
        ref="field"
        v-model="query"
        variant="field"
        dense
        :placeholder="t(`home.section.findView`)"
        :aria-label="t(`home.section.findView`)"
        @keydown="onFieldKey"
    />
    <p class="px-2 pt-2 pb-1 text-2xs text-subtle">{{ t(`home.section.listTitle`) }}</p>
    <ul role="listbox" class="max-h-80 overflow-y-auto" :aria-label="t(`home.section.listTitle`)">
        <li
            v-for="(row, index) in rows"
            :key="row.key"
            :ref="(el) => setRowEl(row.key, el)"
            role="option"
            :aria-selected="index === activeIndex"
            class="ui-row-select flex h-8 items-center gap-2 rounded-md px-2 text-xs"
            :class="index === activeIndex ? `ui-row-select-on` : ``"
            @pointermove="activeIndex = index"
            @click="pick(row)"
        >
            <span class="flex w-4 shrink-0 justify-center text-sm text-muted">
                <Icon v-if="row.section === undefined" name="home" aria-hidden="true" />
                <RailIcon v-else :section="row.section.id" :fallback="row.section.icon" :label="row.label" :monogram="row.section.monogram" />
            </span>
            <span class="min-w-0 flex-1 truncate">{{ row.label }}</span>
            <Icon v-if="isChosen(row)" name="check" class="shrink-0 text-2xs text-link" aria-hidden="true" />
        </li>
    </ul>
    <p v-if="rows.length === 0" class="px-2 py-2 text-2xs text-subtle">{{ t(`home.section.noneNamed`) }}</p>
</template>
