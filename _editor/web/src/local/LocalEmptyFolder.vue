<script setup lang="ts">
import { Button, Notice } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { ref } from "vue";
import { askLocalApp, localFace } from "../app/environments/local";
import { localHost } from "../app/environments/localHost";

// WHAT AN EMPTY FOLDER SAYS, in the pane its documents would open in: first of all the folder the app starts in
// (`~/intentic/local`), which is empty on every first launch. It says what the folder is and the ways to fill it, and
// offers the folder the reader already has instead. Nothing about sandboxes or agents: the rail's foot has that.

const t = useT();
const face = localFace();
const host = localHost();

const failure = ref<string | undefined>(undefined);
const pickFolder = async (): Promise<void> => {
    failure.value = undefined;
    try {
        await host.pickFolder();
    } catch (error) {
        failure.value = error instanceof Error ? error.message : String(error);
    }
};
</script>

<template>
    <div class="flex h-full flex-col items-center justify-center gap-5 px-6 text-center">
        <span class="flex h-12 w-12 items-center justify-center rounded-2xl bg-primary-600/10 text-link">
            <Icon name="folder-open" class="text-2xl" />
        </span>
        <div class="flex max-w-md flex-col gap-1.5">
            <p class="text-base font-semibold text-content">{{ t(`local.emptyFolder.title`) }}</p>
            <p class="text-xs text-muted">{{ t(`local.emptyFolder.lead`, { name: face?.name ?? `` }) }}</p>
            <p v-if="face" class="truncate font-mono text-2xs text-subtle" v-tooltip.bottom="face.path">{{ face.path }}</p>
        </div>
        <div class="flex flex-wrap items-center justify-center gap-2">
            <Button :label="t(`local.emptyFolder.openFolder`)" size="small" @click="pickFolder">
                <template #icon><Icon name="folder-open" /></template>
            </Button>
            <Button :label="t(`local.emptyFolder.showInFileManager`)" size="small" severity="secondary" @click="askLocalApp(`reveal`)">
                <template #icon><Icon name="external-link" /></template>
            </Button>
        </div>
        <Notice v-if="failure" tone="danger" class="max-w-md text-2xs">{{ failure }}</Notice>
    </div>
</template>
