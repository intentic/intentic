<script setup lang="ts">
import { isFolder } from "../../../models/workspace/changes/scratchFolders";
import type { ScratchPath } from "@intentic/sandbox-contract/schemas/git/git";
import { Button } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { folderLine } from "./scratchWords";

// The untracked paths one repository's every stage-everything leaves out, so Commit all does too. A file is named in
// the note's line; a folder, which can stand for thousands of files, is one row of its own with its size, its reason
// and the press that deletes it (the panel's confirm card asks first).

const t = useT();
const props = defineProps<{
    scratch: readonly ScratchPath[];
    // A discard is running here, or another git action: the Delete presses wait for it.
    busy: boolean;
}>();
defineEmits<{ delete: [entry: ScratchPath] }>();

const files = computed(() => props.scratch.filter((entry) => !isFolder(entry)));
const folders = computed(() => props.scratch.filter(isFolder));
</script>

<template>
    <div class="mx-1 mb-1.5 mt-0.5 flex flex-col gap-1.5 rounded-md border border-border bg-overlay px-2 py-1.5">
        <div class="flex items-start gap-1.5">
            <span class="flex h-4 w-2.5 shrink-0 items-center justify-center"><Icon name="filter" class="text-2xs text-subtle" /></span>
            <div class="min-w-0 flex-1">
                <p class="text-2xs font-medium text-content">
                    {{ t(`workspace.reviewPanel.scratchLeftOut`, { count: scratch.length }, scratch.length) }}
                </p>
                <p v-if="files.length > 0" class="break-all font-mono text-2xs text-muted">{{ files.map((entry) => entry.path).join(`, `) }}</p>
                <p class="text-2xs text-subtle">{{ t(`workspace.reviewPanel.scratchLeftOutHint`) }}</p>
            </div>
        </div>
        <div v-for="entry in folders" :key="entry.path" class="flex items-center gap-1.5">
            <span class="flex w-2.5 shrink-0 items-center justify-center"><Icon name="folder" class="text-2xs text-subtle" /></span>
            <div class="min-w-0 flex-1">
                <p class="truncate font-mono text-2xs text-content" dir="rtl" v-tooltip.top.overflow="entry.path"><bdi>{{ entry.path }}</bdi></p>
                <p class="truncate text-2xs text-muted" v-tooltip.top.overflow="folderLine(entry)">{{ folderLine(entry) }}</p>
            </div>
            <Button
                size="small"
                tier="boring"
                tone="danger"
                class="shrink-0"
                :disabled="busy"
                :aria-label="t(`workspace.scratchFolder.deleteLabel`, { path: entry.path })"
                @click="$emit('delete', entry)"
            >
                {{ t(`workspace.scratchFolder.delete`) }}
            </Button>
        </div>
    </div>
</template>
