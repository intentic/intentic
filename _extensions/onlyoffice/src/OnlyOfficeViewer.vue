<script setup lang="ts">
import { appLink, Button, Checkbox, Icon, ProgressRing, ui } from "@intentic/extension-ui";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { DocsState } from "./contract.js";
import { forceSaveDocument, openDocument, startDocs } from "./docs.js";
import { host } from "./host.js";
import { AUTO_START } from "./settings.js";
import { EditorSlot } from "./slot.js";
import { t } from "./i18n.js";

/* A document in ONLYOFFICE Docs: an editor frame on the editor's own origin once the document server answers, and until then a card saying what stands between the reader and it. The frame is placed by EditorSlot rather than by the template, so that leaving the document can keep the editor alive and coming back shows it again at once. */

// `agent` is the conversation whose checkout the file is read from; such a copy is never editable, like text.
const { path, agent } = defineProps<{ path: string; agent?: string }>();
defineEmits<{ download: [] }>();

// Between polls while the server is pulling or starting; the pull is minutes, a start is tens of seconds.
const POLL_MS = 1500;

const slot = ref<HTMLElement>();
// Whether an editor is in the slot; the card shows otherwise.
const framed = ref(false);
const status = ref<DocsState>();
const failure = ref<string>();
// One-shot timers chained by hand, cleared on unmount; no repeating clock.
let pending: ReturnType<typeof setTimeout> | undefined;
let editor: EditorSlot | undefined;

// Editing needs a tier that may write files, and the shared tree: a scoped copy can't be written into at all.
const editable = computed(() => agent === undefined && [`owner`, `maintainer`].includes(host().sandbox.role()));
const theme = (): `light` | `dark` => (document.documentElement.dataset[`mode`] === `dark` ? `dark` : `light`);

const settled = (state: DocsState): boolean => state.state !== `pulling` && state.state !== `starting`;

const load = async (): Promise<void> => {
    clearTimeout(pending);
    failure.value = undefined;
    if (editor === undefined) {
        return;
    }
    try {
        const loaded = await editor.load({ path, agent, mode: editable.value ? `edit` : `view`, theme: theme() });
        if (`status` in loaded) {
            status.value = loaded.status;
            if (!settled(loaded.status)) {
                pending = setTimeout(() => void load(), POLL_MS);
            }
        } else if (`framed` in loaded) {
            status.value = undefined;
        }
    } catch (error) {
        failure.value = error instanceof Error ? error.message : String(error);
    }
};

// The button locks itself while this runs (the kit's Button does that for an async handler).
const start = async (): Promise<void> => {
    try {
        status.value = await startDocs();
        await load();
    } catch (error) {
        failure.value = error instanceof Error ? error.message : String(error);
    }
};

// The slot exists only once mounted, and a kept editor is placed into it synchronously, so the first load waits for it.
onMounted(() => {
    if (slot.value === undefined) {
        return;
    }
    editor = new EditorSlot(slot.value, {
        open: openDocument,
        // The public address the backend built, or its loopback twin when this browser is on the sandbox's machine.
        address: (url) => host().sandbox.previewAddress(url),
        forceSave: (session) => forceSaveDocument({ session }),
        framed: (value) => {
            framed.value = value;
        },
    });
    void load();
});
watch(
    () => [path, agent] as const,
    () => {
        editor?.leave();
        status.value = undefined;
        void load();
    },
);
// The standing choice, offered where the wait is felt; the same value the Extensions tab edits, kept in step through
// the host's settings store.
const autoStart = ref(host().settings.get(AUTO_START) === true);
const settingsWatch = host().settings.onDidChange((key) => {
    if (key === AUTO_START) {
        autoStart.value = host().settings.get(AUTO_START) === true;
    }
});
// Turning it on while nothing runs is also the start: the owner asked for a server, not for a note to self.
const setAutoStart = async (value: boolean): Promise<void> => {
    autoStart.value = value;
    await host().settings.set(AUTO_START, value);
    if (value && status.value?.state === `not-started`) {
        await start();
    }
};
const settingsLink = appLink(host().href(`/sandbox/extensions?view=installed`), () => host().navigate(`/sandbox/extensions?view=installed`));

onBeforeUnmount(() => {
    clearTimeout(pending);
    settingsWatch.dispose();
    editor?.leave();
});

const percent = computed(() => (status.value?.state === `pulling` ? status.value.percent : undefined));
// A real link: hover, right-click and Ctrl/Cmd-click behave as on any address.
const capabilitiesLink = appLink(host().href(`/capabilities`), () => host().navigate(`/capabilities`));
</script>

<template>
    <div ref="slot" v-show="framed" class="h-full w-full" />
    <div v-if="!framed" class="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <template v-if="failure">
            <Icon name="exclamation-circle" class="text-4xl text-subtle" />
            <p class="max-w-sm text-sm text-muted">{{ failure }}</p>
            <Button severity="secondary" class="mt-1" @click="load">{{ t(`onlyOfficeViewer.tryAgain`) }}</Button>
        </template>
        <template v-else-if="status?.state === 'docker-off'">
            <Icon name="file-edit" class="text-4xl text-subtle" />
            <p class="max-w-sm text-sm text-muted">{{ t(`onlyOfficeViewer.onlyofficeDocsRunsContainer`, { detail: status.detail }) }}</p>
            <a v-bind="capabilitiesLink" :class="ui.linkButton(`mt-1`)">{{ t(`onlyOfficeViewer.openCapabilities`) }}</a>
        </template>
        <template v-else-if="status?.state === 'not-started'">
            <Icon name="file-edit" class="text-4xl text-subtle" />
            <p class="max-w-sm text-sm text-muted">{{ t(`onlyOfficeViewer.openEditSaveDocument`) }}</p>
            <Button class="mt-1" @click="start">{{ t(`onlyOfficeViewer.startOnlyofficeDocs`) }}</Button>
            <label class="mt-2 flex cursor-pointer items-center gap-2 text-xs text-muted">
                <Checkbox :model-value="autoStart" binary @update:model-value="setAutoStart" />
                {{ t(`onlyOfficeViewer.startSandboxNowOn`) }}
            </label>
            <a v-bind="settingsLink" class="text-xs text-subtle hover:underline">{{ t(`onlyOfficeViewer.extensionSettings`) }}</a>
        </template>
        <template v-else-if="status?.state === 'pulling'">
            <ProgressRing :value="percent ?? 0" :size="40" :stroke="3" />
            <p class="max-w-sm text-sm text-muted">
                {{ percent === undefined ? t(`onlyOfficeViewer.downloading`) : t(`onlyOfficeViewer.downloadingPercent`, { percent }) }}
            </p>
        </template>
        <template v-else-if="status?.state === 'starting'">
            <Icon name="spinner" spin class="text-4xl text-subtle" />
            <p class="max-w-sm text-sm text-muted">{{ t(`onlyOfficeViewer.startingDocumentServerCold`) }}</p>
            <label class="mt-2 flex cursor-pointer items-center gap-2 text-xs text-muted">
                <Checkbox :model-value="autoStart" binary @update:model-value="setAutoStart" />
                {{ t(`onlyOfficeViewer.startSandboxNowOn`) }}
            </label>
        </template>
        <template v-else-if="status?.state === 'no-address'">
            <Icon name="exclamation-circle" class="text-4xl text-subtle" />
            <p class="max-w-sm text-sm text-muted">{{ t(`onlyOfficeViewer.editorNeedsAddressBrowser`) }}</p>
            <Button severity="secondary" class="mt-1" @click="load">{{ t(`onlyOfficeViewer.tryAgain`) }}</Button>
        </template>
        <template v-else-if="status?.state === 'error'">
            <Icon name="exclamation-circle" class="text-4xl text-subtle" />
            <p class="max-w-sm text-sm text-muted">{{ status.detail }}</p>
            <Button severity="secondary" class="mt-1" @click="load">{{ t(`onlyOfficeViewer.tryAgain`) }}</Button>
        </template>
        <template v-else>
            <Icon name="spinner" spin class="text-4xl text-subtle" />
            <p class="max-w-sm text-sm text-muted">{{ t(`onlyOfficeViewer.openingInOnlyofficeDocs`) }}</p>
        </template>
    </div>
</template>
