<script setup lang="ts">
import { activeLocale, appLink, Button, Checkbox, Icon, Notice, ProgressRing, ui } from "@intentic/extension-ui";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { DocsState } from "./contract.js";
import { forceSaveDocument, openDocument, startDocs } from "./docs.js";
import { host } from "./host.js";
import type { ConflictChoice, PageMessage } from "./protocol.js";
import { AUTO_START, ENGINE, engineOf } from "./settings.js";
import { EditorSlot } from "./slot.js";
import { t } from "./i18n.js";

/* A document in ONLYOFFICE: an editor frame on the listener's own origin once the chosen engine can open it (the browser engine's one download, or the document server's container), and until then a card saying what stands between the reader and it. The frame is placed by EditorSlot rather than by the template, so that leaving the document can keep the editor alive and coming back shows it again at once. */

// `agent` is the conversation whose checkout the file is read from; such a copy is never editable, like text.
const { path, agent } = defineProps<{ path: string; agent?: string }>();
defineEmits<{ download: [] }>();

// Between polls while the engine is downloading or starting; the download is a minute or less, a start tens of seconds.
const POLL_MS = 1500;

// What the browser engine's page said that the reader should see over the editor.
type Note =
    | { readonly kind: `conflict` }
    | { readonly kind: `save-failed`; readonly detail: string }
    | { readonly kind: `copied`; readonly path: string }
    | { readonly kind: `open-failed`; readonly detail: string };

const slot = ref<HTMLElement>();
// Whether an editor is in the slot; the card shows otherwise.
const framed = ref(false);
const status = ref<DocsState>();
const failure = ref<string>();
const note = ref<Note>();
// One-shot timers chained by hand, cleared on unmount; no repeating clock.
let pending: ReturnType<typeof setTimeout> | undefined;
let editor: EditorSlot | undefined;

// The owner's engine, kept in step with the Extensions tab through the host's settings store.
const engine = ref(engineOf({ [ENGINE]: host().settings.get(ENGINE) }));
const browserEngine = computed(() => engine.value === `browser`);

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
        const loaded = await editor.load({
            path,
            agent,
            mode: editable.value ? `edit` : `view`,
            theme: theme(),
            engine: engine.value,
            lang: activeLocale.value,
            origin: window.location.origin,
        });
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

const heard = (message: PageMessage): void => {
    switch (message.type) {
        case `conflict`:
            note.value = { kind: `conflict` };
            break;
        case `save-failed`:
            note.value = { kind: `save-failed`, detail: message.detail };
            break;
        case `open-failed`:
            note.value = { kind: `open-failed`, detail: message.detail };
            break;
        case `saved`:
            note.value = message.path === path ? undefined : { kind: `copied`, path: message.path };
            break;
        default:
            break;
    }
};

const settle = (choice: ConflictChoice): void => {
    note.value = undefined;
    editor?.resolve(choice);
};

const retrySave = (): void => {
    note.value = undefined;
    editor?.save();
};

// A document that failed to open gets a new editor, not the kept one that failed.
const reopen = (): void => {
    note.value = undefined;
    editor?.reset();
    void load();
};

// The button locks itself while this runs (the kit's Button does that for an async handler).
const start = async (): Promise<void> => {
    try {
        status.value = await startDocs(engine.value);
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
        message: heard,
    });
    void load();
});
const reload = (): void => {
    editor?.leave();
    status.value = undefined;
    note.value = undefined;
    void load();
};
watch(() => [path, agent] as const, reload);
// The standing choices, offered where the wait is felt; the same values the Extensions tab edits, kept in step through
// the host's settings store. A new engine means a new editor.
const autoStart = ref(host().settings.get(AUTO_START) === true);
const settingsWatch = host().settings.onDidChange((key) => {
    if (key === AUTO_START) {
        autoStart.value = host().settings.get(AUTO_START) === true;
    }
    if (key === ENGINE) {
        const chosen = engineOf({ [ENGINE]: host().settings.get(ENGINE) });
        if (chosen !== engine.value) {
            engine.value = chosen;
            reload();
        }
    }
});
// Turning it on while nothing runs is also the start: the owner asked for an editor, not for a note to self.
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
    editor?.dispose();
});

const percent = computed(() => (status.value?.state === `pulling` ? status.value.percent : undefined));
const downloading = computed(() => {
    if (browserEngine.value) {
        return percent.value === undefined ? t(`onlyOfficeViewer.downloadingEditor`) : t(`onlyOfficeViewer.downloadingEditorPercent`, { percent: percent.value });
    }
    return percent.value === undefined ? t(`onlyOfficeViewer.downloading`) : t(`onlyOfficeViewer.downloadingPercent`, { percent: percent.value });
});
// A real link: hover, right-click and Ctrl/Cmd-click behave as on any address.
const capabilitiesLink = appLink(host().href(`/capabilities`), () => host().navigate(`/capabilities`));
</script>

<template>
    <div class="flex h-full w-full flex-col">
        <!-- Above the editor rather than over it: the notice's tint is translucent, and the editor's toolbar is right there. -->
        <div v-if="framed && note !== undefined" class="shrink-0 p-2">
            <Notice v-if="note.kind === 'conflict'" tone="warning">
                <span class="block">{{ t(`onlyOfficeViewer.changedOnDisk`) }}</span>
                <span class="mt-1 flex flex-wrap gap-3">
                    <button type="button" :class="ui.linkButton(`font-medium`)" @click="settle(`overwrite`)">{{ t(`onlyOfficeViewer.keepMine`) }}</button>
                    <button type="button" :class="ui.linkButton(`font-medium`)" @click="settle(`copy`)">{{ t(`onlyOfficeViewer.keepBoth`) }}</button>
                    <button type="button" :class="ui.linkButton(`font-medium`)" @click="settle(`reload`)">{{ t(`onlyOfficeViewer.discardMine`) }}</button>
                </span>
            </Notice>
            <Notice
                v-else-if="note.kind === 'save-failed'"
                :of="{ tone: `danger`, title: t(`onlyOfficeViewer.saveFailed`), detail: note.detail, action: { label: t(`onlyOfficeViewer.tryAgain`), run: retrySave } }"
                :dismiss-label="t(`onlyOfficeViewer.dismiss`)"
                @dismiss="note = undefined"
            />
            <Notice
                v-else-if="note.kind === 'open-failed'"
                :of="{ tone: `danger`, title: t(`onlyOfficeViewer.couldNotOpen`), detail: note.detail, action: { label: t(`onlyOfficeViewer.tryAgain`), run: reopen } }"
            />
            <Notice
                v-else
                :of="{ tone: `info`, title: t(`onlyOfficeViewer.savedAsCopy`, { path: note.path }) }"
                :dismiss-label="t(`onlyOfficeViewer.dismiss`)"
                @dismiss="note = undefined"
            />
        </div>
        <div ref="slot" v-show="framed" class="min-h-0 w-full flex-1" />
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
                <p class="max-w-sm text-sm text-muted">
                    {{ browserEngine ? t(`onlyOfficeViewer.openEditSaveInBrowser`) : t(`onlyOfficeViewer.openEditSaveDocument`) }}
                </p>
                <Button class="mt-1" @click="start">{{ browserEngine ? t(`onlyOfficeViewer.downloadEditor`) : t(`onlyOfficeViewer.startOnlyofficeDocs`) }}</Button>
                <label class="mt-2 flex cursor-pointer items-center gap-2 text-xs text-muted">
                    <Checkbox :model-value="autoStart" binary @update:model-value="setAutoStart" />
                    {{ t(`onlyOfficeViewer.startSandboxNowOn`) }}
                </label>
                <a v-bind="settingsLink" class="text-xs text-subtle hover:underline">{{ t(`onlyOfficeViewer.extensionSettings`) }}</a>
            </template>
            <template v-else-if="status?.state === 'pulling'">
                <ProgressRing :value="percent ?? 0" :size="40" :stroke="3" />
                <p class="max-w-sm text-sm text-muted">{{ downloading }}</p>
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
                <p class="max-w-sm text-sm text-muted">{{ browserEngine ? t(`onlyOfficeViewer.openingInOnlyoffice`) : t(`onlyOfficeViewer.openingInOnlyofficeDocs`) }}</p>
            </template>
        </div>
    </div>
</template>
