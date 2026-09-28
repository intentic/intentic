<script setup lang="ts">
import { Button, Icon, ui } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, onMounted, provide, ref } from "vue";
import { askLocalApp, localFace } from "../app/environments/local";
import { useExtensionHost } from "../extension-host/useExtensionHost";
import WorkspaceTree from "../features/workspace/explorer/WorkspaceTree.vue";
import { useWorkspaceTree } from "../features/workspace/explorer/useWorkspaceTree";
import EditorPane from "../features/workspace/files/EditorPane.vue";
import { useEditBuffers } from "../features/workspace/files/useEditBuffers";
import { HOISTED_CONTEXT } from "../features/workspace/files/viewerChrome";
import { useWorkspaceTabs } from "../features/workspace/tabs/useWorkspaceTabs";

// A desktop window on a folder of the user's own disk: the workspace's own explorer and editor pane, reading through the
// app's sidecar (app/environments/local.ts), and nothing that needs a sandbox. A document opened on its own shows alone
// until its folder is asked for; a folder shows its tree beside whatever is open.

const t = useT();
const face = localFace();

// The viewers (images, PDF, Office, EPUB) are extensions; this is the host that activates them for this window.
useExtensionHost();

const { listingOf, hiddenIn, keepListed, error, isLoading, busy } = useWorkspaceTree();
const tree = computed(() => listingOf(``) ?? []);
keepListed(() => ``);
const rootHidden = computed(() => hiddenIn(``));

const { openFile, openDirectory, selectTab, keepTab, closeTabIds } = useWorkspaceTabs();
const { forget } = useEditBuffers();
// The pane shows a closed tab's edits nowhere else, so they go with it, as in the workspace.
const closeTab = (id: string): void => closeTabIds(new Set([id])).forEach(forget);

// The breadcrumb and the viewer's actions ride the tab row, as they do in the workspace.
provide(HOISTED_CONTEXT, true);

const selected = ref<string | undefined>(undefined);
const treeShown = ref(face?.file === undefined);

onMounted(() => {
    if (face?.file !== undefined) {
        openFile(face.file, `keep`);
    }
});
</script>

<template>
    <div class="flex h-screen w-screen overflow-hidden">
        <aside v-if="treeShown" class="flex w-72 shrink-0 flex-col border-r border-line bg-card">
            <div class="flex h-9 shrink-0 items-center gap-1 border-b border-line pl-3 pr-1">
                <Icon name="folder" class="shrink-0 text-sm text-muted" />
                <span class="min-w-0 flex-1 truncate text-xs font-medium" v-tooltip.bottom="face?.path">{{ face?.name }}</span>
                <Icon v-if="busy || isLoading" name="spinner" class="text-sm text-muted" spin :aria-label="t(`workspace.words.working`)" />
                <button type="button" :class="ui.iconButton(`h-7 w-7`)" v-tooltip.bottom="t(`local.localFiles.reveal`)" :aria-label="t(`local.localFiles.reveal`)" @click="askLocalApp(`reveal`, selected)">
                    <Icon name="external-link" class="text-sm" />
                </button>
                <button type="button" :class="ui.iconButton(`h-7 w-7`)" v-tooltip.bottom="t(`local.localFiles.openFolder`)" :aria-label="t(`local.localFiles.openFolder`)" @click="askLocalApp(`open-folder`)">
                    <Icon name="folder-open" class="text-sm" />
                </button>
            </div>
            <p v-if="error" class="px-3 py-2 text-2xs text-danger">{{ error }}</p>
            <div class="min-h-0 flex-1 overflow-hidden">
                <WorkspaceTree
                    :tree="tree"
                    root-dir=""
                    :root-hidden="rootHidden"
                    :selected-path="selected ?? null"
                    @open-file="openFile"
                    @open-directory="openDirectory"
                    @pick="(entry) => (selected = entry.path)"
                    @clear="selected = undefined"
                />
            </div>
            <!-- The way from this folder to an agent: a sandbox of its own, kept in sync with it (the app's project.rs). -->
            <div v-if="face !== undefined && face.file === undefined" class="shrink-0 border-t border-line p-2">
                <Button
                    class="w-full"
                    size="small"
                    severity="secondary"
                    :label="face.sandbox === true ? t(`local.localFiles.openSandbox`) : t(`local.localFiles.withAgent`)"
                    v-tooltip.top="face.sandbox === true ? t(`local.localFiles.openSandboxHint`) : t(`local.localFiles.withAgentHint`)"
                    @click="askLocalApp(`sandbox`)"
                />
            </div>
        </aside>
        <div class="relative flex min-h-0 min-w-0 flex-1">
            <EditorPane pane="main" @select="selectTab" @keep="keepTab" @close="closeTab">
                <template #lead>
                    <button
                        type="button"
                        :class="ui.iconButton(`mx-1 h-7 w-7 self-center`)"
                        v-tooltip.bottom="t(`local.localFiles.toggleFolder`)"
                        :aria-label="t(`local.localFiles.toggleFolder`)"
                        @click="treeShown = !treeShown"
                    >
                        <Icon name="bars" class="text-sm" />
                    </button>
                </template>
            </EditorPane>
        </div>
    </div>
</template>
