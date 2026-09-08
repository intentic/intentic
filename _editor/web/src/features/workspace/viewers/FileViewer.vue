<script setup lang="ts">
import type { WorkspaceFileWindow, WorkspaceTreeEntry } from "@intentic/api-contract";
import { Button, CopyButton, useDevice } from "@intentic/ui";
import { errorMessage } from "@intentic/ui/async";
import { computed, ref, shallowRef, watch, type Component } from "vue";
import { sandboxBlob, SandboxHttpError } from "../../sandbox/client/sandboxClient";
import { sha256Hex } from "../files/contentHash";
import { readFileWindow } from "../files/fileWindow";
import { mediaUrl } from "../files/mediaUrl";
import { useEditBuffers } from "../files/useEditBuffers";
import { useLayout } from "../../../shell/window/useLayout";
import { useMonaco } from "../files/useMonaco";
import { changeEpochOf } from "../changes/useWorkspaceLive";
import { useWorkspaceTree } from "../explorer/useWorkspaceTree";
import { scopeQuery, workspaceAgent } from "../health/workspaceScope";
import { useScopeTitle } from "../health/scopeTitle";
import BigTextView from "./BigTextView.vue";
import CodeView from "./CodeView.vue";
import FileBreadcrumb from "../explorer/FileBreadcrumb.vue";
import FileLocked from "./FileLocked.vue";
import FileUnsupported from "./FileUnsupported.vue";
import { highlightLangFor } from "@intentic/code-read";
import { TEXT_EDIT_MAX_BYTES } from "../explorer/fileType";
import type { LineJump } from "../tabs/workspaceTabs";
import MarkdownViewer from "./MarkdownViewer.vue";
import { resolveOpenFile, type OpenFile } from "./openFile";

// Dispatches an open file to its surface (editor, an extension's viewer, or a can't-show state) and owns the
// fetch, since daemon routes are Bearer-authenticated and a browser can't do that itself. The read's true size,
// not the tree entry's, decides editable vs. windowed text; a seq + AbortController drop stale reads.

// `line` = jump the viewer to this line (a content-search match); undefined for a plain open.
const { path, meta, line } = defineProps<{ path: string; meta?: WorkspaceTreeEntry; line?: LineJump }>();
// Fires when the file is gone on disk, so the parent closes the tab; skipped for a dirty file (staleOnDisk).
const emit = defineEmits<{ gone: [path: string] }>();

// Which surface: from resolveOpenFile(), switched to `binary` on NUL bytes or `big-text` past the cap.
const open = ref<OpenFile>({ kind: `empty` });
const lang = ref<string | undefined>(undefined);
const text = ref<string | null>(null);
// Held in the shape produced, not split into optional props: an unset prop still falls through as an attr.
const viewerContent = shallowRef<{ text: string } | { blob: Blob } | { src: string } | undefined>(undefined);
// The extension viewer component itself, lazily imported alongside its content.
const viewerComponent = shallowRef<Component | undefined>(undefined);
const loading = ref(false);
const error = ref<string | null>(null);
// Set when the file changed on disk with unsaved edits: buffer kept, Reload offered instead of overwriting.
const staleOnDisk = ref(false);
// Bumped by Reload to remount the editable surface (uncontrolled, seeded via :key) from disk text.
const reloadNonce = ref(0);
// Edit buffers: the read trigger's dirty-guard below reads this, so it must exist before the watch.
const edit = useEditBuffers();
// Warms Monaco + grammar alongside the fetch, so CodeView paints coloured immediately, no flash.
const { ensureMonaco, ensureLanguage } = useMonaco();

const readBlob = (target: string): Promise<Blob> => sandboxBlob(`/workspace/raw?${scopeQuery(new URLSearchParams({ path: target })).toString()}`);

let seq = 0;
// Current text read, aborted whenever superseded, so an appending file can't queue unbounded reads.
let reading: AbortController | undefined;
// Window a big-text file opened with, handed to BigTextView so it needn't re-read what's already had.
const firstWindow = ref<WorkspaceFileWindow | undefined>(undefined);
// True when this file came from the shared tree despite a scoped view; text reads only carry this fact.
const fromShared = ref(false);

// The one surface where a missing file is exceptional: elsewhere a read of nothing is ordinary, but an open tab
// going missing is news, handled once here instead of at every call site.
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
// An aborted read is this component replacing its own request: never an error to show the user.
const superseded = (err: unknown): boolean => err instanceof DOMException && err.name === `AbortError`;
// A same-path refire is either an external change or the user's own save echo; reconciled by content, not a
// reset (no flicker), against the last known disk baseline. A save sets baseline = disk, so the echo no-ops.
const reconcileOpenFile = (currentPath: string): void => {
    const id = ++seq;
    readText(currentPath).then(
        ({ content }) => {
            if (id !== seq) {
                return;
            }
            // Equal to the last known disk baseline: a save echo or no-op touch, leave the view alone.
            if (content === edit.baselineOf(currentPath)) {
                return;
            }
            // Equal to the live buffer: disk caught up to the user's text; mark saved, no warning needed.
            if (content === edit.bufferOf(currentPath)) {
                edit.markSaved(currentPath, content);
                return;
            }
            // A genuine external edit landed while the user has unsaved work: keep the buffer, offer Reload.
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
    // changeEpochOf is the complete change signal; the tree's size isn't a trigger, or a post-save refetch would
    // race markSaved. Scope is a trigger too: the same path in another copy is a different file.
    () => [path, changeEpochOf(path), workspaceAgent.value] as const,
    ([currentPath], previous, onCleanup) => {
        // Same-path re-fire in an editable view reconciles by content; anything else resets and re-fetches below.
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
            // Nobody is waiting for this file's text any more: stop paying for it mid-flight.
            reading?.abort();
        });

        const fail = (err: unknown): void => {
            if (id !== seq || superseded(err)) {
                return;
            }
            loading.value = false;
            // Text reports missing via FileGone; a binary/media fetch just 404s instead. Both mean the file is gone.
            if (gone(err) || (err instanceof SandboxHttpError && err.status === 404)) {
                emit(`gone`, currentPath);
                return;
            }
            error.value = errorMessage(err, `Could not load the file.`);
        };

        if (resolution.kind === `code` || resolution.kind === `markdown`) {
            loading.value = true;
            // Warms Monaco/grammar alongside the fetch; markdown's Source toggle is the same editor, grammar and all.
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
                // Too big for an editable buffer; opens windowed instead, seeded with the window already read.
                if (window.size > TEXT_EDIT_MAX_BYTES) {
                    firstWindow.value = window;
                    open.value = { kind: `big-text`, lang: lang.value };
                    return;
                }
                // Settles the tokenizer with the real size now known; set before `text` so CodeView mounts coloured.
                lang.value = highlightLangFor(currentPath, window.size, content);
                text.value = content;
                // Skipped in scope, since a path-keyed buffer would mislabel the shared file.
                if (workspaceAgent.value === undefined) {
                    edit.setBaseline(currentPath, content);
                }
            }, fail);
            return;
        }

        // Component and content resolve together, painting once; fetch kind is the manifest's, not the extension's.
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
                // `text` doubles as the Copy-content source, right for a text-backed viewer (.svg) copying its markup.
                text.value = `text` in loaded ? loaded.text : null;
            }, fail);
            return;
        }
        // binary/too-large/empty/locked: nothing fetched; locked is a refusal, not an inability, no request made.
    },
    { immediate: true },
);

// Adopts the on-disk version after a stale-on-disk warning: re-reads, sets buffer + baseline to disk, bumps the
// nonce so the editor remounts. Discards unsaved edits, an explicit choice via Reload.
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

// Via /workspace/media, not /workspace/raw or a Blob: the daemon streams it as an attachment straight to disk,
// so nothing is held in the tab and the 25 MiB raw-route ceiling doesn't apply.
const download = async (): Promise<void> => {
    try {
        const anchor = document.createElement(`a`);
        anchor.href = await mediaUrl(path, { download: true });
        anchor.click();
    } catch (err) {
        error.value = errorMessage(err, `Could not download the file.`);
    }
};

// Inline editing (text only): read and edit share one Monaco surface (readOnly toggles), seeded from the live
// buffer or disk text. Ctrl+S/Save persists via upload; the tree refetch then refreshes size and the read view.
const { editMode, setEditMode, hideFileComments, toggleHideFileComments } = useLayout();
const { saveText, run, canEditFiles } = useWorkspaceTree();
// Editable CodeView instance; toolbar Save calls its exposed save(), so toolbar and Ctrl+S share one path.
const editorView = ref<InstanceType<typeof CodeView>>();
// Markdown surface, same reason: its Save must fold the open paragraph back in first, so only it can do that.
const markdownView = ref<InstanceType<typeof MarkdownViewer>>();
// Mobile is read-only: touch editing is error-prone, and chat is the edit path there; Edit hides below 768px.
const { mobile } = useDevice();

// Whether this surface can put a caret in the file, scope aside; split from `canEdit` since one decides the
// Edit button, the other whether its absence needs explaining.
const editableKind = computed(() => (open.value.kind === `code` || open.value.kind === `markdown`) && text.value !== null);
// Off in a scope: the daemon can't write into a checkout at all, so a Save here would silently hit the shared
// file of the same path, possibly racing the agent's own writes to it.
const canEdit = computed(() => canEditFiles.value && workspaceAgent.value === undefined && editableKind.value);
// Reason lives here, on the row where the Edit button would be, since that's where a reader would look for it.
// Two causes for one chip: tier (checked first, outranks scope) or scope, either can disable Edit.
const scopedReadOnly = computed(() => !mobile.value && editableKind.value && (!canEditFiles.value || workspaceAgent.value !== undefined));
const scopeTitle = useScopeTitle();
const readOnlyReason = computed(() =>
    canEditFiles.value
        ? `Showing ${scopeTitle.value}'s copy of the workspace: its work hasn't landed yet, so these files can't be edited here.`
        : `Your access to this sandbox is read-only: changing files needs maintainer access.`,
);
// Markdown answers the same Edit switch as any file, differing only in what it opens into (MarkdownViewer
// becomes typeable, instead of the code editor).
const markdownHere = computed(() => open.value.kind === `markdown`);
// Global edit mode, gated by canEdit so a viewer's file (even text-backed, like .svg) stays in its viewer,
// never the editor.
const editingThis = computed(() => !mobile.value && editMode.value && canEdit.value && !markdownHere.value);
// Whether markdown may be written at all (the host's permission, `canEdit` elsewhere); whether it's being
// edited now is `editMode`, read on the surface.
const markdownEditable = computed(() => !mobile.value && canEdit.value && markdownHere.value);
// Either text surface, being edited. What the Save/Preview pair in the toolbar is about.
const editingText = computed(() => editingThis.value || (markdownEditable.value && editMode.value));
// Saves through whichever surface is showing, since each settles its own buffer first (markdown folds in,
// code normalizes).
const saveNow = (): void => (markdownHere.value ? markdownView.value?.save() : editorView.value?.save());
// Offered only while reading code (not editing): the saved buffer must never be the stripped one.
const canHideComments = computed(() => open.value.kind === `code` && text.value !== null && !editingThis.value);
// In a scope the file shown is disk, not a buffer: a dirty dot here would misattribute someone else's edit to
// this agent's copy.
const dirtyThis = computed(() => workspaceAgent.value === undefined && edit.isDirty(path));
const editorSeed = computed(() => (workspaceAgent.value === undefined ? (edit.bufferOf(path) ?? text.value ?? ``) : (text.value ?? ``)));

const onEditorChange = (value: string): void => edit.setBuffer(path, value);
// markSaved runs only after a successful write. Guarded by the baseline's hash: the daemon 409s on a
// since-changed file instead of clobbering it, raising the same stale-on-disk banner.
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
        // Read view shows `text`, not the buffer: adopt it too, or Preview shows the pre-save file.
        text.value = value;
    }, `Couldn't save your changes.`);
</script>

<template>
    <div class="flex h-full min-h-0 flex-col">
        <!-- Breadcrumb path + edit actions (text only); actions stay through the post-save refetch via `|| editingThis`. -->
        <FileBreadcrumb :path="path" :meta="meta">
            <!--
                Same Comments toggle as the diff surface, one habit across both; starts shown here, since opening a file
                asks what it says.
            -->
            <button
                v-if="canHideComments"
                type="button"
                class="ui-chip shrink-0 gap-1 rounded-md px-1.5 py-0.5 font-medium"
                :class="hideFileComments ? `ui-chip-on` : ``"
                :aria-pressed="hideFileComments"
                @click="toggleHideFileComments()"
                v-tooltip.bottom="hideFileComments ? 'Comments hidden, click to show them' : 'Hide comments, read the code alone'"
            >
                <Icon :name="hideFileComments ? 'eye-slash' : 'eye'" class="text-2xs" />
                <span class="max-md:hidden">Comments</span>
            </button>
            <!--
                Tab row's chip says the view shows an agent's copy; this says this file specifically came from the shared
                workspace.
            -->
            <span
                v-if="workspaceAgent !== undefined && fromShared"
                class="inline-flex shrink-0 items-center gap-1 rounded-md bg-overlay px-1.5 py-0.5 text-2xs text-muted"
                v-tooltip.bottom="'This agent has no copy of this file, so you are seeing the shared workspace version.'"
            >
                <Icon name="folder" class="text-[0.65rem]" /> Shared
            </span>
            <CopyButton v-if="text !== null" :text="editorSeed" aria-label="Copy file content" v-tooltip.bottom="'Copy content'" />
            <!-- Edit button's own seat while the scope keeps it empty; a merely-missing affordance reads as a bug otherwise. -->
            <span
                v-if="scopedReadOnly"
                class="inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-2xs text-muted"
                v-tooltip.bottom="readOnlyReason"
            >
                <Icon name="lock" class="text-[0.7rem]" />
                <span class="max-md:hidden">Read-only</span>
            </span>
            <template v-if="!mobile && (canEdit || editingThis)">
                <span v-if="dirtyThis" class="inline-flex shrink-0 items-center text-warning" v-tooltip.bottom="'Unsaved changes: Ctrl+S to save'">
                    <Icon name="circle-fill" class="text-[0.4rem]" />
                </span>
                <template v-if="editingText">
                    <Button
                        size="small"
                        severity="secondary"
                        :text="true"
                        class="shrink-0"
                        :disabled="!dirtyThis"
                        @click="saveNow()"
                        v-tooltip.bottom="'Save (Ctrl+S)'"
                    >
                        <Icon name="save" class="text-[0.7rem]" /> Save
                    </Button>
                    <Button
                        size="small"
                        severity="secondary"
                        :text="true"
                        class="shrink-0"
                        @click="setEditMode(false)"
                        v-tooltip.bottom="'Back to preview (keeps unsaved edits)'"
                    >
                        <Icon name="eye" class="text-[0.7rem]" /> Preview
                    </Button>
                </template>
                <Button
                    v-else
                    size="small"
                    severity="secondary"
                    :text="true"
                    class="shrink-0"
                    @click="setEditMode(true)"
                    v-tooltip.bottom="'Edit all files'"
                >
                    <Icon name="pencil" class="text-[0.7rem]" /> Edit
                </Button>
            </template>
        </FileBreadcrumb>

        <!-- The open file changed on disk under unsaved edits: the buffer is kept; Reload adopts disk (discards edits). -->
        <div v-if="staleOnDisk" class="flex shrink-0 items-center gap-2 border-b border-warning/40 bg-warning/10 px-3 py-1.5 text-2xs text-warning">
            <Icon name="exclamation-triangle" class="text-[0.7rem]" />
            <span class="flex-1">This file changed on disk. Your unsaved edits are preserved.</span>
            <Button size="small" severity="warn" :text="true" @click="reloadFromDisk">
                <Icon name="refresh" class="text-[0.7rem]" /> Reload from disk
            </Button>
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
                <!--
                    Seeded and re-keyed like the editable CodeView above: the surface owns its text after mount, replaced only
                    by a reload, a clean external write, or a different file.
                -->
                <MarkdownViewer
                    v-else-if="open.kind === 'markdown' && text !== null"
                    ref="markdownView"
                    :key="`${path}:${reloadNonce}`"
                    :source="editorSeed"
                    :path="path"
                    :line="line"
                    :editable="markdownEditable"
                    @change="onEditorChange"
                    @save="onEditorSave"
                />
                <!-- Over the editable cap: windowed, read-only, seeded with the window the read above already got. -->
                <BigTextView v-else-if="open.kind === 'big-text' && firstWindow" :path="path" :first="firstWindow" @download="download" />
                <!--
                    Extension-contributed viewer: gets the path plus exactly one content prop (the manifest's `fetch` kind,
                    never the others as undefined). `download` is the host's authenticated fetch, shared with the fallback states below.
                -->
                <component :is="viewerComponent" v-else-if="viewerComponent" :path="path" v-bind="viewerContent" @download="download" />
                <FileUnsupported v-else-if="open.kind === 'too-large'" mode="too-large" :size="meta?.size" @download="download" />
                <FileUnsupported v-else-if="open.kind === 'empty'" mode="empty" />
                <!-- Sandbox keeps this one to itself; resolveOpenFile knows from the path alone, no fetch needed. -->
                <FileLocked v-else-if="open.kind === 'locked'" :path="path" />
                <!--
                    Everything left: a known binary, or the unreachable case of a viewer that resolved with no component; both
                    just hand over bytes.
                -->
                <FileUnsupported v-else mode="binary" @download="download" />
            </template>
        </div>
    </div>
</template>
