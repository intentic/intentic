<script setup lang="ts">
import { appLink, Button, Checkbox, Icon, ProgressRing, ui } from "@intentic/extension-ui";
import { computed, onBeforeUnmount, ref, watch } from "vue";
import type { DocsState } from "./contract.js";
import { openDocument, startDocs } from "./docs.js";
import { host } from "./host.js";
import { AUTO_START } from "./settings.js";
import { t } from "./i18n.js";

/* A document in ONLYOFFICE Docs: an iframe on the editor's own origin once the document server answers, and until then a card saying what stands between the reader and it. */

// `agent` is the conversation whose checkout the file is read from; such a copy is never editable, like text.
const { path, agent } = defineProps<{ path: string; agent?: string }>();
defineEmits<{ download: [] }>();

// Between polls while the server is pulling or starting; the pull is minutes, a start is tens of seconds.
const POLL_MS = 1500;

const url = ref<string>();
const status = ref<DocsState>();
const failure = ref<string>();
// One-shot timers chained by hand, cleared on unmount; no repeating clock.
let pending: ReturnType<typeof setTimeout> | undefined;
let generation = 0;

// Editing needs a tier that may write files, and the shared tree: a scoped copy can't be written into at all.
const editable = computed(() => agent === undefined && [`owner`, `maintainer`].includes(host().sandbox.role()));
const theme = (): `light` | `dark` => (document.documentElement.dataset[`mode`] === `dark` ? `dark` : `light`);

const settled = (state: DocsState): boolean => state.state !== `pulling` && state.state !== `starting`;

const load = async (): Promise<void> => {
    const mine = ++generation;
    clearTimeout(pending);
    failure.value = undefined;
    try {
        const result = await openDocument({
            path,
            ...(agent === undefined ? {} : { agent }),
            mode: editable.value ? `edit` : `view`,
            theme: theme(),
        });
        if (mine !== generation) {
            return;
        }
        if (`url` in result) {
            // The public address the backend built, or its loopback twin when this browser is on the sandbox's machine.
            const address = await host().sandbox.previewAddress(result.url);
            if (mine !== generation) {
                return;
            }
            status.value = undefined;
            url.value = address;
            return;
        }
        status.value = result.status;
        if (!settled(result.status)) {
            pending = setTimeout(() => void load(), POLL_MS);
        }
    } catch (error) {
        if (mine === generation) {
            failure.value = error instanceof Error ? error.message : String(error);
        }
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

watch(
    () => [path, agent] as const,
    () => {
        url.value = undefined;
        status.value = undefined;
        void load();
    },
    { immediate: true },
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
    generation++;
    clearTimeout(pending);
    settingsWatch.dispose();
});

const percent = computed(() => (status.value?.state === `pulling` ? status.value.percent : undefined));
// A real link: hover, right-click and Ctrl/Cmd-click behave as on any address.
const capabilitiesLink = appLink(host().href(`/capabilities`), () => host().navigate(`/capabilities`));
</script>

<template>
    <iframe v-if="url" :src="url" class="h-full w-full border-0" allow="clipboard-read; clipboard-write" :title="path" />
    <div v-else class="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
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
