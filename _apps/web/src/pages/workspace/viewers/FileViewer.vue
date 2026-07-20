<script setup lang="ts">
import type { WorkspaceFileResponse, WorkspaceTreeEntry } from "@intentic-app/api-contract";
import { CopyButton, useDevice } from "@intentic-app/ui";
import { computed, ref, shallowRef, watch, type Component } from "vue";
import { viewerForExtension } from "../../../core-views/viewerRegistry";
import { sandboxBlob, SandboxHttpError, sandboxJson } from "../../../composables/sandbox/sandboxClient";
import { errorMessage } from "../../../composables/useAsyncAction";
import { useEditBuffers } from "../../../composables/workspace/useEditBuffers";
import { useLayout } from "../../../composables/useLayout";
import { useMonaco } from "../../../composables/workspace/useMonaco";
import { changeEpochOf } from "../../../composables/workspace/useWorkspaceLive";
import { useWorkspaceTree } from "../../../composables/workspace/useWorkspaceTree";
import CodeView from "./CodeView.vue";
import FileBreadcrumb from "../FileBreadcrumb.vue";
import FileUnsupported from "./FileUnsupported.vue";
import { langFromShebang, resolveFile, type ViewMode } from "../fileType";
import type { LineJump } from "../workspaceTabs";
import MarkdownViewer from "./MarkdownViewer.vue";
import SvgViewer from "./SvgViewer.vue";

/* Dispatches one open file to the right renderer (code / markdown / svg / image / pdf / fallback) and owns the
 * fetch. The authenticated blob lifecycle lives here: image/pdf bytes are fetched via the sandbox client
 * (Bearer auth, so they can't go straight into <img src>), turned into a blob: object URL, and REVOKED on
 * file-change or unmount via the watcher's cleanup — leak-safe. A monotonic seq guard drops stale async
 * results when the user switches files mid-fetch. <object :data> takes the blob: URL directly. */

// `line` = jump the viewer to this line (a content-search match); undefined for a plain open.
const { path, meta, line } = defineProps<{ path: string; meta?: WorkspaceTreeEntry; line?: LineJump }>();
// The open file was deleted on disk (daemon read 404s) — the parent closes this tab rather than leaving a
// "not found" panel. Only fires for a clean read; a dirty file's re-read is skipped (staleOnDisk) so edits survive.
const emit = defineEmits<{ gone: [path: string] }>();

// Effective render mode — starts from resolveFile(), but a `code` file whose bytes contain NUL is switched to
// `binary` after the read (an unknown-extension binary, shown as a download instead of mojibake).
const mode = ref<ViewMode>(`empty`);
const lang = ref<string | undefined>(undefined);
const text = ref<string | null>(null);
const blobUrl = ref<string | null>(null);
// Raw bytes handed to the registered extension viewer (docx/xlsx) to parse; the viewer owns its own render
// lifecycle, so unlike blobUrl there is no object URL to revoke here.
const fileBlob = ref<Blob | undefined>(undefined);
// The extension viewer component (contributes.viewers) that renders docx/xlsx — resolved from the registry on
// open, alongside the blob. The host owns the fetch; the component only renders the bytes it's handed.
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

const readFile = async (target: string): Promise<string> => {
    const body = await sandboxJson<WorkspaceFileResponse>(`/workspace/file?path=${encodeURIComponent(target)}`);
    return body.content;
};
const readBlob = (target: string): Promise<Blob> => sandboxBlob(`/workspace/raw?path=${encodeURIComponent(target)}`);

let seq = 0;
// A same-path re-fire in an editable text view is a POSSIBLE external change — but it's also how the user's own
// save echoes back (upload → daemon file-watch → /events SSE → changeEpochOf bump). Reconcile by content instead
// of blindly resetting: re-read quietly (never null `text`, so no flicker), then act only on a real difference
// from the baseline we last knew on disk. After a save, baseline === disk, so the self-echo is a no-op.
const reconcileOpenFile = (currentPath: string): void => {
    const id = ++seq;
    readFile(currentPath).then(
        (content) => {
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
                mode.value = `binary`;
                return;
            }
            text.value = content;
            edit.markSaved(currentPath, content);
            reloadNonce.value++;
        },
        (err) => {
            if (id !== seq) {
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
        if (previous !== undefined && currentPath === previous[0] && (mode.value === `code` || mode.value === `markdown`)) {
            reconcileOpenFile(currentPath);
            return;
        }
        const resolution = resolveFile(currentPath, meta?.size);
        const id = ++seq;

        staleOnDisk.value = false;
        text.value = null;
        blobUrl.value = null;
        fileBlob.value = undefined;
        viewerComponent.value = undefined;
        error.value = null;
        loading.value = false;
        mode.value = resolution.mode;
        lang.value = resolution.lang;

        // Owns the object URL created in this run; revoked on the next file-change and on unmount.
        let createdUrl: string | undefined;
        onCleanup(() => {
            if (createdUrl !== undefined) {
                URL.revokeObjectURL(createdUrl);
            }
        });

        const fail = (err: unknown): void => {
            if (id !== seq) {
                return;
            }
            loading.value = false;
            if (err instanceof SandboxHttpError && err.status === 404) {
                emit(`gone`, currentPath);
                return;
            }
            error.value = errorMessage(err, `Could not load the file.`);
        };

        if (resolution.mode === `code` || resolution.mode === `markdown`) {
            loading.value = true;
            // Warm Monaco + the file's grammar concurrently with the fetch (CodeView awaits both before painting,
            // so this just hides the load behind the fetch). Markdown renders as prose (marked); warm the markdown
            // grammar for its Source toggle.
            void ensureMonaco().then((monaco) => ensureLanguage(monaco, resolution.mode === `markdown` ? `markdown` : resolution.lang));
            readFile(currentPath).then((content) => {
                if (id !== seq) {
                    return;
                }
                loading.value = false;
                // An unknown-extension file that is actually binary: NUL bytes ⇒ download fallback, not mojibake.
                if (resolution.mode === `code` && content.includes("\u0000")) {
                    mode.value = `binary`;
                    return;
                }
                // The filename resolved no language (extensionless `intentic-machine-boot`, `run`, …): fall back
                // to the shebang the way VSCode does. Set before `text` so CodeView mounts already colored.
                if (resolution.mode === `code` && lang.value === undefined) {
                    lang.value = langFromShebang(content);
                }
                text.value = content;
                // Record the on-disk text so the editor can diff it for the dirty state (never clobbers live edits).
                edit.setBaseline(currentPath, content);
            }, fail);
            return;
        }

        if (resolution.mode === `svg`) {
            loading.value = true;
            readFile(currentPath).then((content) => {
                if (id !== seq) {
                    return;
                }
                loading.value = false;
                text.value = content;
                // Render via a blob: URL built from the text (image context → embedded scripts inert). One fetch.
                createdUrl = URL.createObjectURL(new Blob([content], { type: `image/svg+xml` }));
                blobUrl.value = createdUrl;
            }, fail);
            return;
        }

        // image / pdf / audio: byte fetch → object URL rendered by a native <img>/<object>/<audio>.
        if (resolution.mode === `image` || resolution.mode === `pdf` || resolution.mode === `audio`) {
            loading.value = true;
            readBlob(currentPath).then((blob) => {
                if (id !== seq) {
                    return;
                }
                loading.value = false;
                createdUrl = URL.createObjectURL(blob);
                blobUrl.value = createdUrl;
            }, fail);
            return;
        }

        // docx / xlsx: an extension viewer (contributes.viewers) renders the bytes. The host resolves the
        // registered component and fetches the blob in parallel, then hands the component the bytes to render.
        if (resolution.mode === `docx` || resolution.mode === `xlsx`) {
            loading.value = true;
            const viewer = viewerForExtension(resolution.mode);
            Promise.all([viewer?.component(), readBlob(currentPath)]).then(([component, blob]) => {
                if (id !== seq) {
                    return;
                }
                loading.value = false;
                viewerComponent.value = component;
                fileBlob.value = blob;
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
    readFile(path).then(
        (content) => {
            text.value = content;
            edit.markSaved(path, content);
            reloadNonce.value++;
        },
        (err) => {
            error.value = errorMessage(err, `Could not reload the file.`);
        },
    );
};

// Fetch the raw bytes and save them (used by the binary/too-large/PDF fallbacks). A short-lived object URL,
// revoked right after the click. Files over the daemon's raw cap surface its 413 message as an error.
const download = async (): Promise<void> => {
    try {
        const blob = await readBlob(path);
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement(`a`);
        anchor.href = url;
        anchor.download = path.slice(path.lastIndexOf(`/`) + 1);
        anchor.click();
        URL.revokeObjectURL(url);
    } catch (err) {
        error.value = errorMessage(err, `Could not download the file.`);
    }
};

/* Inline editing (text files only). Read and edit are the same Monaco surface (readOnly toggles), seeded from
 * the file's live buffer (edits survive tab switches via useEditBuffers) or its on-disk text. Ctrl+S / Save
 * persists through the daemon's upload route; the tree refetch then refreshes size + the read view. */
const layout = useLayout();
const { saveText, run } = useWorkspaceTree();
// Mobile is read-only: touch code editing is error-prone and the agent (chat) is the edit path there, so the
// global edit mode is ignored and the Edit affordance hidden below 768px.
const { mobile } = useDevice();

const canEdit = computed(() => (mode.value === `code` || mode.value === `markdown`) && text.value !== null);
// Global edit mode (useLayout), gated per file by canEdit so images/PDFs/binaries stay in their viewer.
const editingThis = computed(() => !mobile.value && layout.editMode.value && canEdit.value);
const dirtyThis = computed(() => edit.isDirty(path));
// CodeMirror grammar: markdown mode carries no Shiki lang id, so name it explicitly; code mode reuses the id.
const editorLang = computed(() => (mode.value === `markdown` ? `markdown` : lang.value));
const editorSeed = computed(() => edit.bufferOf(path) ?? text.value ?? ``);

const onEditorChange = (value: string): void => edit.setBuffer(path, value);
// markSaved only runs if the write succeeded (run swallows the throw and shows the error instead).
const onEditorSave = (value: string): void =>
    void run(async () => {
        await saveText(path, value);
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
                        @click="onEditorSave(edit.bufferOf(path) ?? text ?? '')"
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
                :key="`${path}:${reloadNonce}`"
                editable
                :path="path"
                :code="editorSeed"
                :lang="editorLang"
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
                <CodeView v-if="mode === 'code' && text !== null" :path="path" :code="text" :lang="lang" :scroll-to-line="line" />
                <MarkdownViewer v-else-if="mode === 'markdown' && text !== null" :source="text" :line="line" />
                <SvgViewer v-else-if="mode === 'svg' && text !== null && blobUrl" :src="blobUrl" :source="text ?? ''" />
                <div
                    v-else-if="mode === 'image' && blobUrl"
                    class="image-checker scrollbar-thin flex h-full items-center justify-center overflow-auto p-4"
                >
                    <img :src="blobUrl" alt="" class="max-h-full max-w-full object-contain" />
                </div>
                <object v-else-if="mode === 'pdf' && blobUrl" :data="blobUrl" type="application/pdf" class="h-full w-full">
                    <div class="flex h-full flex-col items-center justify-center gap-3 text-center text-muted">
                        <p class="text-sm">This PDF can't be displayed inline.</p>
                        <button
                            type="button"
                            class="inline-flex items-center gap-2 rounded-md border border-line px-3 py-1.5 text-xs text-content hover:bg-overlay"
                            @click="download"
                        >
                            <Icon name="download" class="text-xs" /> Download
                        </button>
                    </div>
                </object>
                <div v-else-if="mode === 'audio' && blobUrl" class="flex h-full items-center justify-center p-6">
                    <audio :src="blobUrl" controls class="w-full max-w-xl" />
                </div>
                <component :is="viewerComponent" v-else-if="(mode === 'docx' || mode === 'xlsx') && viewerComponent && fileBlob" :blob="fileBlob" />
                <FileUnsupported v-else-if="mode === 'docx' || mode === 'xlsx'" mode="binary" @download="download" />
                <FileUnsupported v-else-if="mode === 'too-large'" mode="too-large" :size="meta?.size" @download="download" />
                <FileUnsupported v-else-if="mode === 'binary'" mode="binary" @download="download" />
                <FileUnsupported v-else mode="empty" />
            </template>
        </div>
    </div>
</template>
