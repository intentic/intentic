<script setup lang="ts">
import { Button, Icon } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { localOpen } from "../desktop";
import { useDraggingOver } from "../dropHighlight";
import RecentList from "./RecentList.vue";

// The first thing Home offers, and the whole of what needs nothing else: a folder or a document of this computer,
// opened in a window of its own with the editor's own views (src-tauri/src/local.rs). No sandbox, account or Docker,
// so it stands above everything that needs one. A drop anywhere on the window opens the same way (windows.rs); the
// zone is where the reader is told so, and it lights up while something is over the window.

const t = useT();
const dragging = useDraggingOver();
</script>

<template>
    <section class="flex flex-col gap-4">
        <div
            class="flex flex-col gap-3 rounded-xl border border-dashed px-4 py-4 transition-colors"
            :class="dragging ? `border-primary-500 bg-primary-500/10` : `border-line`"
        >
            <h1 class="text-lg leading-tight font-semibold">{{ t(`desktop.home.openAnything`) }}</h1>
            <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
                <!-- The system dialog, then a window for what was chosen (local.rs `pick`); nothing chosen opens nothing. -->
                <Button :label="t(`desktop.home.openFolder`)" @click="localOpen(true)">
                    <template #icon><Icon name="folder-open" /></template>
                </Button>
                <Button :label="t(`desktop.home.openFile`)" @click="localOpen(false)">
                    <template #icon><Icon name="file" /></template>
                </Button>
                <span class="flex min-w-0 items-center gap-2 text-xs transition-colors" :class="dragging ? `text-link` : `text-muted`">
                    <Icon name="download" class="shrink-0" />
                    <span>{{ t(`desktop.home.dropHere`) }}</span>
                </span>
            </div>
        </div>
        <RecentList />
    </section>
</template>
