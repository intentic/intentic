<script setup lang="ts">
import type { Slice } from "@intentic/sandbox-contract";
import { Button, Notice, type NoticeModel, Row, RowGroup, RowNote, SkeletonRows, StatusBadge, ui } from "@intentic/ui";
import { noticeFrom } from "@intentic/ui/async";
import { useT } from "@intentic/ui/i18n";
import { computed, ref } from "vue";
import FolderPicker from "../devices/FolderPicker.vue";
import { useSandbox } from "../client/useSandbox";
import { useSandboxOutline } from "../overview/useSandboxOutline";
import { useSlices } from "./useSlices";

// The named parts of the workspace, and the folders behind each. This is where "who sees what" is decided: the
// Access tab hands a person a slice by name, and this page is the only thing that says what that name means.
// Owner-only to write, like the roster itself, since editing a slice moves everyone holding it at once.

const t = useT();
const sandbox = useSandbox();
const isOwner = computed(() => sandbox.active.value?.role === `owner`);

const { slices, isLoading, save, remove } = useSlices();
const outline = useSandboxOutline(isLoading);
const notice = ref<NoticeModel>();

// One open slice at a time, edited in place and written on change, like a persona card: there is no Save button
// anywhere else in these settings, and one here would be the only thing a reader had to remember.
const open = ref<string>();
const draftName = ref(``);
const draftFolders = ref<string[]>([]);

const edit = (slice: Slice): void => {
    open.value = slice.id;
    draftName.value = slice.label ?? slice.id;
    draftFolders.value = [...slice.folders];
    notice.value = undefined;
};

// `slice-` keeps the id inside the manifest id alphabet whatever the name is; a name that folds to nothing gets a
// timestamp rather than an empty id, which the daemon would refuse.
const idFor = (name: string): string => {
    const folded = name
        .toLowerCase()
        .replaceAll(/[^a-z0-9_-]+/g, `-`)
        .replace(/^-+|-+$/g, ``);
    return (folded === `` ? `slice-${Date.now()}` : folded).slice(0, 60);
};

const write = async (id: string): Promise<void> => {
    // A slice with no folder is a grant with no reader; the daemon refuses it, and so does the page, with the
    // reason rather than the refusal.
    if (draftFolders.value.length === 0) {
        notice.value = { tone: `warning`, title: t(`sandbox.sandboxSlices.needsFolder`) };
        return;
    }
    notice.value = undefined;
    try {
        await save.mutateAsync({ id, label: draftName.value.trim() === `` ? id : draftName.value.trim(), folders: [...draftFolders.value] });
    } catch (err) {
        notice.value = noticeFrom(err, t(`sandbox.sandboxSlices.couldNotSave`));
    }
};

const add = async (): Promise<void> => {
    const id = idFor(t(`sandbox.sandboxSlices.newSliceName`));
    draftName.value = t(`sandbox.sandboxSlices.newSliceName`);
    draftFolders.value = [];
    open.value = id;
    notice.value = { tone: `info`, title: t(`sandbox.sandboxSlices.pickFoldersToFinish`) };
};

const drop = async (id: string): Promise<void> => {
    notice.value = undefined;
    try {
        await remove.mutateAsync(id);
        if (open.value === id) {
            open.value = undefined;
        }
    } catch (err) {
        // The daemon refuses a slice somebody still holds and names them; that sentence is the whole answer.
        notice.value = noticeFrom(err, t(`sandbox.sandboxSlices.couldNotDelete`));
    }
};

const folderLine = (slice: Slice): string => slice.folders.join(`, `);
</script>

<template>
    <div class="flex flex-col gap-6">
        <RowGroup :label="t(`sandbox.sandboxSlices.slices`)">
            <RowNote>{{ t(`sandbox.sandboxSlices.whatASliceIs`) }}</RowNote>
            <Notice v-if="notice" :of="notice" />

            <div v-if="isLoading" role="status" aria-busy="true"><SkeletonRows v-if="outline" :rows="2" control /></div>
            <RowNote v-else-if="slices.length === 0 && open === undefined" variant="empty">{{ t(`sandbox.sandboxSlices.noSlicesYet`) }}</RowNote>

            <template v-for="slice in slices" :key="slice.id">
                <Row icon="folder" :title="slice.label ?? slice.id" :description="folderLine(slice)">
                    <template #meta>
                        <StatusBadge variant="neutral" :label="slice.id" size="xs" />
                    </template>
                    <template v-if="isOwner" #control>
                        <Button
                            :label="open === slice.id ? t(`ui.action.done`) : t(`ui.action.edit`)"
                            size="small"
                            severity="secondary"
                            :text="true"
                            @click="open === slice.id ? (open = undefined) : edit(slice)"
                        />
                        <Button
                            size="small"
                            severity="danger"
                            :text="true"
                            :aria-label="t(`sandbox.sandboxSlices.deleteSlice`)"
                            @click="drop(slice.id)"
                        >
                            <template #icon><Icon name="times" /></template>
                        </Button>
                    </template>
                </Row>
                <RowNote v-if="open === slice.id" variant="block">
                    <div class="flex flex-col gap-2">
                        <input v-model="draftName" :class="ui.inputSm('w-full')" :aria-label="t(`sandbox.sandboxSlices.sliceName`)" />
                        <FolderPicker
                            v-model="draftFolders"
                            multiple
                            :label="t(`sandbox.sandboxSlices.folders`)"
                            :placeholder="t(`sandbox.sandboxSlices.pickFolders`)"
                        />
                        <Button :label="t(`ui.action.save`)" size="small" :loading="save.isPending.value" @click="write(slice.id)" />
                    </div>
                </RowNote>
            </template>

            <!-- A slice being made: it has no row above until its first write, since an id nobody chose folders for
                 would be a grant admitting nothing. -->
            <RowNote v-if="isOwner && open !== undefined && !slices.some((slice) => slice.id === open)" variant="block">
                <div class="flex flex-col gap-2">
                    <input v-model="draftName" :class="ui.inputSm('w-full')" :aria-label="t(`sandbox.sandboxSlices.sliceName`)" />
                    <FolderPicker
                        v-model="draftFolders"
                        multiple
                        :label="t(`sandbox.sandboxSlices.folders`)"
                        :placeholder="t(`sandbox.sandboxSlices.pickFolders`)"
                    />
                    <Button :label="t(`ui.action.save`)" size="small" :loading="save.isPending.value" @click="write(idFor(draftName))" />
                </div>
            </RowNote>

            <RowNote v-if="isOwner" variant="block">
                <Button :label="t(`sandbox.sandboxSlices.newSlice`)" size="small" severity="secondary" @click="add">
                    <template #icon><Icon name="plus" /></template>
                </Button>
            </RowNote>
            <RowNote v-else>{{ t(`sandbox.sandboxSlices.onlyOwnerEdits`) }}</RowNote>
        </RowGroup>
    </div>
</template>
