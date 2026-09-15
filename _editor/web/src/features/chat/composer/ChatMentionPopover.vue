<script setup lang="ts">
import { useListNavigation } from "@intentic/ui";
import ComposerPopover from "./ComposerPopover.vue";
import { computed, onUnmounted } from "vue";
import { useFuzzyFiles } from "../../workspace/search/useFuzzyFiles";
import { basename, parentDir } from "@intentic/ui/path";
import { subscribe as watchOtherBoxes } from "../../sandbox/live/fleetAcross";
import { KIND_META, type QuickPick, type QuickPickSources, quickRows } from "./composerQuickPick";
import { parseMentionToken } from "./useMentions";

// The `@` picker: the four turn settings (composerQuickPick) above the workspace files, one list, one highlight.
// An empty token shows each setting's current value; a word searches both; a `kind:` prefix drills into one setting
// and puts the files away. The parent owns the keyboard via move/pickActive and decides what a pick does.

const props = defineProps<{
    query: string;
    sources: QuickPickSources;
    // Files are this workspace's tree; a conversation in another box is offered none.
    filesOffered: boolean;
}>();
const emit = defineEmits<{ pick: [pick: QuickPick] }>();

// Other boxes are read only while this list is open, the placement menu's own rule: the store polls every sandbox
// the account owns, so mounting only while watched is exactly what it's for.
onUnmounted(watchOtherBoxes());

const token = computed(() => parseMentionToken(props.query));
const settingRows = computed(() => quickRows(props.sources, token.value));
const settingsOffered = computed(() => Object.values(props.sources).some((source) => source !== undefined));

// Files ride only an undrilled token; a drill is one setting's list and nothing else.
const filesActive = computed(() => token.value.kind === undefined && props.filesOffered);
const fileQuery = computed(() => (filesActive.value ? token.value.query : ``));
const { paths, floor, searching, pending } = useFuzzyFiles(fileQuery, filesActive);

const MAX_FILES = 8;
const fileRows = computed<readonly QuickPick[]>(() =>
    filesActive.value ? paths.value.slice(0, MAX_FILES).map((path) => ({ kind: `file`, key: `file:${path}`, path })) : [],
);
const rows = computed<readonly QuickPick[]>(() => [...settingRows.value, ...fileRows.value]);

const { activeIndex, activeRow, move, setRowEl } = useListNavigation(rows, (row) => row.key);

const pickActive = (): boolean => {
    const row = activeRow.value;
    if (row === undefined) {
        return false;
    }
    emit(`pick`, row);
    return true;
};

const header = computed(() => {
    const kind = token.value.kind;
    if (kind !== undefined) {
        return KIND_META[kind];
    }
    if (!settingsOffered.value) {
        return { label: `Mention a file`, icon: `paperclip` as const };
    }
    return props.filesOffered ? { label: `Mention a file or change a setting`, icon: `paperclip` as const } : { label: `Change a setting`, icon: `sliders-h` as const };
});

// The one line under the rows: the file floor while files could still come, else the miss.
const belowFloor = computed(() => filesActive.value && token.value.query.trim().length < floor.value);
const nothing = computed(() => rows.value.length === 0 && !belowFloor.value && !searching.value && !pending.value);

defineExpose({ move, pickActive });
</script>

<template>
    <ComposerPopover :icon="header.icon" :title="header.label" :busy="searching || pending">
        <!-- Capped and scrolled so a drilled model list stays a sheet over the composer, not a wall. -->
        <div class="max-h-80 overflow-y-auto">
            <button
                v-for="(row, index) in rows"
                :key="row.key"
                :ref="(el) => setRowEl(row.key, el)"
                type="button"
                class="ui-row-select flex w-full items-center gap-2 px-3 py-1.5 text-left"
                :class="{ 'ui-row-select-on': index === activeIndex }"
                @mousedown.prevent="emit('pick', row)"
            >
                <template v-if="row.kind === 'file'">
                    <Icon name="file" class="shrink-0 text-2xs text-subtle" />
                    <span class="truncate text-xs text-content">{{ basename(row.path) }}</span>
                    <span v-if="parentDir(row.path)" class="truncate text-2xs text-subtle">{{ parentDir(row.path) }}</span>
                </template>
                <!-- A summary row reads "Acts as · Intentic ›": the verb, the value, the way in. -->
                <template v-else-if="row.kind === 'drill'">
                    <Icon :name="KIND_META[row.into].icon" class="shrink-0 text-2xs text-subtle" />
                    <span class="shrink-0 text-xs text-content">{{ row.label }}</span>
                    <span class="truncate text-xs text-subtle">{{ row.detail }}</span>
                    <Icon name="chevron-right" class="ml-auto shrink-0 text-2xs text-subtle" />
                </template>
                <template v-else>
                    <!-- The badge says which setting a row changes, since a search mixes them. -->
                    <span class="w-14 shrink-0 text-2xs uppercase tracking-wide text-subtle">{{ KIND_META[row.kind].badge }}</span>
                    <span class="truncate text-xs text-content">{{ row.label }}</span>
                    <span v-if="row.detail" class="truncate text-2xs text-subtle">{{ row.detail }}</span>
                    <Icon v-if="row.current" name="check" class="ml-auto shrink-0 text-2xs text-primary-500" aria-hidden="true" />
                </template>
            </button>
        </div>
        <p v-if="belowFloor" class="px-3 py-2 text-xs text-subtle">Keep typing to search files…</p>
        <p v-else-if="nothing" class="px-3 py-2 text-xs text-subtle">Nothing matches "{{ token.query }}".</p>
    </ComposerPopover>
</template>
