import { isLockedWorkspacePath } from "@intentic/sandbox-contract";
import type { RegisteredViewer } from "../../../core-views/viewerRegistry";
import { viewerForExtension } from "../../../core-views/viewerRegistry";
import { RAW_MAX_BYTES, resolveFile } from "../explorer/fileType";

// Which surface opens a file: an extension that claims its extension wins, fileType.ts's answer is the fallback. Text
// (code/markdown) stays the editable surface even when claimed; other viewers are render-only. Kept out of fileType.ts
// because viewerForExtension reads reactive registry state, unlike that pure function.

// What determines what the surface is handed; `empty`, `binary`, `too-large` and `locked` all mean nothing is fetched,
// each for a different reason.
export type OpenFile =
    // `big-text` is never resolved directly; the viewer switches to it once the daemon reports an oversize file.
    | { readonly kind: "code" | "markdown" | "big-text"; readonly lang: string | undefined }
    // An extension viewer claimed this extension; `viewer.fetch` decides text / blob / streaming URL.
    | { readonly kind: "viewer"; readonly viewer: RegisteredViewer }
    | { readonly kind: "empty" | "binary" | "too-large" | "locked" };

// Only a `blob` viewer can be defeated by size: /workspace/raw holds the whole answer in memory and 413s past the cap;
// `url` and `text` viewers stream or window their reads instead.
const oversizeForViewer = (viewer: RegisteredViewer, size: number | undefined): boolean =>
    viewer.fetch === `blob` && size !== undefined && size > RAW_MAX_BYTES;

// The lowercased extension of a path, or "" for a dotfile/extensionless name. Matches fileType.ts's rule (dot > 0), so
// both agree `.gitignore` has no extension.
const extensionOf = (path: string): string => {
    const name = path.slice(path.lastIndexOf(`/`) + 1).toLowerCase();
    const dot = name.lastIndexOf(`.`);
    return dot > 0 ? name.slice(dot + 1) : ``;
};

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
        return oversizeForViewer(viewer, size) ? { kind: `too-large` } : { kind: `viewer`, viewer };
    }
    const { mode, lang } = resolveFile(path, size);
    return mode === `code` || mode === `markdown` ? { kind: mode, lang } : { kind: mode };
};
