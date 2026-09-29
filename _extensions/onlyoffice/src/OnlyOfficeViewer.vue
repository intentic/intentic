<script setup lang="ts">
import { activeLocale, appLink, Button, Checkbox, ConfirmDialog, formatDateTime, Icon, Notice, ProgressRing, ui } from "@intentic/extension-ui";
import { computed, onBeforeUnmount, onMounted, ref, type VNode, watch } from "vue";
import type { DocsState } from "./contract.js";
import { forceSaveDocument, type KeptOriginal, openDocument, originalOf, restoreOriginal, startDocs } from "./docs.js";
import { extensionOf, READ_ONLY_IN_BROWSER } from "./formats.js";
import { host } from "./host.js";
import type { ConflictChoice, PageMessage } from "./protocol.js";
import { AUTO_START, ENGINE, engineOf } from "./settings.js";
import { chooseEdit, EditorSlot, editChosen, offersEdit, openingMode, reportUnsaved, type UnsavedReport } from "./slot.js";
import { t } from "./i18n.js";

/* A document in ONLYOFFICE: an editor frame on the listener's own origin once the chosen engine can open it (the browser engine's one download, or the document server's container), and until then a card saying what stands between the reader and it. The frame is placed by EditorSlot rather than by the template, so that leaving the document can keep the editor alive and coming back shows it again at once. */

/* What the host may hand it beyond the path: `agent`, the conversation whose checkout the file is read from, which is never editable, like text; `readOnly`, the host's word that this window may not write the file (a desktop document window's other files); `unsaved`, where to say whether an editor of the document holds edits its file doesn't have, which EditorSlot keeps saying after this viewer has gone, for as long as a kept editor holds them; and a `text` slot, the document's text, shown while the editor can't show the document itself. */
const { path, agent, readOnly = false, unsaved } = defineProps<{ path: string; agent?: string; readOnly?: boolean; unsaved?: UnsavedReport }>();
defineEmits<{ download: [] }>();
defineSlots<{ text?: () => VNode[] }>();

// Between polls while the engine is downloading or starting; the download is a minute or less, a start tens of seconds.
const POLL_MS = 1500;

// The backend's word on how documents open. `view` opens each one for reading, with Edit a press away: a desktop app's
// local window, whose documents are the user's own files. Not a declared setting, since nobody sets it from here.
const OPEN_AS = `openAs`;

// What the browser engine's page said that the reader should see over the editor, or a restore that didn't happen.
type Note =
    | { readonly kind: `conflict` }
    | { readonly kind: `save-failed`; readonly detail: string }
    | { readonly kind: `copied`; readonly path: string }
    | { readonly kind: `open-failed`; readonly detail: string }
    | { readonly kind: `restore-failed`; readonly detail: string };

const slot = ref<HTMLElement>();
// Whether an editor is in the slot; the card shows otherwise.
const framed = ref(false);
const status = ref<DocsState>();
const failure = ref<string>();
const note = ref<Note>();
// Whether the editor has stood between the reader and this document since it was asked for: its download, its start,
// a failure. From then until the editor shows, the host's reading of the document as text fills the view, if it gave one.
const waited = ref(false);
// One-shot timers chained by hand, cleared on unmount; no repeating clock.
let pending: ReturnType<typeof setTimeout> | undefined;
let editor: EditorSlot | undefined;

// The owner's engine, kept in step with the Extensions tab through the host's settings store.
const engine = ref(engineOf({ [ENGINE]: host().settings.get(ENGINE) }));
const browserEngine = computed(() => engine.value === `browser`);
const viewFirst = ref(host().settings.get(OPEN_AS) === `view`);

// Editing needs a tier that may write files, and the shared tree: a scoped copy can't be written into at all. The host
// may refuse it for a reason of its own (`readOnly`).
const editable = computed(() => agent === undefined && !readOnly && [`owner`, `maintainer`].includes(host().sandbox.role()));
// The reader pressed Edit on this document, opened for reading first; remembered for the page's life (slot.ts).
const editAsked = ref(editChosen(path));
const rules = computed(() => ({ mayEdit: editable.value, viewFirst: viewFirst.value, editAsked: editAsked.value }));
const mode = computed(() => openingMode(rules.value));
// The browser engine opens the legacy binary formats for reading whatever it is asked, so Edit is never offered on one.
const editOffered = computed(() => framed.value && offersEdit(rules.value, !(browserEngine.value && READ_ONLY_IN_BROWSER.includes(extensionOf(path)))));
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
            mode: mode.value,
            theme: theme(),
            engine: engine.value,
            lang: activeLocale.value,
            origin: window.location.origin,
        });
        if (`status` in loaded) {
            status.value = loaded.status;
            waited.value ||= loaded.status.state !== `ready`;
            if (!settled(loaded.status)) {
                pending = setTimeout(() => void load(), POLL_MS);
            }
        } else if (`framed` in loaded) {
            status.value = undefined;
        }
    } catch (error) {
        failure.value = error instanceof Error ? error.message : String(error);
        waited.value = true;
    }
};

// The document as it was before this window first saved it, where the backend keeps one (a local window's does). Asked
// once per document, after its first save; a backend without the route answers 404, and nothing is shown.
const original = ref<KeptOriginal>();
let originalAsked = false;
const askOriginal = async (): Promise<void> => {
    if (originalAsked) {
        return;
    }
    originalAsked = true;
    const asked = path;
    try {
        const kept = await originalOf(asked);
        if (asked === path) {
            original.value = kept;
        }
    } catch {
        // allow(silent-catch): the notice is a courtesy, and a backend that couldn't say is asked again at the next save.
        originalAsked = false;
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
            if (message.path === path) {
                void askOriginal();
            }
            break;
        default:
            break;
    }
};

// Where the host hears about this document's unsaved edits: EditorSlot tells it for every editor of the document,
// this one and any kept alive, so it is handed over once per document rather than kept by this mount.
watch(
    () => [path, unsaved] as const,
    ([document, report]) => {
        if (report !== undefined) {
            reportUnsaved(document, report);
        }
    },
    { immediate: true },
);

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

// Opens the document for editing, in this tab: the reading editor goes (it holds nothing to save), an editing one
// takes its place.
const edit = (): void => {
    chooseEdit(path);
    editAsked.value = true;
    status.value = undefined;
    reopen();
};

// Restoring asks first: it replaces the document with the original, and whatever the editor holds goes with it.
const confirmingRestore = ref(false);
const restoring = ref(false);
const restore = async (): Promise<void> => {
    restoring.value = true;
    try {
        await restoreOriginal(path);
    } catch (error) {
        note.value = { kind: `restore-failed`, detail: error instanceof Error ? error.message : String(error) };
        return;
    } finally {
        restoring.value = false;
        confirmingRestore.value = false;
    }
    // The editor held the version just replaced: a new one opens on the original (what the old one held goes with it),
    // and the next save keeps it again.
    original.value = undefined;
    originalAsked = false;
    status.value = undefined;
    reopen();
};
const keptTitle = computed(() =>
    original.value?.keptAt === undefined
        ? t(`onlyOfficeViewer.originalKeptHint`)
        : t(`onlyOfficeViewer.originalKeptAt`, { when: formatDateTime(original.value.keptAt) }),
);

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
            // Shown at last: what stood in the way is past, and a later reopen (Edit, a restore) is a moment's wait.
            if (value) {
                waited.value = false;
            }
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
// Another document starts over: opened as the reader last chose for it, with its own original and its own wait.
watch(
    () => [path, agent] as const,
    () => {
        editAsked.value = editChosen(path);
        original.value = undefined;
        originalAsked = false;
        waited.value = false;
        reload();
    },
);
// The standing choices, offered where the wait is felt; the same values the Extensions tab edits, kept in step through
// the host's settings store. A new engine means a new editor, and so does a new word on how documents open.
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
    if (key === OPEN_AS) {
        const first = host().settings.get(OPEN_AS) === `view`;
        if (first !== viewFirst.value) {
            viewFirst.value = first;
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
// What stands in the way, as the one line over the document's text: a failure first, then a state the reader can only
// try again past. Undefined while the editor is only on its way.
const problem = computed(() => {
    if (failure.value !== undefined) {
        return failure.value;
    }
    switch (status.value?.state) {
        case `docker-off`:
            return t(`onlyOfficeViewer.onlyofficeDocsRunsContainer`, { detail: status.value.detail });
        case `no-address`:
            return t(`onlyOfficeViewer.editorNeedsAddressBrowser`);
        case `error`:
            return status.value.detail;
        default:
            return undefined;
    }
});
// A real link: hover, right-click and Ctrl/Cmd-click behave as on any address.
const capabilitiesLink = appLink(host().href(`/capabilities`), () => host().navigate(`/capabilities`));
</script>

<template>
    <div class="flex h-full w-full flex-col">
        <!-- A document opened for reading first, and the original a first save kept: one quiet row, there only when it has something to say. -->
        <div v-if="framed && (editOffered || original !== undefined)" class="flex shrink-0 items-center gap-3 border-b border-line px-3 py-1 text-2xs text-muted">
            <span v-if="original !== undefined" class="flex min-w-0 items-center gap-1.5" v-tooltip.bottom="keptTitle">
                <Icon name="history" class="shrink-0 text-xs" />
                <span class="truncate">{{ t(`onlyOfficeViewer.originalKept`) }}</span>
                <span aria-hidden="true">·</span>
                <button type="button" :class="ui.linkButton(`shrink-0 font-medium`)" @click="confirmingRestore = true">
                    {{ t(`onlyOfficeViewer.restoreOriginal`) }}
                </button>
            </span>
            <span class="flex-1" />
            <Button v-if="editOffered" size="small" severity="secondary" :text="true" v-tooltip.bottom="t(`onlyOfficeViewer.editHint`)" @click="edit">
                <Icon name="pencil" class="text-xs" /> {{ t(`onlyOfficeViewer.edit`) }}
            </Button>
        </div>
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
                v-else-if="note.kind === 'restore-failed'"
                :of="{ tone: `danger`, title: t(`onlyOfficeViewer.restoreFailed`), detail: note.detail }"
                :dismiss-label="t(`onlyOfficeViewer.dismiss`)"
                @dismiss="note = undefined"
            />
            <Notice
                v-else
                :of="{ tone: `info`, title: t(`onlyOfficeViewer.savedAsCopy`, { path: note.path }) }"
                :dismiss-label="t(`onlyOfficeViewer.dismiss`)"
                @dismiss="note = undefined"
            />
        </div>
        <div ref="slot" v-show="framed" class="min-h-0 w-full flex-1" />
        <!-- The document's text while the editor can't show it yet, under one line saying why, with the way on. -->
        <div v-if="!framed && waited && $slots[`text`]" class="flex min-h-0 flex-1 flex-col">
            <div class="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-line px-3 py-1.5 text-2xs text-muted">
                <template v-if="problem !== undefined">
                    <Icon name="exclamation-circle" class="shrink-0 text-xs" />
                    <span class="min-w-0 flex-1">{{ problem }}</span>
                    <Button size="small" severity="secondary" :text="true" @click="load">{{ t(`onlyOfficeViewer.tryAgain`) }}</Button>
                </template>
                <template v-else-if="status?.state === 'pulling'">
                    <ProgressRing :value="percent ?? 0" :size="14" :stroke="2" />
                    <span class="min-w-0 flex-1">{{ downloading }}</span>
                </template>
                <template v-else-if="status?.state === 'not-started'">
                    <Icon name="file-edit" class="shrink-0 text-xs" />
                    <span class="min-w-0 flex-1">{{ t(`onlyOfficeViewer.textUntilEditor`) }}</span>
                    <Button size="small" severity="secondary" @click="start">
                        {{ browserEngine ? t(`onlyOfficeViewer.downloadEditor`) : t(`onlyOfficeViewer.startOnlyofficeDocs`) }}
                    </Button>
                </template>
                <template v-else-if="status?.state === 'starting'">
                    <Icon name="spinner" spin class="shrink-0 text-xs" />
                    <span class="min-w-0 flex-1">{{ t(`onlyOfficeViewer.startingDocumentServer`) }}</span>
                </template>
                <template v-else>
                    <Icon name="spinner" spin class="shrink-0 text-xs" />
                    <span class="min-w-0 flex-1">{{ browserEngine ? t(`onlyOfficeViewer.openingInOnlyoffice`) : t(`onlyOfficeViewer.openingInOnlyofficeDocs`) }}</span>
                </template>
            </div>
            <div class="min-h-0 flex-1">
                <slot name="text" />
            </div>
        </div>
        <div v-else-if="!framed" class="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
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
                <!-- The standing choices are a sandbox's: a backend that says how documents open (a local window's) has none the reader sets. -->
                <template v-if="!viewFirst">
                    <label class="mt-2 flex cursor-pointer items-center gap-2 text-xs text-muted">
                        <Checkbox :model-value="autoStart" binary @update:model-value="setAutoStart" />
                        {{ t(`onlyOfficeViewer.startSandboxNowOn`) }}
                    </label>
                    <a v-bind="settingsLink" class="text-xs text-subtle hover:underline">{{ t(`onlyOfficeViewer.extensionSettings`) }}</a>
                </template>
            </template>
            <template v-else-if="status?.state === 'pulling'">
                <ProgressRing :value="percent ?? 0" :size="40" :stroke="3" />
                <p class="max-w-sm text-sm text-muted">{{ downloading }}</p>
            </template>
            <template v-else-if="status?.state === 'starting'">
                <Icon name="spinner" spin class="text-4xl text-subtle" />
                <p class="max-w-sm text-sm text-muted">{{ t(`onlyOfficeViewer.startingDocumentServerCold`) }}</p>
                <label v-if="!viewFirst" class="mt-2 flex cursor-pointer items-center gap-2 text-xs text-muted">
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
        <ConfirmDialog
            :open="confirmingRestore"
            :header="t(`onlyOfficeViewer.restoreOriginalQuestion`)"
            header-icon="history"
            :confirm-label="t(`onlyOfficeViewer.restoreOriginal`)"
            confirm-icon="undo"
            :loading="restoring"
            @cancel="confirmingRestore = false"
            @confirm="restore"
        >
            <p class="text-sm text-muted">{{ t(`onlyOfficeViewer.restoreOriginalBody`) }}</p>
        </ConfirmDialog>
    </div>
</template>
