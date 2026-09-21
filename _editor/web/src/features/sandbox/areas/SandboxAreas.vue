<script setup lang="ts">
import { type Area, isSandboxPath } from "@intentic/sandbox-contract";
import {
    Button,
    ConfirmDialog,
    DisclosureRow,
    InlineRename,
    Notice,
    type NoticeModel,
    RowGroup,
    RowNote,
    SkeletonRows,
    StatusBadge,
    ui,
} from "@intentic/ui";
import { noticeFrom } from "@intentic/ui/async";
import { useT } from "@intentic/ui/i18n";
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import FolderPicker from "../devices/FolderPicker.vue";
import { useSandbox } from "../client/useSandbox";
import { useSandboxOutline } from "../overview/useSandboxOutline";
import { usePersonaReach } from "../access/usePersonaReach";
import { useAreas } from "./useAreas";

// The named parts of the workspace, and the folders behind each. This is where "who sees what" is decided: the
// Access tab hands a person an area by name, and this page is the only thing that says what that name means.
// It is also where "who talks to whom" is decided, since an assistant belongs to the area its starting folder is in
// and anyone holding that area may speak through it — so each row names the assistants it hands over.
// Owner-only to write, like the roster itself, since editing an area moves everyone holding it at once.
// Shaped like the personas list: the row IS the disclosure, an open one writes as it changes, and what an area is for
// is said in the empty state, where somebody is deciding whether to make one.

const t = useT();
const sandbox = useSandbox();
const isOwner = computed(() => sandbox.active.value?.role === `owner`);

const { areas, error, isLoading, save, remove } = useAreas();
const outline = useSandboxOutline(isLoading);

// The two things no row can say for itself: the list wouldn't read, or a delete came back refused.
const pageError = ref<NoticeModel>();
const pageNotice = computed<NoticeModel | undefined>(
    () =>
        pageError.value ??
        (error.value === undefined ? undefined : { tone: `danger`, title: t(`sandbox.sandboxAreas.couldntReadAreas`), detail: error.value }),
);

interface AreaDraft {
    /** The id it was saved under. A grant points at the id, so a rename moves the name and never this. */
    readonly original: string;
    label: string;
    folders: string[];
    brief: string;
}

// One open row at a time, edited in place and written as it changes: there is no Save button anywhere else in these
// settings, and one here would be the only thing a reader had to remember.
const draft = ref<AreaDraft>();
const saveError = ref<NoticeModel>();

const draftOf = (area: Area): AreaDraft => ({
    original: area.id,
    label: area.label ?? area.id,
    folders: [...area.folders],
    brief: area.brief ?? ``,
});

// Marks a draft change as not-an-edit (opening a row, or writing back a committed rename), so the autosave watcher
// doesn't fire a write nobody asked for.
let settling = false;
const quietly = (mutate: () => void): void => {
    settling = true;
    mutate();
    void nextTick(() => {
        settling = false;
    });
};

const isOpen = (area: Area): boolean => draft.value?.original === area.id;
const toggleOpen = (area: Area): void => {
    saveError.value = undefined;
    if (isOpen(area)) {
        draft.value = undefined;
        return;
    }
    quietly(() => {
        draft.value = draftOf(area);
    });
};

// Stores only what says something the id doesn't: a label that repeats it, or a blank line, is stored as absent.
const areaFrom = (state: AreaDraft): Area => ({
    id: state.original,
    ...(state.label.trim() !== `` && state.label.trim() !== state.original ? { label: state.label.trim() } : {}),
    ...(state.brief.trim() !== `` ? { brief: state.brief.trim() } : {}),
    folders: [...state.folders],
});

// Long enough to coalesce one decision (two folders picked, a line typed), short enough that the spinner has cleared
// before attention moves on.
const WRITE_DELAY_MS = 400;
let pending: ReturnType<typeof setTimeout> | undefined;

const persist = async (): Promise<void> => {
    const state = draft.value;
    // An area holding no folder is a grant with no reader, which the daemon refuses: the drawer holds the write and
    // says what it is still waiting for instead of sending one to be turned down.
    if (state === undefined || state.folders.length === 0) {
        return;
    }
    saveError.value = undefined;
    try {
        await save.mutateAsync(areaFrom(state));
    } catch (err) {
        saveError.value = noticeFrom(err, t(`sandbox.sandboxAreas.couldNotSave`));
    }
};

watch(
    draft,
    () => {
        if (settling || draft.value === undefined) {
            return;
        }
        clearTimeout(pending);
        pending = setTimeout(() => void persist(), WRITE_DELAY_MS);
    },
    { deep: true },
);
onBeforeUnmount(() => clearTimeout(pending));

// Writes the whole area (an upsert), reading from the open draft when there is one so a rename can't clobber a folder
// picked a moment ago. The edit state is the row's own, inside <InlineRename>; this is only where the name goes.
const renameOf =
    (area: Area) =>
    async (name: string): Promise<void> => {
        const open = draft.value?.original === area.id ? draft.value : undefined;
        await save.mutateAsync(open === undefined ? { ...area, label: name } : { ...areaFrom(open), label: name });
        if (open !== undefined) {
            quietly(() => {
                open.label = name;
            });
        }
    };

// Making one. Unlike a persona, an area cannot be written on its name alone — one holding no folder is the grant the
// daemon refuses — so the folders are named here, before the row exists.
const newName = ref<string>();
const newFolders = ref<string[]>([]);
const adding = computed(() => newName.value !== undefined);
const submitting = ref(false);

const startAdd = (): void => {
    saveError.value = undefined;
    draft.value = undefined;
    newFolders.value = [];
    newName.value = ``;
};
const cancelAdd = (): void => {
    newName.value = undefined;
    newFolders.value = [];
    saveError.value = undefined;
};

// Folded from the name once, at creation, and never again: this is what every grant points at.
const slug = (name: string): string =>
    name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, `-`)
        .replace(/^-+|-+$/g, ``)
        .slice(0, 60);
const newId = computed(() => slug(newName.value ?? ``));
// A new area can't land on an id already taken; saving would silently edit the other one.
const taken = computed(() => areas.value.some((area) => area.id === newId.value));
const newValid = computed(() => newId.value !== `` && !taken.value && newFolders.value.length > 0);
// One line under the form, saying the one thing still missing; silent until a name has been typed, since a block that
// opens already complaining reads as a failure rather than a form.
const newHint = computed(() => {
    if (newName.value === undefined || newName.value === ``) {
        return undefined;
    }
    if (newId.value === ``) {
        return t(`sandbox.sandboxAreas.useLettersOrDigits`);
    }
    if (taken.value) {
        return t(`sandbox.sandboxAreas.nameTaken`, { id: newId.value });
    }
    return newFolders.value.length === 0 ? t(`sandbox.sandboxAreas.needsFolder`) : undefined;
});

const submit = async (): Promise<void> => {
    // `taken` only sees areas already fetched, so without this the id being written right now still reads as free.
    if (!newValid.value || submitting.value) {
        return;
    }
    const id = newId.value;
    const label = (newName.value ?? ``).trim();
    const area: Area = { id, ...(label !== id ? { label } : {}), folders: [...newFolders.value] };
    saveError.value = undefined;
    submitting.value = true;
    try {
        await save.mutateAsync(area);
        newName.value = undefined;
        newFolders.value = [];
        // Named it, now say what it is: the new row opens on itself, since making one and describing it are one errand.
        quietly(() => {
            draft.value = draftOf(area);
        });
    } catch (err) {
        saveError.value = noticeFrom(err, t(`sandbox.sandboxAreas.couldNotSave`));
    } finally {
        submitting.value = false;
    }
};

const removing = ref<Area>();
const confirmRemove = async (): Promise<void> => {
    const area = removing.value;
    if (area === undefined) {
        return;
    }
    pageError.value = undefined;
    try {
        await remove.mutateAsync(area.id);
        if (draft.value?.original === area.id) {
            draft.value = undefined;
        }
    } catch (err) {
        // The daemon refuses an area somebody still holds and names them; that sentence is the whole answer.
        pageError.value = noticeFrom(err, t(`sandbox.sandboxAreas.couldNotDelete`));
    } finally {
        removing.value = undefined;
    }
};

// The paths while a glance can still read them, a count past that: the row says which area this is, not the manifest.
const NAMED_FOLDERS = 3;
const folderLine = (area: Area): string =>
    area.folders.length > NAMED_FOLDERS
        ? t(`sandbox.sandboxAreas.folderCount`, { count: area.folders.length }, area.folders.length)
        : area.folders.join(`, `);

// The assistants this area hands over: those whose starting folder it covers. Derived, never configured — the same
// answer the daemon gives a member asking which cards they may wear (personas/persona-reach.ts).
const { namesOf } = usePersonaReach();
const assistantsIn = (area: Area): string[] => namesOf([area.id]);
</script>

<template>
    <div>
        <Notice v-if="pageNotice" :of="pageNotice" class="mb-4" />

        <!-- The empty state must not show before we know whether areas exist; the list's shape stands in while loading. -->
        <template v-if="isLoading">
            <RowGroup v-if="outline" :label="t(`sandbox.sandboxAreas.areas`)">
                <div role="status" aria-busy="true">
                    <span class="sr-only">{{ t(`sandbox.sandboxAreas.readingAreas`) }}</span>
                    <SkeletonRows :rows="2" description control />
                </div>
            </RowGroup>
        </template>

        <template v-else>
            <!-- No area is a finished answer, not a half-set-up sandbox: it means everyone sees everything. -->
            <div v-if="areas.length === 0 && !adding" :class="ui.emptyState('flex flex-col items-center gap-3 py-8')">
                <Icon name="folder-open" class="text-xl text-subtle" />
                <div class="flex flex-col gap-1">
                    <span class="text-sm font-medium text-content">{{ t(`sandbox.sandboxAreas.everyoneSeesWhole`) }}</span>
                    <span class="max-w-md text-xs text-muted">{{ t(`sandbox.sandboxAreas.whatAnAreaIs`) }}</span>
                </div>
                <Button v-if="isOwner" :label="t(`sandbox.sandboxAreas.newArea`)" size="small" @click="startAdd">
                    <template #icon><Icon name="plus" /></template>
                </Button>
                <span v-else class="text-xs text-subtle">{{ t(`sandbox.sandboxAreas.onlyOwnerEdits`) }}</span>
            </div>

            <RowGroup v-else :label="t(`sandbox.sandboxAreas.areas`)" :caption="t(`sandbox.sandboxAreas.grantedOnAccess`)">
                <template #actions>
                    <Button v-if="isOwner && !adding" :label="t(`sandbox.sandboxAreas.newArea`)" size="small" severity="secondary" @click="startAdd">
                        <template #icon><Icon name="plus" /></template>
                    </Button>
                </template>

                <!-- The row is the disclosure: no Edit button, and no second copy of the area under the one it edits. -->
                <DisclosureRow
                    v-for="area in areas"
                    :key="area.id"
                    hit="pair"
                    body="drawer"
                    icon="folder"
                    :disabled="!isOwner"
                    :open="isOpen(area)"
                    @update:open="toggleOpen(area)"
                >
                    <!-- The row's name renames itself, in the same box and type; the row never opens on that press. -->
                    <template #title>
                        <div class="flex min-w-0 flex-col">
                            <InlineRename
                                :value="area.label ?? area.id"
                                :write="renameOf(area)"
                                :editable="isOwner"
                                :label="t(`sandbox.sandboxAreas.areaName`)"
                                :action="t(`sandbox.sandboxAreas.renameArea`)"
                                :failure="t(`sandbox.sandboxAreas.couldntRename`)"
                                class="font-medium"
                            />
                            <!-- Not while open: it would sit above the field being typed into, showing the saved line. -->
                            <span v-if="area.brief !== undefined && !isOpen(area)" class="truncate px-1 text-2xs text-muted">{{ area.brief }}</span>
                        </div>
                    </template>

                    <!-- What the name means: the folders it stands for, and who holding it hands over. -->
                    <template #meta>
                        <!-- Never while open, where the picker below holds the draft of it. -->
                        <StatusBadge v-if="!isOpen(area)" variant="neutral" size="xs">{{ folderLine(area) }}</StatusBadge>
                        <!-- Derived from the folders and editable nowhere, so it stands while the row is open. No badge
                             at all means holding this area grants no assistant: fine for a viewer or a writer, and the
                             whole of what a guest would get. -->

                        <StatusBadge v-for="name in assistantsIn(area)" :key="name" variant="info" :label="name" size="xs" />
                    </template>

                    <template v-if="isOwner" #control>
                        <!-- Only while the write is in flight: a lingering tick is one more thing to read on every row. -->
                        <Icon v-if="isOpen(area) && save.isPending.value" name="spinner" spin class="text-2xs text-subtle" />
                        <button
                            type="button"
                            :class="ui.iconButton('hover:text-danger')"
                            :aria-label="t(`sandbox.sandboxAreas.deleteArea`)"
                            @click.stop="removing = area"
                        >
                            <Icon name="trash" class="text-xs" />
                        </button>
                    </template>

                    <template #below>
                        <div v-if="draft !== undefined" class="flex max-w-2xl flex-col gap-4">
                            <div class="ui-field">
                                <span class="ui-field-label">{{ t(`sandbox.sandboxAreas.folders`) }}</span>
                                <FolderPicker
                                    v-model="draft.folders"
                                    multiple
                                    :excludes="isSandboxPath"
                                    :label="t(`sandbox.sandboxAreas.folders`)"
                                    :placeholder="t(`sandbox.sandboxAreas.pickFolders`)"
                                />
                                <span v-if="draft.folders.length === 0" class="ui-field-error">{{ t(`sandbox.sandboxAreas.needsFolder`) }}</span>
                            </div>

                            <!-- The line whoever grants this area reads on the Access tab, written where the area is. -->
                            <div class="ui-field">
                                <label class="ui-field-label" :for="`area-brief-${area.id}`">{{ t(`sandbox.sandboxAreas.whatItIs`) }}</label>
                                <input
                                    :id="`area-brief-${area.id}`"
                                    v-model="draft.brief"
                                    :class="ui.input()"
                                    maxlength="200"
                                    :placeholder="t(`sandbox.sandboxAreas.briefPlaceholder`)"
                                />
                            </div>

                            <Notice v-if="saveError" :of="saveError" />
                        </div>
                    </template>
                </DisclosureRow>

                <!-- Creation asks for both halves at once, since neither is optional. -->
                <RowNote v-if="adding" variant="block">
                    <div class="flex flex-col gap-2">
                        <div class="flex flex-wrap items-center gap-2">
                            <input
                                v-model="newName"
                                :class="ui.input('min-w-0 max-w-xs flex-1 font-medium')"
                                :placeholder="t(`sandbox.sandboxAreas.nameIt`)"
                                :aria-label="t(`sandbox.sandboxAreas.areaName`)"
                                autofocus
                                @keyup.enter="submit"
                            />
                            <Button :label="t(`ui.action.create`)" size="small" :loading="submitting" :disabled="!newValid" @click="submit" />
                            <button type="button" :class="ui.linkButton('text-xs text-muted hover:text-content')" @click="cancelAdd">
                                {{ t(`ui.action.cancel`) }}
                            </button>
                        </div>
                        <FolderPicker
                            v-model="newFolders"
                            multiple
                            :excludes="isSandboxPath"
                            :label="t(`sandbox.sandboxAreas.folders`)"
                            :placeholder="t(`sandbox.sandboxAreas.pickFolders`)"
                        />
                        <span v-if="newHint !== undefined" class="text-xs text-warning">{{ newHint }}</span>
                        <span v-else class="text-xs text-subtle">{{ t(`sandbox.sandboxAreas.seesTheseFolders`) }}</span>
                        <Notice v-if="saveError" :of="saveError" />
                    </div>
                </RowNote>

                <RowNote v-if="!isOwner">{{ t(`sandbox.sandboxAreas.onlyOwnerEdits`) }}</RowNote>
            </RowGroup>
        </template>

        <!-- Deleting an area takes the grant away, never the folders, and the daemon refuses while somebody holds it. -->
        <ConfirmDialog
            :open="removing !== undefined"
            :header="t(`sandbox.sandboxAreas.deleteHeader`, { label: removing?.label ?? removing?.id })"
            :confirm-label="t(`sandbox.sandboxAreas.deleteArea`)"
            confirm-icon="trash"
            :loading="remove.isPending.value"
            @cancel="removing = undefined"
            @confirm="confirmRemove"
        >
            {{ t(`sandbox.sandboxAreas.deleteBody`) }}
        </ConfirmDialog>
    </div>
</template>
