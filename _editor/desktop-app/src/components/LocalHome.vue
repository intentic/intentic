<script setup lang="ts">
import { Button, Icon, Row, RowGroup } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { onMounted, ref } from "vue";
import { localOpen, localOpenPath, localRecents, type LocalRecent } from "../desktop";

// The first thing this card offers: a folder or a document of this computer, opened in a window of its own with the
// editor's own views (src-tauri/src/local.rs). Nothing here needs a sandbox, an account or Docker, so it stands
// above everything that does. A folder or a file dropped on the card opens the same way.

const t = useT();
const recents = ref<LocalRecent[]>([]);
const failure = ref<string | undefined>(undefined);

const reload = async (): Promise<void> => {
    recents.value = await localRecents();
};
onMounted(() => void reload());

// The recent path as the reader recognises it: its own name, with the folder it is in beside it.
const nameOf = (path: string): string => path.split(/[\\/]/).findLast((part) => part !== ``) ?? path;
const whereOf = (path: string): string => path.slice(0, Math.max(0, path.length - nameOf(path).length)).replace(/[\\/]$/, ``);

const reopen = async (path: string): Promise<void> => {
    failure.value = undefined;
    try {
        await localOpenPath(path);
    } catch (error) {
        failure.value = String(error);
    }
    await reload();
};
</script>

<template>
    <RowGroup :label="t(`desktop.localHome.title`)">
        <Row :title="t(`desktop.localHome.lead`)">
            <template #control>
                <Button size="small" severity="secondary" :label="t(`desktop.localHome.openFolder`)" @click="localOpen(true)" />
                <Button size="small" severity="secondary" :text="true" :label="t(`desktop.localHome.openFile`)" @click="localOpen(false)" />
            </template>
        </Row>
        <Row v-for="recent in recents.slice(0, 5)" :key="recent.path" as="button" :title="nameOf(recent.path)" @click="reopen(recent.path)">
            <template #lead>
                <Icon :name="recent.folder ? `folder` : `file`" class="text-sm text-muted" />
            </template>
            <template #description>{{ whereOf(recent.path) }}</template>
        </Row>
        <p v-if="failure" class="px-3 py-1 text-2xs text-danger">{{ failure }}</p>
    </RowGroup>
</template>
