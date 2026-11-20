<script setup lang="ts">
import type { BrowserFileChooser } from "@intentic/sandbox-contract/schemas/browser-tools";
import { Button, Icon } from "@intentic/ui";
import { formatBytes } from "@intentic/ui/format";
import { useT } from "@intentic/ui/i18n";
import { computed, onMounted, ref, watch } from "vue";
import type { FileTools } from "./useFileTools";

// A page asked for files: the person's own picker opens on their own computer, never the sandbox's. A click on the
// picture is still a user gesture in the person's browser for a few seconds after it, long enough for the page's ask to
// come back, so the picker opens at once where the browser still allows it (Chromium-based ones); this card stays
// either way, with the same picker behind Choose files, and Cancel tells the page the picker was closed. While the
// picked files go up, it says how far each has got.

// `dragging`: files from the desktop are held over the picture, which takes them where they are dropped.
const { tools, site, dragging = false } = defineProps<{ tools: FileTools; site: string | undefined; dragging?: boolean }>();
const t = useT();

const input = ref<HTMLInputElement | undefined>();
const chooser = computed(() => tools.chooser.value);
const takes = computed(() => chooser.value?.accept?.join(`, `));

// Opened once per ask, and only while the click that caused it still counts as one: elsewhere the browser refuses a
// picker nobody pressed for, and the card's own button is the way.
const opened = ref<string | undefined>();
const openNow = (asked: BrowserFileChooser | undefined): void => {
    // Absent where the browser does not say (older Safari): there the card's own button is the way, as when it says no.
    const active = `userActivation` in navigator && navigator.userActivation.isActive;
    if (asked === undefined || opened.value === asked.id || !active) {
        return;
    }
    opened.value = asked.id;
    input.value?.click();
};
onMounted(() => openNow(chooser.value));
watch(chooser, openNow, { flush: `post` });

const choose = (): void => input.value?.click();
const onPicked = (): void => {
    const asked = chooser.value;
    const field = input.value;
    if (asked !== undefined && field?.files !== null && field?.files !== undefined && field.files.length > 0) {
        void tools.pick(asked, field.files);
    }
    if (field !== undefined) {
        field.value = ``;
    }
};
const onCancel = (): void => {
    const asked = chooser.value;
    if (asked !== undefined && tools.sending.value.length === 0) {
        void tools.cancel(asked);
    }
};
</script>

<template>
    <div v-if="dragging" class="pointer-events-none absolute inset-2 z-20 flex items-center justify-center rounded-lg border-2 border-dashed border-primary-500 bg-canvas/40">
        <span class="rounded-md bg-card px-3 py-1.5 text-xs text-content shadow-lg">{{ t(`browsers.tools.dropHere`) }}</span>
    </div>
    <div v-if="chooser || tools.sending.value.length > 0 || tools.error.value" class="pointer-events-none absolute inset-x-0 top-3 z-20 flex justify-center px-3">
        <div class="pointer-events-auto flex w-full max-w-md flex-col gap-3 rounded-lg border border-line bg-card p-4 shadow-lg">
            <input
                ref="input"
                type="file"
                class="hidden"
                :multiple="chooser?.multiple"
                :accept="takes"
                @change="onPicked"
                @cancel="onCancel"
            />
            <div class="flex items-start gap-2 text-xs">
                <Icon name="upload" class="shrink-0 text-muted" />
                <div class="min-w-0 flex-1">
                    <div class="text-xs font-medium text-content">
                        {{ t(`browsers.tools.filesAsked`, { site: site ?? t(`browsers.tools.thisPage`) }, chooser?.multiple ? 2 : 1) }}
                    </div>
                    <div class="text-2xs text-muted">{{ takes ? t(`browsers.tools.filesTake`, { types: takes }) : t(`browsers.tools.filesFromComputer`) }}</div>
                </div>
            </div>
            <ul v-if="tools.sending.value.length > 0" class="flex flex-col gap-1">
                <li v-for="file in tools.sending.value" :key="file.name" class="flex items-center gap-2 text-2xs">
                    <span class="min-w-0 flex-1 truncate text-content">{{ file.name }}</span>
                    <span class="shrink-0 tabular-nums text-muted">{{ formatBytes(file.sent) }} / {{ formatBytes(file.size) }}</span>
                </li>
            </ul>
            <p v-if="tools.error.value" class="text-2xs text-danger">{{ tools.error.value }}</p>
            <div v-if="chooser" class="flex justify-end gap-2">
                <Button size="small" tier="quiet" :disabled="tools.sending.value.length > 0" @click="onCancel">{{ t(`ui.action.cancel`) }}</Button>
                <Button size="small" tier="accent" :loading="tools.sending.value.length > 0" @click="choose">
                    {{ chooser.multiple ? t(`browsers.tools.chooseFiles`) : t(`browsers.tools.chooseFile`) }}
                </Button>
            </div>
        </div>
    </div>
</template>
