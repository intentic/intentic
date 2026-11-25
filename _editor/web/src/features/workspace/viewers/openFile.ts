import { isLockedWorkspacePath } from "@intentic/sandbox-contract/state/workspace-state";
import { extensionOf } from "@intentic/ui/file-format";
import type { RegisteredViewer } from "../../../workbench/views/viewerRegistry";
import { viewerForExtension } from "../../../workbench/views/viewerRegistry";
import { extensionsSettling } from "../../../workbench/views/extensionStatuses";
import { shallowReactive } from "vue";
import { BLOB_CONFIRM_BYTES, resolveFile } from "../../../models/workspace/tree/fileType";

// Which surface opens a file: an extension that claims its extension wins, fileType.ts's answer is the fallback. Text
// (code/markdown) stays the editable surface even when claimed; other viewers are render-only. Kept out of fileType.ts
// because viewerForExtension reads reactive registry state, unlike that pure function.

// What determines what the surface is handed; `empty`, `binary`, `too-large`, `large` and `locked` all mean nothing is
// fetched (yet), each for a different reason. `pending` is a file only a viewer could draw, opened before the extension
// host has finished activating: drawn as loading, and resolved again once the pass ends (FileViewer's `claimed`).
export type OpenFile =
    // `big-text` is never resolved directly; the viewer switches to it once the daemon reports an oversize file.
    | { readonly kind: "code" | "markdown" | "big-text"; readonly lang: string | undefined }
    // An extension viewer claimed this extension; `viewer.fetch` decides text / blob / streaming URL / path only.
    // `large`: the same, for a file past BLOB_CONFIRM_BYTES that viewer would read whole into the tab, drawn as the
    // question whether to until the reader answers it (openAnyway).
    | { readonly kind: "viewer" | "large"; readonly viewer: RegisteredViewer }
    // `too-large` is never resolved here either: it is what a server from before any size was served answers (a 413).
    | { readonly kind: "empty" | "binary" | "too-large" | "locked" | "pending" };

// The large files the reader said to open anyway, by path, for as long as the window lives: asked once, not again on
// every return to the tab. Reactive, since an answer re-resolves the tab (claimOf).
// allow(module-state): the one window's answers about its files
const openedAnyway = shallowReactive(new Set<string>());

/** The reader's word to open `path` here despite its size. */
export const openAnyway = (path: string): void => void openedAnyway.add(path);

// Only a `blob` viewer is asked about: it holds the whole file in the tab. `url` and `text` viewers stream or window
// their reads, and a `path` viewer reads nothing through the host.
const waitsForWord = (viewer: RegisteredViewer, path: string, size: number | undefined): boolean =>
    viewer.fetch === `blob` && size !== undefined && size > BLOB_CONFIRM_BYTES && !openedAnyway.has(path);

// Resolve how to open `path` given its byte size; undefined (unknown, cap, or stat failure) proceeds optimistically,
// leaving the post-read NUL check / daemon 413 to catch bad cases.
export const resolveOpenFile = (path: string, size: number | undefined): OpenFile => {
    // Answered from the path alone, before anything else, so a locked file never opens a tab and closes it again.
    if (isLockedWorkspacePath(path)) {
        return { kind: `locked` };
    }
    const viewer = viewerForExtension(extensionOf(path));
    if (viewer !== undefined) {
        // Checked before the viewer gets the file, so every format reports empty the same way.
        if (size === 0) {
            return { kind: `empty` };
        }
        return { kind: waitsForWord(viewer, path, size) ? `large` : `viewer`, viewer };
    }
    const { mode, lang } = resolveFile(path, size);
    if (mode === `code` || mode === `markdown`) {
        return { kind: mode, lang };
    }
    // Calling it bytes now would put a recording, a picture or a PDF on the download floor (and start deriving its text)
    // for as long as the viewers extension takes to activate: on a fresh load, a restored tab, a language change.
    if (mode === `binary` && extensionsSettling()) {
        return { kind: `pending` };
    }
    return { kind: mode };
};

// What claims `path`, as the key FileViewer's watch re-resolves the tab on: the viewer by what identifies it rather than by
// its registration object, which every activation builds anew (an extension activated again on a language change is the
// same viewer, and must not reload every tab it draws), and whether it still waits for the reader's word on a large
// file, so the answer opens it; `pending` while a viewer may still register, else nothing.
export const claimOf = (path: string, size: number | undefined): string | undefined => {
    const viewer = viewerForExtension(extensionOf(path));
    if (viewer === undefined) {
        return resolveOpenFile(path, size).kind === `pending` ? `pending` : undefined;
    }
    return JSON.stringify([viewer.owner, viewer.id, viewer.fetch, viewer.edit, waitsForWord(viewer, path, size)]);
};
