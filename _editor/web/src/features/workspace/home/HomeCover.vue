<!-- The home read through one file name: this folder and the folders in it down the side, the chosen file of the one selected beside them. -->
<script setup lang="ts">
import type { WorkspaceTreeEntry } from "@intentic/api-contract";
import { mapPool } from "@intentic/base/async";
import { isLockedWorkspacePath } from "@intentic/sandbox-contract";
import { explorerColorClass, type IconName, iconForEntry } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { basename, parentDir } from "@intentic/ui/path";
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { useLayout } from "../../../shell/window/useLayout";
import { explorerShows } from "../explorer/explorerFilter";
import { useWorkspaceTree } from "../explorer/useWorkspaceTree";
import { coverIn, coverIndex, coversBelow, coverSteps, typeaheadIndex } from "./homeCover";
import { useHome } from "./useHome";
import HomeCoverDocument from "./HomeCoverDocument.vue";

// Drawn by HomeView in place of its tiles while a cover is chosen. The folder and the current entry are the home's own
// (useHome), so the tree, the breadcrumb and this all move together; going in and out is HomeView's `go`, handed back
// through events, so a folder entered here is entered the way a tile's would be. The keys arrive from HomeView too,
// since they reach the home wherever its focus is.

const t = useT();

const { name, root, rootLabel } = defineProps<{
    name: string;
    // The scope's root and what the breadcrumb calls it, for naming a folder by where it is.
    root: string;
    rootLabel: string;
}>();

const emit = defineEmits<{ enter: [folder: string]; up: []; reveal: [folder: string]; exit: [] }>();

const { homeDir, selected } = useHome();
const { listingOf, keepListed, loadChildren, entriesByPath, entry: entryAt } = useWorkspaceTree();
const layout = useLayout();

const shows = (entry: WorkspaceTreeEntry): boolean => explorerShows(entry, layout.explorerFilters.value);
// What the sandbox keeps private is never listed or read, so it is neither a folder to step into nor a file to show:
// asking for one only raises the refusal the tiles never provoke.
const unlocked = (entry: WorkspaceTreeEntry): boolean => !isLockedWorkspacePath(entry.path);
const coverOf = (listing: readonly WorkspaceTreeEntry[]): WorkspaceTreeEntry | undefined => coverIn(listing.filter(unlocked), name);
// The glyph a row wears when it holds a cover: the file's own, in its own colour, so a column of folders reads at a glance.
const coverIcon = computed(() => iconForEntry(name, `file`));
const coverColor = computed(() => explorerColorClass(`colorful`, name, `file`, false));

// --- What the loaded tree knows of covers ------------------------------------------------------------------------
// Every folder from the scope's root down to `dir` is one the switches show: a cover behind a hidden folder is one
// this rail could never reach, so it is not offered as a place to go.
const reachable = (dir: string): boolean => {
    for (let path = dir; path !== root && path !== ``; path = parentDir(path)) {
        const folder = entryAt(path);
        if (folder !== undefined && !shows(folder)) {
            return false;
        }
    }
    return true;
};
// Counts nothing inside an ignored folder unless the reader shows those: node_modules alone is full of READMEs.
const known = computed(() => {
    const showIgnored = layout.explorerFilters.value.showIgnored;
    const files = [...entriesByPath.value.values()].filter((file) => file.type === `file` && (showIgnored || file.ignored !== true));
    return coverIndex(files, name, reachable);
});

// Whether a folder holds a cover of its own: its listing says, once there is one; the tree's index until then.
const holds = (path: string): boolean | undefined => {
    const listing = listingOf(path);
    if (listing !== undefined) {
        return coverOf(listing) !== undefined;
    }
    return known.value.held.has(path) ? true : undefined;
};

// --- The rows: the folder itself, then every folder a tile would enter ------------------------------------------------
interface CoverRow {
    readonly path: string;
    readonly label: string;
    // The open folder's own row; the rest are the folders in it.
    readonly self: boolean;
    readonly icon: IconName;
    readonly color: string;
    // Whether it holds a cover of its own: undefined until its listing or the tree's index can say.
    readonly holds: boolean | undefined;
    // How many folders below it hold one, as far as the loaded tree knows.
    readonly inside: number;
}

const steps = computed(() => coverSteps(listingOf(homeDir.value) ?? [], (entry) => shows(entry) && unlocked(entry)));
const hereLabel = computed(() => (homeDir.value === root ? rootLabel : basename(homeDir.value)));
const rowOf = (path: string, label: string, self: boolean, icon: IconName, color: string): CoverRow => ({
    path,
    label,
    self,
    icon,
    color,
    holds: holds(path),
    inside: known.value.below.get(path) ?? 0,
});
const rows = computed<readonly CoverRow[]>(() => [
    rowOf(homeDir.value, hereLabel.value, true, `folder-open`, explorerColorClass(`colorful`, hereLabel.value, `dir`, false)),
    ...steps.value.map((step) =>
        rowOf(step.path, step.name, false, iconForEntry(step.name, step.type), explorerColorClass(`colorful`, step.name, step.type, step.ignored)),
    ),
]);

// The selected row is the home's current entry when that is a folder listed here, else the folder itself: a tile or a
// tree row picked before the cover was chosen stays picked, and entering a folder lands on its own cover.
const at = computed(() => Math.max(0, rows.value.findIndex((row) => !row.self && row.path === selected.value)));
const current = computed(() => rows.value[at.value] ?? rows.value[0]!);
const selectRow = (index: number): void => {
    const row = rows.value[index];
    if (row === undefined) {
        return;
    }
    // The folder's own row is no entry of its own, the way entering a folder leaves it (HomeView's `go`).
    selected.value = row.self ? (homeDir.value === root ? undefined : homeDir.value) : row.path;
};

// The folders in view are listed ahead, a few at a time, so each row can say whether it holds a cover before it is
// picked. Bounded: a folder of a thousand folders asks for the first screenfuls, and any other one as it is picked.
const AHEAD = 48;
const AT_ONCE = 4;
watch(
    steps,
    (next) => {
        const unlisted = next.slice(0, AHEAD).filter((step) => listingOf(step.path) === undefined);
        void mapPool(unlisted, AT_ONCE, (step) => loadChildren(step.path));
    },
    { immediate: true },
);
keepListed(() => current.value.path);

// --- The cover beside the rail ----------------------------------------------------------------------------------------
const listed = computed(() => listingOf(current.value.path) !== undefined);
const coverEntry = computed(() => coverOf(listingOf(current.value.path) ?? []));
// Nearest first, named from the folder being read, so the list reads as the way down from here.
const BELOW = 6;
const below = computed(() =>
    coversBelow(known.value, current.value.path, BELOW).map((path) => ({
        path,
        label: current.value.path === `` ? path : path.slice(current.value.path.length + 1),
    })),
);
const where = computed(() => {
    const path = current.value.path;
    if (path === root) {
        return rootLabel;
    }
    return root === `` ? path : path.slice(root.length + 1);
});
const doc = ref<InstanceType<typeof HomeCoverDocument>>();

// --- Focus: the selected row holds it, so a key after a click or a move still lands here ------------------------------
const rail = ref<HTMLElement>();
const rowEl = (index: number): HTMLElement | undefined => rail.value?.querySelectorAll<HTMLElement>(`[role="option"]`)[index];
// After the rows have settled: a folder entered or left replaces them, and the selection with them.
const focusCurrent = async (): Promise<void> => {
    await nextTick();
    rowEl(at.value)?.focus();
};
// Choosing a cover is a gesture on the home, so the rail takes the keyboard straight away.
onMounted(() => void focusCurrent());

const pick = (index: number): void => {
    selectRow(index);
    void focusCurrent();
};
const enter = (row: CoverRow): void => {
    if (!row.self) {
        emit(`enter`, row.path);
    }
};

// --- Keys --------------------------------------------------------------------------------------------------------
// Typing jumps to a folder by name; a pause starts the next word, as a file browser's list does.
const TYPE_PAUSE_MS = 700;
let typed = ``;
let typedAt = 0;
const typeahead = (key: string): void => {
    const now = Date.now();
    typed = now - typedAt > TYPE_PAUSE_MS ? key : typed + key;
    typedAt = now;
    const found = typeaheadIndex(
        rows.value.map((row) => row.label),
        typed,
        at.value,
    );
    if (found !== -1) {
        pick(found);
    }
};

// Into the selected folder; the folder's own row has nowhere to go in to.
const goIn = (): void => enter(current.value);
// Every key the rail answers besides typing, and what it does: flip, go in and out, page through what is being read.
const KEYS = new Map<string, (event: KeyboardEvent) => void>([
    [`ArrowDown`, () => pick(Math.min(rows.value.length - 1, at.value + 1))],
    [`ArrowUp`, () => pick(Math.max(0, at.value - 1))],
    [`Home`, () => pick(0)],
    [`End`, () => pick(rows.value.length - 1)],
    [`ArrowRight`, goIn],
    // On the folder's own row Enter opens what is being read, the way Enter on a tile opens the tile.
    [`Enter`, () => (current.value.self ? doc.value?.open() : goIn())],
    [`ArrowLeft`, () => emit(`up`)],
    [`Backspace`, () => emit(`up`)],
    [`PageDown`, () => doc.value?.scrollPage(1)],
    [`PageUp`, () => doc.value?.scrollPage(-1)],
    [` `, (event) => doc.value?.scrollPage(event.shiftKey ? -1 : 1)],
    [`Escape`, () => emit(`exit`)],
]);

// A key on a control in the page (Open, a folder below, a link in the prose) is that control's to answer.
const onControl = (event: KeyboardEvent): boolean =>
    event.target instanceof Element && event.target.closest(`button, a[href], input, textarea, select, [contenteditable="true"]`) !== null;

// The keys the home hands over while it shows a cover; true for one it acted on. A chord is the app's (copy, a
// command), never a flip.
const onKey = (event: KeyboardEvent): boolean => {
    if (onControl(event) || event.ctrlKey || event.metaKey) {
        return false;
    }
    const act = KEYS.get(event.key);
    if (act !== undefined) {
        act(event);
        return true;
    }
    if (event.key.length === 1 && !event.altKey) {
        typeahead(event.key);
        return true;
    }
    return false;
};
// HomeView calls focusCurrent after a folder change it made itself; one made in the tree leaves the focus in the tree.
defineExpose({ onKey, focusCurrent });
</script>

<template>
    <div class="flex min-h-0 flex-1">
        <!-- The rail: the folder itself, then the folders in it. A row without a cover of its own is dimmed, and says how
             many folders below it hold one, since that is the reason to go into it. -->
        <div class="flex w-[clamp(10rem,30%,15rem)] shrink-0 flex-col border-r border-line">
            <div
                ref="rail"
                class="ui-softscroll min-h-0 flex-1 overflow-y-auto px-2 py-2"
                role="listbox"
                :aria-label="t(`workspace.homeCover.folders`, { here: hereLabel })"
            >
                <div
                    v-for="(row, index) in rows"
                    :key="row.self ? `self` : row.path"
                    role="option"
                    :aria-selected="index === at"
                    :tabindex="index === at ? 0 : -1"
                    class="ui-row-select flex h-7 items-center gap-2 rounded-md pr-2 text-xs select-none"
                    :class="[index === at ? `ui-row-select-on` : ``, row.self ? `pl-2 font-medium` : `pl-6`]"
                    @click="pick(index)"
                    @dblclick="enter(row)"
                >
                    <Icon :name="row.icon" class="shrink-0 text-sm" :class="row.color" aria-hidden="true" />
                    <span class="min-w-0 flex-1 truncate" :class="row.holds === false ? `text-subtle` : `text-content/90`">{{ row.label }}</span>
                    <!-- The file's own glyph where there is one to read: a dimmed name alone is too quiet to scan a column by. -->
                    <Icon
                        v-if="row.holds === true"
                        :name="coverIcon"
                        class="shrink-0 text-2xs"
                        :class="coverColor"
                        :title="t(`workspace.homeCover.holds`, { name })"
                        :aria-label="t(`workspace.homeCover.holds`, { name })"
                    />
                    <span
                        v-else-if="row.inside > 0"
                        class="shrink-0 text-2xs tabular-nums text-subtle"
                        :title="t(`workspace.homeCover.insideTitle`, { count: row.inside, name }, row.inside)"
                        >{{ t(`workspace.homeCover.inside`, { count: row.inside }) }}</span
                    >
                </div>
            </div>
            <p class="shrink-0 border-t border-line px-3 py-1.5 text-2xs text-subtle">{{ t(`workspace.homeCover.keys`) }}</p>
        </div>

        <HomeCoverDocument
            ref="doc"
            :folder="current.path"
            :where="where"
            :here="current.label"
            :name="name"
            :entry="coverEntry"
            :listed="listed"
            :below="below"
            @reveal="emit(`reveal`, $event)"
            @exit="emit(`exit`)"
        />
    </div>
</template>
