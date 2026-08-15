<script setup lang="ts">
import type { WorkspaceFileWindow, WorkspaceTreeEntry } from "@intentic-app/api-contract";
import { CopyButton, useDevice } from "@intentic/ui";
import { errorMessage } from "@intentic/ui/async";
import { computed, ref, shallowRef, watch, type Component } from "vue";
import { sandboxBlob, SandboxHttpError } from "../../../composables/sandbox/sandboxClient";
import { sha256Hex } from "../../../composables/workspace/contentHash";
import { readFileWindow } from "../../../composables/workspace/fileWindow";
import { mediaUrl } from "../../../composables/workspace/mediaUrl";
import { useEditBuffers } from "../../../composables/workspace/useEditBuffers";
import { useLayout } from "../../../composables/useLayout";
import { useMonaco } from "../../../composables/workspace/useMonaco";
import { changeEpochOf } from "../../../composables/workspace/useWorkspaceLive";
import { useWorkspaceTree } from "../../../composables/workspace/useWorkspaceTree";
import { scopeQuery, workspaceAgent } from "../../../composables/workspace/workspaceScope";
import BigTextView from "./BigTextView.vue";
import CodeView from "./CodeView.vue";
import FileBreadcrumb from "../FileBreadcrumb.vue";
import FileLocked from "./FileLocked.vue";
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
// The open file was deleted on disk (the read came back with nothing there) — the parent closes this tab rather
// than leaving a "not found" panel. Only fires for a clean read; a dirty file's re-read is skipped (staleOnDisk)
// so edits survive.
const emit = defineEmits<{ gone: [path: string] }>();

// Which surface is open — starts from resolveOpenFile(), but a `code` file whose bytes contain NUL is switched
// to `binary` after the read (an unknown-extension binary, shown as a download instead of mojibake), and one
// over the editable cap to `big-text`.
const open = ref<OpenFile>({ kind: `empty` });
const lang = ref<string | undefined>(undefined);
const text = ref<string | null>(null);
/* Content for the resolved extension viewer: exactly the ONE prop its manifest's `fetch` named, held in the
 * shape the fetch produced rather than split into a slot per kind. The split was a trap. It passed the two
 * kinds a viewer never asked for as `undefined`, and an undefined prop is still a fallthrough ATTR — which Vue
 * merges OVER the bindings of a viewer whose root is itself a component. That is how `src: undefined` reached
 * the image viewer's <ImageView> and erased the object URL it had just minted from the bytes: every .png and
 * .webp opened as an empty transparency checkerboard, with no error anywhere to say why.
 *
 * Nothing here needs revoking: a `blob` viewer owns whatever object URL it makes of the bytes, and a `url`
 * viewer is handed a plain string. */
const viewerContent = shallowRef<{ text: string } | { blob: Blob } | { src: string } | undefined>(undefined);
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

const readBlob = (target: string): Promise<Blob> => sandboxBlob(`/workspace/raw?${scopeQuery(new URLSearchParams({ path: target })).toString()}`);

let seq = 0;
/* The current text read. Aborted whenever another one supersedes it — a file switch, or the next change-epoch
 * reconcile. Without this, a file being appended to (a build log, a report an agent is writing) queued a fresh
 * whole-file read every 250ms batch with nothing cancelling the last one: requests piled up in flight, each
 * holding the file's text, and the daemon paid for every one of them. */
let reading: AbortController | undefined;
// The window a big text file opened with, handed to BigTextView so it doesn't re-read what we already have.
const firstWindow = ref<WorkspaceFileWindow | undefined>(undefined);
/* This file came from the SHARED tree even though the view is scoped to a conversation's copy — which is
 * legitimate and common: a checkout mirrors the /work layout but is not a superset of it (the shared state
 * dir, the reference shelf, anything under /work no repo tracks). The banner says "showing X's copy", so the
 * exceptions have to say so themselves or that sentence quietly becomes false one file at a time.
 *
 * Text reads only, because only they carry the daemon's answer (WorkspaceFileSchema.shared) — a binary
 * preview is bytes with no room for it. So the chip appearing is a fact; its absence is not a claim. */
const fromShared = ref(false);

/* THE ONE SURFACE FOR WHICH A MISSING FILE IS EXCEPTIONAL. Everywhere else in the app a read of a path with
 * nothing at it is an ordinary answer (see readFileWindow), and this view is the exception that proves the rule:
 * the file is open in a tab, so it being gone is news. Turning that answer back into a rejection right here
 * means every failure path below handles it in the one place it already handles a failed read, rather than each
 * of the five call sites growing a branch for it. */
class FileGone extends Error {}
const gone = (err: unknown): boolean => err instanceof FileGone;

const readText = async (target: string): Promise<WorkspaceFileWindow> => {
    reading?.abort();
    reading = new AbortController();
    const window = await readFileWindow(target, { signal: reading.signal });
    if (!window.present) {
        throw new FileGone();
    }
    return window;
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
            if (gone(err)) {
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
    // The SCOPE is a trigger for the same reason the path is: the same path in another copy of the workspace is
    // another file, and leaving the old text on screen would be the silent wrong answer in miniature.
    () => [path, changeEpochOf(path), workspaceAgent.value] as const,
    ([currentPath], previous, onCleanup) => {
        // A same-path re-fire in an editable text view reconciles by content (no flicker, no false warning);
        // everything else (a new file, a scope switch, or a non-text mode) takes the destructive reset + fetch
        // below.
        if (
            previous !== undefined &&
            currentPath === previous[0] &&
            workspaceAgent.value === previous[2] &&
            (open.value.kind === `code` || open.value.kind === `markdown`)
        ) {
            reconcileOpenFile(currentPath);
            return;
        }
        const resolution = resolveOpenFile(currentPath, meta?.size);
        const id = ++seq;

        staleOnDisk.value = false;
        text.value = null;
        viewerContent.value = undefined;
        viewerComponent.value = undefined;
        firstWindow.value = undefined;
        fromShared.value = false;
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
            // A text read reports "nothing there" in its answer (FileGone). A binary preview and a media ticket
            // have no envelope to report it in — raw bytes and a mint still 404 — and to this view the two mean
            // exactly the same thing: the tab is open on a file that is not there any more.
            if (gone(err) || (err instanceof SandboxHttpError && err.status === 404)) {
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
                fromShared.value = window.shared;
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
                // Record the on-disk text so the editor can diff it for the dirty state (never clobbers live
                // edits). Skipped in a scope: buffers are keyed by path alone, so seeding one from a
                // conversation's copy would leave that text standing in for the shared file the moment the
                // reader switches back — and nothing scoped is editable anyway.
                if (workspaceAgent.value === undefined) {
                    edit.setBaseline(currentPath, content);
                }
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
                viewerContent.value = loaded;
                // `text` doubles as the breadcrumb's Copy-content source, which is the right behaviour for a
                // viewer whose file IS text (an .svg): copying its markup is what that button should do there.
                text.value = `text` in loaded ? loaded.text : null;
            }, fail);
            return;
        }
        // binary / too-large / empty / locked: nothing to fetch. The last of them is the only one that is a
        // REFUSAL rather than an inability, and it costs no request to honour — which is the point: a read the
        // daemon would decline is never issued, so the tab settles on its explanation instead of closing itself.
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
const { editMode, setEditMode, hideFileComments, toggleHideFileComments } = useLayout();
const { saveText, run } = useWorkspaceTree();
// The editable CodeView instance — the toolbar Save button saves through its exposed save() so the toolbar and
// Ctrl+S run the same normalize-then-save path.
const editorView = ref<InstanceType<typeof CodeView>>();
// Mobile is read-only: touch code editing is error-prone and the agent (chat) is the edit path there, so the
// global edit mode is ignored and the Edit affordance hidden below 768px.
const { mobile } = useDevice();

/* Editing is off while the view is showing a conversation's own copy (workspaceScope). The daemon refuses a
 * write into a checkout by construction — no write route can even name one — so a Save here would silently go
 * to the SHARED tree's file of the same path, which is the exact confusion this scope exists to end. And the
 * agent may be writing to that file right now: two writers on one worktree file lose each other's work with
 * nothing to notice it. Read-only is stated in the banner above, so the missing Edit button is explained
 * rather than merely absent. */
const canEdit = computed(
    () => workspaceAgent.value === undefined && (open.value.kind === `code` || open.value.kind === `markdown`) && text.value !== null,
);
// Global edit mode (useLayout), gated per file by canEdit so a viewer's file (and every binary) stays in its
// viewer — including one whose file is text, like an .svg: an extension viewer renders, it does not edit.
const editingThis = computed(() => !mobile.value && editMode.value && canEdit.value);
// Reading the code alone is offered where there is code to isolate: a text file on the editor surface, being
// READ. Editing shows the file whole — the buffer that gets saved is never the stripped one.
const canHideComments = computed(() => open.value.kind === `code` && text.value !== null && !editingThis.value);
// In a scope the file on screen is disk, not a buffer: an unsaved edit to the SHARED file of the same path is
// somebody else's text, and showing it here (or its dirty dot) would misattribute it to this agent's copy.
const dirtyThis = computed(() => workspaceAgent.value === undefined && edit.isDirty(path));
const editorSeed = computed(() => (workspaceAgent.value === undefined ? (edit.bufferOf(path) ?? text.value ?? ``) : (text.value ?? ``)));

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
        // The read view shows `text`, not the buffer: adopt the saved text too, or switching back to preview
        // shows the file as it was BEFORE the save (the reconcile echo no-ops against the new baseline).
        text.value = value;
    }, `Couldn't save your changes.`);
</script>

<template>
    <div class="flex h-full min-h-0 flex-col">
        <!-- Context bar: breadcrumb path + edit actions (text files only). The actions stay put across the
             post-save refetch via `|| editingThis`; the tab's dirty dot makes an "Unsaved" label redundant. -->
        <FileBreadcrumb :path="path" :meta="meta">
            <!-- The diff surface's Comments toggle, in the bar that reads a file — same words, same eye, so the
                 two surfaces are one habit. It reads the other way round here (comments start SHOWN) because
                 opening a file asks what it says, and the gutter keeps the file's own line numbers either way. -->
            <button
                v-if="canHideComments"
                type="button"
                class="inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-2xs text-muted transition-colors hover:bg-overlay hover:text-content"
                :class="{ 'bg-primary-600/15 text-link': hideFileComments }"
                :aria-pressed="hideFileComments"
                @click="toggleHideFileComments()"
                v-tooltip.bottom="hideFileComments ? 'Comments hidden — click to show them' : 'Hide comments — read the code alone'"
            >
                <Icon :name="hideFileComments ? 'eye-slash' : 'eye'" class="text-[0.7rem]" />
                <span class="max-md:hidden">Comments</span>
            </button>
            <!-- The banner above says the view is showing an agent's copy; this file is one that copy doesn't
                 carry, so it comes from the shared workspace. Said here rather than there because it is a fact
                 about this file, not about the view. -->
            <span
                v-if="workspaceAgent !== undefined && fromShared"
                class="inline-flex shrink-0 items-center gap-1 rounded-md bg-overlay px-1.5 py-0.5 text-2xs text-muted"
                v-tooltip.bottom="'This agent’s copy doesn’t have this file, so you’re seeing the shared workspace’s.'"
            >
                <Icon name="folder" class="text-[0.65rem]" /> Shared
            </span>
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
                        @click="setEditMode(false)"
                        v-tooltip.bottom="'Back to preview (keeps unsaved edits)'"
                    >
                        <Icon name="eye" class="text-[0.7rem]" /> Preview
                    </button>
                </template>
                <button
                    v-else
                    type="button"
                    class="inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-2xs text-muted transition-colors hover:bg-overlay hover:text-content"
                    @click="setEditMode(true)"
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
                <CodeView
                    v-if="open.kind === 'code' && text !== null"
                    :path="path"
                    :code="text"
                    :lang="lang"
                    :scroll-to-line="line"
                    :hide-comments="hideFileComments"
                />
                <MarkdownViewer v-else-if="open.kind === 'markdown' && text !== null" :source="text" :path="path" :line="line" />
                <!-- Over the editable cap: windowed, read-only, seeded with the window the read above already got. -->
                <BigTextView v-else-if="open.kind === 'big-text' && firstWindow" :path="path" :first="firstWindow" @download="download" />
                <!-- Whatever a viewers extension contributed. It gets the path plus exactly one content prop,
                     decided by its manifest's `fetch` (viewerContent — never the other kinds as `undefined`);
                     `download` is the host's, so every viewer's own can't-render fallback reaches the same
                     authenticated byte fetch the states below use. -->
                <component :is="viewerComponent" v-else-if="viewerComponent" :path="path" v-bind="viewerContent" @download="download" />
                <FileUnsupported v-else-if="open.kind === 'too-large'" mode="too-large" :size="meta?.size" @download="download" />
                <FileUnsupported v-else-if="open.kind === 'empty'" mode="empty" />
                <!-- The sandbox keeps this one to itself. Nothing was fetched to find that out (resolveOpenFile
                     answers from the path), so the tab opens straight onto the explanation. -->
                <FileLocked v-else-if="open.kind === 'locked'" :path="path" />
                <!-- Everything left: a known binary, and the one shape that should be unreachable — a viewer
                     that resolved but produced no component. Both are files whose bytes we can only hand over. -->
                <FileUnsupported v-else mode="binary" @download="download" />
            </template>
        </div>
    </div>
</template>
