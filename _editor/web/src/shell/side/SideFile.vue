<script setup lang="ts">
import { useT } from "@intentic/ui/i18n";
import { basename } from "@intentic/ui/path";
import { computed, provide, ref, useId, watch } from "vue";
import { CHROME_SCOPE } from "../../features/workspace/files/viewerChrome";
import { VIEW_SCOPE } from "../../features/workspace/health/workspaceScope";
import type { LineJump } from "../../features/workspace/tabs/workspaceTabs";
import FileViewer from "../../features/workspace/viewers/FileViewer.vue";
import { FileSideInputSchema } from "./sideFileInput";
import type { SideInput } from "./sideTabs";

// A file peeked beside the section: the Workspace's own file surface, as a look. It reads the copy the reference named
// (VIEW_SCOPE) without switching the Workspace to it, and never edits, since the Workspace may hold the same path open
// with unsaved work; "Open in Workspace" on the strip is where the caret is.

const { input, jump } = defineProps<{ input: SideInput; jump?: LineJump }>();

const t = useT();

const file = computed(() => FileSideInputSchema.safeParse(input).data);
provide(
    VIEW_SCOPE,
    computed(() => file.value?.agent),
);
// Teleport seats of its own, so a viewer's controls never land in the Workspace's bar, nor in another peek's.
provide(CHROME_SCOPE, `side-${useId()}`);

// Deleted or moved since it was mentioned: said in place, rather than the tab closing under the click that opened it.
const gone = ref(false);
watch(
    () => file.value?.path,
    () => {
        gone.value = false;
    },
);
</script>

<template>
    <div v-if="file === undefined || gone" class="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
        <Icon name="file" class="text-2xl text-subtle" />
        <p class="text-sm text-muted">{{ t(`shell.sidePanel.gone`, { name: file === undefined ? `` : basename(file.path) }) }}</p>
        <p class="max-w-xs text-2xs text-subtle">{{ t(`shell.sidePanel.goneNote`) }}</p>
    </div>
    <FileViewer v-else :key="`${file.agent ?? ``}:${file.path}`" :path="file.path" :line="jump" read-only class="bg-card" @gone="gone = true" />
</template>
