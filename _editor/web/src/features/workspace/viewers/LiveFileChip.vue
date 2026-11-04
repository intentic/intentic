<script setup lang="ts">
import { ui } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { followEdits } from "./liveFile";

/* The file is being written while it is open (liveFile.ts): the chip says so, and is the reader's choice between being
   taken to each edit as it lands and staying where they are reading. `writing` is a call streaming the file's text right
   now (useDraftSeed): what shows is the agent's draft until the call lands. */

const { writing = false } = defineProps<{ writing?: boolean }>();
const t = useT();
</script>

<template>
    <button
        type="button"
        :class="ui.chip({ on: followEdits, size: `sm` }, `shrink-0 font-medium`)"
        :aria-pressed="followEdits"
        @click="followEdits = !followEdits"
        v-tooltip.bottom="{
            title: followEdits ? t(`workspace.fileViewer.followingEdits`) : t(`workspace.fileViewer.notFollowingEdits`),
            note: writing ? t(`workspace.fileViewer.draftNote`) : t(`workspace.fileViewer.liveNote`),
        }"
    >
        <span class="size-1.5 shrink-0 animate-pulse rounded-full bg-success" aria-hidden="true"></span>
        <span>{{ writing ? t(`workspace.fileViewer.writing`) : t(`workspace.fileViewer.live`) }}</span>
    </button>
</template>
