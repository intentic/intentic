<script setup lang="ts">
import type { WorkspaceFileResponse, WorkspaceTreeEntry } from "@intentic-app/api-contract";
import { CopyButton, useDevice } from "@intentic-app/ui";
import { computed, ref, shallowRef, watch, type Component } from "vue";
import { sandboxBlob, SandboxHttpError } from "../../../composables/sandbox/sandboxClient";
import { errorMessage } from "../../../composables/useAsyncAction";
import { sha256Hex } from "../../../composables/workspace/contentHash";
import { readFileWindow } from "../../../composables/workspace/fileWindow";
import { mediaUrl } from "../../../composables/workspace/mediaUrl";
import { useEditBuffers } from "../../../composables/workspace/useEditBuffers";
import { useLayout } from "../../../composables/useLayout";
import { useMonaco } from "../../../composables/workspace/useMonaco";
import { changeEpochOf } from "../../../composables/workspace/useWorkspaceLive";
import { useWorkspaceTree } from "../../../composables/workspace/useWorkspaceTree";
import BigTextView from "./BigTextView.vue";
import CodeView from "./CodeView.vue";
import FileBreadcrumb from "../FileBreadcrumb.vue";
import FileUnsupported from "./FileUnsupported.vue";
import { highlightLangFor, TEXT_EDIT_MAX_BYTES } from "../fileType";
import type { LineJump } from "../workspaceTabs";
import MarkdownViewer from "./MarkdownViewer.vue";
import { resolveOpenFile, type OpenFile } from "./openFile";

/* Dispatches one open file to its surface and owns the fetch.
 *
 * There are exactly THREE surfaces here, and no format-specific branch among them: the editor (code /
 * markdown / big-text), an extension's viewer, and the states with nothing to show (empty / binary /
 * too-large). Every picture, PDF, spreadsheet and recording the app can display is the middle one — a
 * `contributes.viewers` entry the host resolves at open time (openFile.ts). Adding a format is an extension,
 * not an edit to this file; switching that extension off degrades to a download with nothing to unwind.
 *
 * WHAT THE HOST STILL OWNS is the fetch, because that is where the credentials are. Every daemon route is
 * Bearer-authenticated, which a browser-issued <img>/<video> request cannot be, so the viewer never fetches:
 *   text — a bounded window through the same read the editor uses.
 *   blob — bytes through the sandbox client, turned into a blob: object URL and REVOKED on file-change or
 *          unmount via the watcher's cleanup (leak-safe across a fast walk through a folder of images).
 *   url  — a /workspace/media URL carrying a short-lived, path-scoped ticket, which the element range-reads
 *          itself. The extension gets a string; the credential is minted and held here.
 * A monotonic seq guard drops stale async results when the user switches files mid-fetch, and an
 * AbortController cancels the request itself so a superseded read stops costing the daemon and the wire.
 *
 * Text is read as a bounded WINDOW (readFileWindow) whose response carries the file's true size, and that size
 * is what decides between an editable buffer and the windowed read-only view. The decision used to be made
 * BEFORE the read, from the tree entry's `size` — which is absent for any file the loaded tree doesn't hold (a
 * tab restored before the tree arrives, anything inside node_modules, an entry the walk's budget cut). With no
 * size, every cap silently passed and the whole file was fetched, whatever it was. */

// `line` = jump the viewer to this line (a content-search match); undefined for a plain open.
const { path, meta, line } = defineProps<{ path: string; meta?: WorkspaceTreeEntry; line?: LineJump }>();
// The open file was deleted on disk (daemon read 404s) — the parent closes this tab rather than leaving a
// "not found" panel. Only fires for a clean read; a dirty file's re-read is skipped (staleOnDisk) so edits survive.
const emit = defineEmits<{ gone: [path: string] }>();

// Which surface is open — starts from resolveOpenFile(), but a `code` file whose bytes contain NUL is switched
// to `binary` after the read (an unknown-extension binary, shown as a download instead of mojibake), and one
// over the editable cap to `big-text`.
const open = ref<OpenFile>({ kind: `empty` });
const lang = ref<string | undefined>(undefined);
const text = ref<string | null>(null);
// Content for the resolved extension viewer, filled per its manifest `fetch`. Nothing here needs revoking: a
// `blob` viewer owns whatever object URL it makes of the bytes, and a `url` viewer is handed a plain string.
const fileBlob = ref<Blob | undefined>(undefined);
const fileSrc = ref<string | undefined>(undefined);
// The extension viewer component itself, lazily imported alongside its content.
const viewerComponent = shallowRef<Component | undefined>(undefined);
const loading = ref(false);
const error = ref<string | null>(null);
// Set when the open file changed on disk WHILE it has unsaved edits: we keep the buffer and offer Reload instead
// of silently overwriting the user's work.
const staleOnDisk = ref(false);
// Bumped by Reload to remount the editable code surface (it's uncontrolled, seeded once via :key) from disk text.
const reloadNonce = ref(0);
// Edit buffers: the read trigger's dirty-guard below reads this, so it must exist before the watch.
const edit = useEditBuffers();
// Warm Monaco + the file's grammar in parallel with the fetch (below) so the editor paints highlighted the
// instant CodeView mounts — no plain-text-then-color flash.
const { ensureMonaco, ensureLanguage } = useMonaco();

const readBlob = (target: string): Promise<Blob> => sandboxBlob(`/workspace/raw?path=${encodeURIComponent(target)}`);

let seq = 0;
/* The current text read. Aborted whenever another one supersedes it — a file switch, or the next change-epoch
 * reconcile. Without this, a file being appended to (a build log, a report an agent is writing) queued a fresh
 * whole-file read every 250ms batch with nothing cancelling the last one: requests piled up in flight, each
 * holding the file's text, and the daemon paid for every one of them. */
let reading: AbortController | undefined;
// The window a big text file opened with, handed to BigTextView so it doesn't re-read what we already have.
const firstWindow = ref<WorkspaceFileResponse | undefined>(undefined);

const readText = (target: string): Promise<WorkspaceFileResponse> => {
    reading?.abort();
    reading = new AbortController();
    return readFileWindow(target, { signal: reading.signal });
};
// An aborted read is this component replacing its own request — never an error to show the user.
const superseded = (err: unknown): boolean => err instanceof DOMException && err.name === `AbortError`;
// A same-path re-fire in an editable text view is a POSSIBLE external change — but it's also how the user's own
// save echoes back (upload → daemon file-watch → /events SSE → changeEpochOf bump). Reconcile by content instead
// of blindly resetting: re-read quietly (never null `text`, so no flicker), then act only on a real difference
// from the baseline we last knew on disk. After a save, baseline === disk, so the self-echo is a no-op.
const reconcileOpenFile = (currentPath: string): void => {
    const id = ++seq;
    readText(currentPath).then(
        ({ content }) => {
            if (id !== seq) {
                return;
            }
            // Equal to what we last knew on disk ⇒ our own save echo (or a no-op touch): leave the view alone.
            if (content === edit.baselineOf(currentPath)) {
                return;
            }
            // Equal to the live buffer ⇒ disk caught up to the user's text (a save echo racing markSaved, or an
            // external write of identical content): nothing is lost — record it as saved, no warning.
            if (content === edit.bufferOf(currentPath)) {
                edit.markSaved(currentPath, content);
                return;
            }
            // A genuine external edit landed while the user has unsaved work — keep the buffer, offer Reload.
            if (edit.isDirty(currentPath)) {
                staleOnDisk.value = true;
                return;
            }
            // External edit, no local changes: adopt it. Reseed the uncontrolled editor from the new disk text.
            if (content.includes("\u0000")) {
                open.value = { kind: `binary` };
                return;
            }
            text.value = content;
            edit.markSaved(currentPath, content);
            reloadNonce.value++;
        },
        (err) => {
            if (id !== seq || superseded(err)) {
                return;
            }
            if (err instanceof SandboxHttpError && err.status === 404) {
                // Deleted on disk: close the tab when clean; keep a dirty buffer behind the stale-on-disk banner.
                if (edit.isDirty(currentPath)) {
                    staleOnDisk.value = true;
                } else {
                    emit(`gone`, currentPath);
                }
                return;
            }
            error.value = errorMessage(err, `Could not load the file.`);
        },
    );
};

watch(
    // changeEpochOf(path) is the complete external-change signal — every write to /work echoes over the SSE and
    // bumps it, so the open file re-reads even when its byte length (the tree entry's size) is unchanged. Size is
    // deliberately NOT a trigger: it would also fire mid-save from the post-save tree refetch, racing markSaved.
    () => [path, changeEpochOf(path)] as const,
    ([currentPath], previous, onCleanup) => {
        // A same-path re-fire in an editable text view reconciles by content (no flicker, no false warning);
        // everything else (a new file, or a non-text mode) takes the destructive reset + fetch below.
        if (previous !== undefined && currentPath === previous[0] && (open.value.kind === `code` || open.value.kind === `markdown`)) {
            reconcileOpenFile(currentPath);
            return;
        }
        const resolution = resolveOpenFile(currentPath, meta?.size);
        const id = ++seq;

        staleOnDisk.value = false;
        text.value = null;
        fileBlob.value = undefined;
        fileSrc.value = undefined;
        viewerComponent.value = undefined;
        firstWindow.value = undefined;
        error.value = null;
        loading.value = false;
        open.value = resolution;
        lang.value = resolution.kind === `code` || resolution.kind === `markdown` ? resolution.lang : undefined;

        onCleanup(() => {
            // Nobody is waiting for this file's text any more — stop paying for it mid-flight.
            reading?.abort();
        });

        const fail = (err: unknown): void => {
            if (id !== seq || superseded(err)) {
                return;
            }
            loading.value = false;
            if (err instanceof SandboxHttpError && err.status === 404) {
                emit(`gone`, currentPath);
                return;
            }
            error.value = errorMessage(err, `Could not load the file.`);
        };

        if (resolution.kind === `code` || resolution.kind === `markdown`) {
            loading.value = true;
            // Warm Monaco + the file's grammar concurrently with the fetch (CodeView awaits both before painting,
            // so this just hides the load behind the fetch). Markdown renders as prose (marked), but its Source
            // toggle is the same editor, and the resolution carries a grammar for it like any other text file.
            const textKind = resolution.kind;
            void ensureMonaco().then((monaco) => ensureLanguage(monaco, resolution.lang));
            readText(currentPath).then((window) => {
                const content = window.content;
                if (id !== seq) {
                    return;
                }
                loading.value = false;
                // An unknown-extension file that is actually binary: NUL bytes => download fallback, not mojibake.
                if (textKind === `code` && content.includes("\u0000")) {
                    open.value = { kind: `binary` };
                    return;
                }
                /* Too big to hold as an editable buffer — the editor keeps the whole text plus a baseline to diff
                 * it against, and a save posts all of it back, none of which a log wants. It opens windowed and
                 * read-only instead, seeded with the window just read: a 120MB log costs one bounded read. */
                if (window.size > TEXT_EDIT_MAX_BYTES) {
                    firstWindow.value = window;
                    open.value = { kind: `big-text`, lang: lang.value };
                    return;
                }
                // With the real size in hand, settle the tokenizer: the extension table, then the shebang the way
                // VSCode does for an extensionless script, and nothing at all over the highlight cap. Set before
                // `text` so CodeView mounts already colored.
                lang.value = highlightLangFor(currentPath, window.size, content);
                text.value = content;
                // Record the on-disk text so the editor can diff it for the dirty state (never clobbers live edits).
                edit.setBaseline(currentPath, content);
            }, fail);
            return;
        }

        /* An extension viewer claimed this file. Its component and its content are resolved TOGETHER, so the
         * pane paints once instead of flashing an empty viewer while the bytes arrive — and the fetch is
         * whichever kind the APPROVED MANIFEST declared, never the extension's choice at call time. */
        if (resolution.kind === `viewer`) {
            const { viewer } = resolution;
            loading.value = true;
            const content =
                viewer.fetch === `text`
                    ? readText(currentPath).then(({ content: body }) => ({ text: body }))
                    : viewer.fetch === `blob`
                      ? readBlob(currentPath).then((blob) => ({ blob }))
                      : mediaUrl(currentPath).then((src) => ({ src }));
            Promise.all([viewer.component(), content]).then(([component, loaded]) => {
                if (id !== seq) {
                    return;
                }
                loading.value = false;
                viewerComponent.value = component;
                // `text` doubles as the breadcrumb's Copy-content source, which is the right behaviour for a
                // viewer whose file IS text (an .svg): copying its markup is what that button should do there.
                text.value = `text` in loaded ? loaded.text : null;
                fileBlob.value = `blob` in loaded ? loaded.blob : undefined;
                fileSrc.value = `src` in loaded ? loaded.src : undefined;
            }, fail);
            return;
        }
        // binary / too-large / empty: nothing to fetch.
    },
    { immediate: true },
);

// Adopt the on-disk version after a "changed on disk" warning: re-read, set the buffer + baseline to disk (clears
// the dirty state), and bump the nonce so the uncontrolled editor remounts and reseeds. Discards the unsaved edits
// — an explicit choice the user makes by clicking Reload.
const reloadFromDisk = (): void => {
    staleOnDisk.value = false;
    readText(path).then(
        ({ content }) => {
            text.value = content;
            edit.markSaved(path, content);
            reloadNonce.value++;
        },
        (err) => {
            error.value = errorMessage(err, `Could not reload the file.`);
        },
    );
};

/* Save the file (the binary / too-large states, BigTextView, and any viewer's own can't-render fallback).
 *
 * Through /workspace/media rather than /workspace/raw, and NOT via a Blob: the daemon streams it and marks it
 * as an attachment, so the browser writes it straight to disk. Nothing is held in the tab, which is what
 * removes the 25 MiB ceiling the raw route imposes — a 700 MB recording downloads exactly like a 7 KB one, and
 * the "too large to preview here" state finally has a working button under it. */
const download = async (): Promise<void> => {
    try {
        const anchor = document.createElement(`a`);
        anchor.href = await mediaUrl(path, { download: true });
        anchor.click();
    } catch (err) {
        error.value = errorMessage(err, `Could not download the file.`);
    }
};

/* Inline editing (text files only). Read and edit are the same Monaco surface (readOnly toggles), seeded from
 * the file's live buffer (edits survive tab switches via useEditBuffers) or its on-disk text. Ctrl+S / Save
 * persists through the daemon's upload route; the tree refetch then refreshes size + the read view. */
const layout = useLayout();
const { saveText, run } = useWorkspaceTree();
// The editable CodeView instance — the toolbar Save button saves through its exposed save() so the toolbar and
// Ctrl+S run the same normalize-then-save path.
const editorView = ref<InstanceType<typeof CodeView>>();
// Mobile is read-only: touch code editing is error-prone and the agent (chat) is the edit path there, so the
// global edit mode is ignored and the Edit affordance hidden below 768px.
const { mobile } = useDevice();

const canEdit = computed(() => (open.value.kind === `code` || open.value.kind === `markdown`) && text.value !== null);
// Global edit mode (useLayout), gated per file by canEdit so a viewer's file (and every binary) stays in its
// viewer — including one whose file is text, like an .svg: an extension viewer renders, it does not edit.
const editingThis = computed(() => !mobile.value && layout.editMode.value && canEdit.value);
const dirtyThis = computed(() => edit.isDirty(path));
const editorSeed = computed(() => edit.bufferOf(path) ?? text.value ?? ``);

const onEditorChange = (value: string): void => edit.setBuffer(path, value);
// markSaved only runs if the write succeeded (run swallows the throw and shows the error instead). The save is
// GUARDED by the baseline's hash: the daemon 409s when the file changed on disk since we read it (an agent or
// terminal write the ~250ms SSE echo hasn't surfaced yet), so the save can't clobber that write — the 409 raises
// the same changed-on-disk banner the echo would, with the user's edits preserved in the buffer.
const onEditorSave = (value: string): void =>
    void run(async () => {
        const base = edit.baselineOf(path);
        try {
            await saveText(path, value, base === undefined ? undefined : await sha256Hex(base));
        } catch (err) {
            if (err instanceof SandboxHttpError && err.status === 409) {
                staleOnDisk.value = true;
                return;
            }
            throw err;
        }
        edit.markSaved(path, value);
    });
</script>

<template>
    <div class="flex h-full min-h-0 flex-col">
        <!-- Context bar: breadcrumb path + edit actions (text files only). The actions stay put across the
             post-save refetch via `|| editingThis`; the tab's dirty dot makes an "Unsaved" label redundant. -->
        <FileBreadcrumb :path="path" :meta="meta">
            <CopyButton v-if="text !== null" :text="editorSeed" aria-label="Copy file content" v-tooltip.bottom="'Copy content'" />
            <template v-if="!mobile && (canEdit || editingThis)">
                <span v-if="dirtyThis" class="inline-flex shrink-0 items-center text-warning" v-tooltip.bottom="'Unsaved changes — Ctrl+S to save'">
                    <Icon name="circle-fill" class="text-[0.4rem]" />
                </span>
                <template v-if="editingThis">
                    <button
                        type="button"
                        class="inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-2xs text-muted transition-colors hover:bg-overlay hover:text-content disabled:cursor-not-allowed disabled:opacity-40"
                        :disabled="!dirtyThis"
                        @click="editorView?.save()"
                        v-tooltip.bottom="'Save (Ctrl+S)'"
                    >
                        <Icon name="save" class="text-[0.7rem]" /> Save
                    </button>
                    <button
                        type="button"
                        class="inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-2xs text-muted transition-colors hover:bg-overlay hover:text-content"
                        @click="layout.setEditMode(false)"
                        v-tooltip.bottom="'Back to preview (keeps unsaved edits)'"
                    >
                        <Icon name="eye" class="text-[0.7rem]" /> Preview
                    </button>
                </template>
                <button
                    v-else
                    type="button"
                    class="inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-2xs text-muted transition-colors hover:bg-overlay hover:text-content"
                    @click="layout.setEditMode(true)"
                    v-tooltip.bottom="'Edit all files'"
                >
                    <Icon name="pencil" class="text-[0.7rem]" /> Edit
                </button>
            </template>
        </FileBreadcrumb>

        <!-- The open file changed on disk under unsaved edits: the buffer is kept; Reload adopts disk (discards edits). -->
        <div v-if="staleOnDisk" class="flex shrink-0 items-center gap-2 border-b border-warning/40 bg-warning/10 px-3 py-1.5 text-2xs text-warning">
            <Icon name="exclamation-triangle" class="text-[0.7rem]" />
            <span class="flex-1">This file changed on disk. Your unsaved edits are preserved.</span>
            <button
                type="button"
                class="inline-flex items-center gap-1 rounded-md px-2 py-1 text-warning transition-colors hover:bg-warning/20"
                @click="reloadFromDisk"
            >
                <Icon name="refresh" class="text-[0.7rem]" /> Reload from disk
            </button>
        </div>

        <div class="relative min-h-0 flex-1">
            <CodeView
                v-if="editingThis"
                ref="editorView"
                :key="`${path}:${reloadNonce}`"
                editable
                :path="path"
                :code="editorSeed"
                :lang="lang"
                :scroll-to-line="line"
                @change="onEditorChange"
                @save="onEditorSave"
            />
            <div v-else-if="error" class="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
                <Icon name="exclamation-triangle" class="text-3xl text-danger" />
                <p class="text-sm text-danger">{{ error }}</p>
            </div>
            <div v-else-if="loading" class="flex h-full items-center justify-center text-muted">
                <Icon name="spinner" class="text-xl" spin />
            </div>
            <template v-else>
                <CodeView v-if="open.kind === 'code' && text !== null" :path="path" :code="text" :lang="lang" :scroll-to-line="line" />
                <MarkdownViewer v-else-if="open.kind === 'markdown' && text !== null" :source="text" :path="path" :line="line" />
                <!-- Over the editable cap: windowed, read-only, seeded with the window the read above already got. -->
                <BigTextView v-else-if="open.kind === 'big-text' && firstWindow" :path="path" :first="firstWindow" @download="download" />
                <!-- Whatever a viewers extension contributed. It gets the path plus exactly one content prop,
                     decided by its manifest's `fetch`; `download` is the host's, so every viewer's own
                     can't-render fallback reaches the same authenticated byte fetch the states below use. -->
                <component
                    :is="viewerComponent"
                    v-else-if="viewerComponent"
                    :path="path"
                    :text="text ?? undefined"
                    :blob="fileBlob"
                    :src="fileSrc"
                    @download="download"
                />
                <FileUnsupported v-else-if="open.kind === 'too-large'" mode="too-large" :size="meta?.size" @download="download" />
                <FileUnsupported v-else-if="open.kind === 'empty'" mode="empty" />
                <!-- Everything left: a known binary, and the one shape that should be unreachable — a viewer
                     that resolved but produced no component. Both are files whose bytes we can only hand over. -->
                <FileUnsupported v-else mode="binary" @download="download" />
            </template>
        </div>
    </div>
</template>
