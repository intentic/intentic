import type { RegisteredViewer } from "../../../core-views/viewerRegistry";
import { viewerForExtension } from "../../../core-views/viewerRegistry";
import { RAW_MAX_BYTES, resolveFile } from "../fileType";

/* WHICH SURFACE OPENS THIS FILE — the one place the core's text resolver and the extensions' viewer registry
 * are put in order, and the reason FileViewer has no per-format branches left.
 *
 * The rule is the one VSCode's custom editors follow: an extension that CLAIMS a file extension wins, and the
 * core's answer is what a file falls back to when nothing claims it. So `.png` resolves to `binary` in
 * fileType.ts and to the viewers extension's `image` here — and to `binary` again the moment that extension is
 * switched off, with no code path anywhere that has to be told.
 *
 * Text is the exception in the other direction and stays first-class: `code` and `markdown` are not viewers,
 * they are the editor — Monaco, the edit buffers, the dirty state the tabs read, the hash-guarded save. An
 * extension may still claim a text extension (that is what makes `.svg` a picture with a Source toggle), and
 * when it does it gets the same deal as any other viewer: render-only, no editing.
 *
 * Kept out of fileType.ts because it is NOT pure — viewerForExtension reads reactive registry state, so this
 * re-resolves when an extension activates or retires. fileType.ts stays a unit-testable function of a path. */

// Where the file's content comes from, and therefore what the surface is handed. `none` is a state with
// nothing to fetch: no bytes, bytes we can't show, or more bytes than the raw route will serve.
export type OpenFile =
    /* The core text surfaces. `big-text` is never RESOLVED — it is what FileViewer switches to once the daemon
     * reports a size over the editable cap — but it lives in this union because it is one of the modes the
     * viewer renders, and a mode the viewer can hold that the resolver cannot name would be worse. */
    | { readonly kind: "code" | "markdown" | "big-text"; readonly lang: string | undefined }
    // An extension viewer claimed this extension; `viewer.fetch` decides text / blob / streaming URL.
    | { readonly kind: "viewer"; readonly viewer: RegisteredViewer }
    | { readonly kind: "empty" | "binary" | "too-large" };

/* Can this file reach the viewer that claimed it? Only a `blob` viewer can be defeated by size: it is served
 * by /workspace/raw, which holds the whole answer in memory and 413s past MAX_RAW_BYTES, so a 40 MB .docx is
 * an honest "too large" rather than a render that fails halfway. `url` viewers stream byte ranges and have no
 * ceiling — a 2 GB recording is the case they exist for — and `text` viewers are bounded by the windowed read
 * the text routes already apply. */
const oversizeForViewer = (viewer: RegisteredViewer, size: number | undefined): boolean =>
    viewer.fetch === `blob` && size !== undefined && size > RAW_MAX_BYTES;

// The lowercased extension of a path, or "" for a dotfile / extensionless name — the key the registry is
// indexed by. Matches fileType.ts's rule (dot > 0) so both sides agree on what ".gitignore" has for an
// extension: nothing.
const extensionOf = (path: string): string => {
    const name = path.slice(path.lastIndexOf(`/`) + 1).toLowerCase();
    const dot = name.lastIndexOf(`.`);
    return dot > 0 ? name.slice(dot + 1) : ``;
};

// Resolve how to open `path` given its byte size (undefined when unknown — the tree cap, or stat failed; we
// then proceed optimistically and let the post-read NUL check / daemon 413 catch the rare bad case).
export const resolveOpenFile = (path: string, size: number | undefined): OpenFile => {
    const viewer = viewerForExtension(extensionOf(path));
    if (viewer !== undefined) {
        // An empty file has nothing for a viewer to render, whatever the viewer is — checked before the viewer
        // gets it so every format inherits the same honest answer instead of each one drawing a blank frame.
        if (size === 0) {
            return { kind: `empty` };
        }
        return oversizeForViewer(viewer, size) ? { kind: `too-large` } : { kind: `viewer`, viewer };
    }
    const { mode, lang } = resolveFile(path, size);
    return mode === `code` || mode === `markdown` ? { kind: mode, lang } : { kind: mode };
};
