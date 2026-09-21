<script setup lang="ts">
import type { Area } from "@intentic/sandbox-contract";
import { Button, Notice, type NoticeModel, Row, RowGroup, RowNote, SkeletonRows, StatusBadge, ui } from "@intentic/ui";
import { noticeFrom } from "@intentic/ui/async";
import { useT } from "@intentic/ui/i18n";
import { computed, ref } from "vue";
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

const t = useT();
const sandbox = useSandbox();
const isOwner = computed(() => sandbox.active.value?.role === `owner`);

const { areas, isLoading, save, remove } = useAreas();
const outline = useSandboxOutline(isLoading);
const notice = ref<NoticeModel>();

// One open area at a time, edited in place and written on change, like a persona: there is no Save button
// anywhere else in these settings, and one here would be the only thing a reader had to remember.
const open = ref<string>();
const draftName = ref(``);
const draftFolders = ref<string[]>([]);

const edit = (area: Area): void => {
    open.value = area.id;
    draftName.value = area.label ?? area.id;
    draftFolders.value = [...area.folders];
    notice.value = undefined;
};

// `area-` keeps the id inside the manifest id alphabet whatever the name is; a name that folds to nothing gets a
// timestamp rather than an empty id, which the daemon would refuse.
const idFor = (name: string): string => {
    const folded = name
        .toLowerCase()
        .replaceAll(/[^a-z0-9_-]+/g, `-`)
        .replace(/^-+|-+$/g, ``);
    return (folded === `` ? `area-${Date.now()}` : folded).slice(0, 60);
};

const write = async (id: string): Promise<void> => {
    // An area with no folder is a grant with no reader; the daemon refuses it, and so does the page, with the
    // reason rather than the refusal.
    if (draftFolders.value.length === 0) {
        notice.value = { tone: `warning`, title: t(`sandbox.sandboxAreas.needsFolder`) };
        return;
    }
    notice.value = undefined;
    try {
        await save.mutateAsync({ id, label: draftName.value.trim() === `` ? id : draftName.value.trim(), folders: [...draftFolders.value] });
    } catch (err) {
        notice.value = noticeFrom(err, t(`sandbox.sandboxAreas.couldNotSave`));
    }
};

const add = async (): Promise<void> => {
    const id = idFor(t(`sandbox.sandboxAreas.newAreaName`));
    draftName.value = t(`sandbox.sandboxAreas.newAreaName`);
    draftFolders.value = [];
    open.value = id;
    notice.value = { tone: `info`, title: t(`sandbox.sandboxAreas.pickFoldersToFinish`) };
};

const drop = async (id: string): Promise<void> => {
    notice.value = undefined;
    try {
        await remove.mutateAsync(id);
        if (open.value === id) {
            open.value = undefined;
        }
    } catch (err) {
        // The daemon refuses an area somebody still holds and names them; that sentence is the whole answer.
        notice.value = noticeFrom(err, t(`sandbox.sandboxAreas.couldNotDelete`));
    }
};

const folderLine = (area: Area): string => area.folders.join(`, `);

// The assistants this area hands over: those whose starting folder it covers. Derived, never configured — the same
// answer the daemon gives a member asking which cards they may wear (personas/persona-reach.ts).
const { namesOf } = usePersonaReach();
const assistantsIn = (area: Area): string[] => namesOf([area.id]);
</script>

<template>
    <div class="flex flex-col gap-6">
        <RowGroup :label="t(`sandbox.sandboxAreas.areas`)">
            <RowNote>{{ t(`sandbox.sandboxAreas.whatAnAreaIs`) }}</RowNote>
            <Notice v-if="notice" :of="notice" />

            <div v-if="isLoading" role="status" aria-busy="true"><SkeletonRows v-if="outline" :rows="2" control /></div>
            <RowNote v-else-if="areas.length === 0 && open === undefined" variant="empty">{{ t(`sandbox.sandboxAreas.noAreasYet`) }}</RowNote>

            <template v-for="area in areas" :key="area.id">
                <Row icon="folder" :title="area.label ?? area.id" :description="folderLine(area)">
                    <template #meta>
                        <StatusBadge variant="neutral" :label="area.id" size="xs" />
                        <!-- Who this area hands over. No badge at all means holding it grants no assistant, which is
                             fine for a viewer or a writer and is the whole of what a desk would get. -->
                        <StatusBadge v-for="name in assistantsIn(area)" :key="name" variant="info" :label="name" size="xs" />
                    </template>
                    <template v-if="isOwner" #control>
                        <Button
                            :label="open === area.id ? t(`ui.action.done`) : t(`ui.action.edit`)"
                            size="small"
                            severity="secondary"
                            :text="true"
                            @click="open === area.id ? (open = undefined) : edit(area)"
                        />
                        <Button
                            size="small"
                            severity="danger"
                            :text="true"
                            :aria-label="t(`sandbox.sandboxAreas.deleteArea`)"
                            @click="drop(area.id)"
                        >
                            <template #icon><Icon name="times" /></template>
                        </Button>
                    </template>
                </Row>
                <RowNote v-if="open === area.id" variant="block">
                    <div class="flex flex-col gap-2">
                        <input v-model="draftName" :class="ui.inputSm('w-full')" :aria-label="t(`sandbox.sandboxAreas.areaName`)" />
                        <FolderPicker
                            v-model="draftFolders"
                            multiple
                            :label="t(`sandbox.sandboxAreas.folders`)"
                            :placeholder="t(`sandbox.sandboxAreas.pickFolders`)"
                        />
                        <Button :label="t(`ui.action.save`)" size="small" :loading="save.isPending.value" @click="write(area.id)" />
                    </div>
                </RowNote>
            </template>

            <!-- An area being made: it has no row above until its first write, since an id nobody chose folders for
                 would be a grant admitting nothing. -->
            <RowNote v-if="isOwner && open !== undefined && !areas.some((area) => area.id === open)" variant="block">
                <div class="flex flex-col gap-2">
                    <input v-model="draftName" :class="ui.inputSm('w-full')" :aria-label="t(`sandbox.sandboxAreas.areaName`)" />
                    <FolderPicker
                        v-model="draftFolders"
                        multiple
                        :label="t(`sandbox.sandboxAreas.folders`)"
                        :placeholder="t(`sandbox.sandboxAreas.pickFolders`)"
                    />
                    <Button :label="t(`ui.action.save`)" size="small" :loading="save.isPending.value" @click="write(idFor(draftName))" />
                </div>
            </RowNote>

            <RowNote v-if="isOwner" variant="block">
                <Button :label="t(`sandbox.sandboxAreas.newArea`)" size="small" severity="secondary" @click="add">
                    <template #icon><Icon name="plus" /></template>
                </Button>
            </RowNote>
            <RowNote v-else>{{ t(`sandbox.sandboxAreas.onlyOwnerEdits`) }}</RowNote>
        </RowGroup>
    </div>
</template>
