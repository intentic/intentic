<script setup lang="ts">
import type { BrowserDownload } from "@intentic/sandbox-contract/schemas/browser-tools";
import { Icon } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { ref, watch } from "vue";
import FolderPicker from "../../sandbox/devices/FolderPicker.vue";
import { removeStoredValue, settingKey, storedValue, storeValue } from "../../../app/storage/browserStorage";
import type { DownloadTools } from "./useDownloadTools";
import { downloadLine } from "./downloadWords";

// The window's downloads, newest first, each with what can be made of it: a file on the person's own computer, a copy
// in a workspace folder (picked once at the foot, `downloads/` until then, and remembered), its link, or nothing.

const { tools } = defineProps<{ tools: DownloadTools }>();
const t = useT();

// The account's setting (app/storage/browserStorage.ts), like a browser's own download folder.
const FOLDER_KEY = settingKey(`intentic.browsers.downloadFolder`);
const kept = storedValue(FOLDER_KEY);
const folder = ref<string[]>(kept === undefined || kept === `` ? [] : [kept]);
watch(folder, ([picked]) => (picked === undefined ? removeStoredValue(FOLDER_KEY) : storeValue(FOLDER_KEY, picked)));

const done = (download: BrowserDownload): boolean => download.state === `done`;
const action = `flex size-7 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-content/5 hover:text-content`;
</script>

<template>
    <div class="flex w-96 max-w-[90vw] flex-col">
        <div class="flex items-center justify-between px-3 pb-1 pt-2.5">
            <span class="text-xs font-medium text-content">{{ t(`browsers.tools.downloads`) }}</span>
        </div>
        <p v-if="tools.list.value.length === 0" class="px-3 pb-3 pt-1 text-2xs text-muted">{{ t(`browsers.tools.noDownloads`) }}</p>
        <ul v-else class="flex max-h-96 flex-col overflow-y-auto px-1 pb-1">
            <li v-for="download in tools.list.value" :key="download.id" class="group flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-content/5">
                <Icon
                    :name="download.state === `progress` ? `spinner` : download.name.toLowerCase().endsWith(`.pdf`) ? `file-pdf` : `file`"
                    :spin="download.state === `progress`"
                    class="shrink-0 text-xs"
                    :class="download.state === `failed` || download.state === `canceled` ? 'text-subtle' : 'text-muted'"
                />
                <span class="min-w-0 flex-1">
                    <span class="block truncate text-xs" :class="done(download) ? 'text-content' : 'text-muted'" :title="download.name">{{ download.name }}</span>
                    <span class="block truncate text-3xs text-muted">{{ downloadLine(download) }}</span>
                    <span
                        v-if="tools.said.value[download.id]"
                        class="block truncate text-3xs"
                        :class="tools.said.value[download.id]?.ok ? 'text-success' : 'text-danger'"
                    >
                        {{ tools.said.value[download.id]?.ok ? t(`browsers.tools.savedTo`, { path: tools.said.value[download.id]?.text ?? `` }) : tools.said.value[download.id]?.text }}
                    </span>
                </span>
                <template v-if="done(download)">
                    <button type="button" :class="action" :aria-label="t(`browsers.tools.saveToComputer`)" v-tooltip.top="{ title: t(`ui.action.download`), note: t(`browsers.tools.saveToComputer`) }" @click="tools.toComputer(download)">
                        <Icon name="download" class="text-2xs" />
                    </button>
                    <button
                        type="button"
                        :class="action"
                        :aria-label="t(`browsers.tools.saveToWorkspace`)"
                        v-tooltip.top="{ title: t(`browsers.tools.saveToWorkspace`), note: folder[0] ?? `downloads/` }"
                        @click="tools.toWorkspace(download, folder[0])"
                    >
                        <Icon name="folder" class="text-2xs" />
                    </button>
                </template>
                <button v-if="download.url !== ``" type="button" :class="action" :aria-label="t(`browsers.tools.copyLink`)" v-tooltip.top="t(`browsers.tools.copyLink`)" @click="tools.copyLink(download)">
                    <Icon name="link" class="text-2xs" />
                </button>
                <button
                    v-if="download.state === `progress`"
                    type="button"
                    :class="action"
                    :aria-label="t(`browsers.tools.stop`)"
                    v-tooltip.top="t(`browsers.tools.stop`)"
                    @click="tools.cancel(download)"
                >
                    <Icon name="times" class="text-2xs" />
                </button>
                <button v-else type="button" :class="action" :aria-label="t(`browsers.tools.remove`)" v-tooltip.top="t(`browsers.tools.remove`)" @click="tools.remove(download)">
                    <Icon name="trash" class="text-2xs" />
                </button>
            </li>
        </ul>
        <div class="flex items-center gap-2 border-t border-line px-3 py-2">
            <span class="shrink-0 text-2xs text-muted">{{ t(`browsers.tools.saveInto`) }}</span>
            <FolderPicker v-model="folder" class="min-w-0 flex-1" :label="t(`browsers.tools.saveInto`)" placeholder="downloads/" />
        </div>
    </div>
</template>
