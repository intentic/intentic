<script setup lang="ts">
import { computed, provide, ref, useId, watch } from "vue";
import { CHROME_SCOPE } from "../../features/workspace/files/viewerChrome";
import { VIEW_SCOPE } from "../../app/workspaceScope";
import type { LineJump } from "../../models/workspace/tabs/workspaceTabs";
import FileViewer from "../../features/workspace/viewers/FileViewer.vue";
import { arrivalOf, FileSideInputSchema } from "../../workbench/side/sideFileInput";
import type { SideInput } from "../../workbench/side/sideTabs";
import SideFileArrival from "./SideFileArrival.vue";
import SideFileMissing from "./SideFileMissing.vue";

// A file peeked beside the section: the Workspace's own file surface, as a look. It reads the copy the reference named
// (VIEW_SCOPE) without switching the Workspace to it, and never edits, since the Workspace may hold the same path open
// with unsaved work; "Open in Workspace" on the strip is where the caret is.

const { input, jump } = defineProps<{ input: SideInput; jump?: LineJump }>();

const file = computed(() => FileSideInputSchema.safeParse(input).data);
// How the reference reached this tab, when there is something to say about it (one of several, renamed, or nothing).
const arrival = computed(() => arrivalOf(input));
const told = computed(() => arrival.value !== undefined && (arrival.value.matches !== undefined || arrival.value.renamedFrom !== undefined));
provide(
    VIEW_SCOPE,
    computed(() => file.value?.agent),
);
// Teleport seats of its own, so a viewer's controls never land in the Workspace's bar, nor in another peek's.
provide(CHROME_SCOPE, `side-${useId()}`);

// Deleted or moved since it was opened: said in place, rather than the tab closing under the click that opened it. A
// reference that never matched anything arrives already missing, and never reaches a viewer at all.
const gone = ref(false);
watch(
    () => file.value?.path,
    () => {
        gone.value = false;
    },
);
</script>

<template>
    <SideFileMissing
        v-if="file === undefined || file.missing === true || gone"
        :reference="file?.path ?? ``"
        :agent="file?.agent"
        :gone="gone"
        :nearby="file?.missing === true ? arrival?.nearby : undefined"
        :line="jump?.line"
        class="flex-1"
    />
    <template v-else>
        <SideFileArrival v-if="told && arrival !== undefined" :path="file.path" :agent="file.agent" :arrival="arrival" />
        <FileViewer :key="`${file.agent ?? ``}:${file.path}`" :path="file.path" :line="jump" read-only class="min-h-0 flex-1 bg-card" @gone="gone = true" />
    </template>
</template>
