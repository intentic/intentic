// What the viewer and the browser engine's editor page say to each other across the frame boundary, by postMessage.
// The page runs on the listener's origin and the viewer on the app's; each side checks the other's window and origin
// before it reads a message, and this module only says what a message may look like. It is the viewer's (MIT); the
// page (editor/, AGPL) imports it, never the other way round.

export const CHANNEL = "intentic.onlyoffice";

// What the backend hands the editor page, as JSON inside the page it serves (#intentic-editor-config).
export interface EditorPageConfig {
    readonly title: string;
    readonly fileType: string;
    readonly documentType: "word" | "cell" | "slide";
    readonly mode: "edit" | "view";
    readonly theme: "light" | "dark";
    readonly lang: string;
    // Where the page reads and writes its document (the listener's /file route with the session token).
    readonly fileUrl: string;
    // The version of the file the page is served against, sent back with its first save.
    readonly version: string | undefined;
    // The editor's document key, minted per page load: the offline editor keeps a converted document under its key, so
    // one reused across loads could show bytes the file no longer holds.
    readonly key: string;
    // Whether an edit can be written back in the document's own format (x2t has no writer for the legacy binary ones).
    readonly saveable: boolean;
    // The app's origin, the only one the page posts to; undefined when the app did not say, and the page stays quiet.
    readonly parentOrigin: string | undefined;
}

export const CONFIG_ELEMENT_ID = "intentic-editor-config";

// How a save whose file changed on disk meanwhile is settled: write over the change, write beside it, or drop the
// edits and load what is on disk now.
export type ConflictChoice = "overwrite" | "copy" | "reload";

// Page to viewer.
export type PageMessage =
    // The document is open in the editor.
    | { readonly channel: typeof CHANNEL; readonly type: "ready" }
    // Whether the editor holds edits the workspace file does not have yet.
    | { readonly channel: typeof CHANNEL; readonly type: "dirty"; readonly dirty: boolean }
    // What the editor held reached the workspace, at `path` (the document's own, or the copy a conflict chose).
    | { readonly channel: typeof CHANNEL; readonly type: "saved"; readonly path: string }
    | { readonly channel: typeof CHANNEL; readonly type: "save-failed"; readonly detail: string }
    // The file changed on disk since the editor loaded or last saved it; nothing was written, the owner decides.
    | { readonly channel: typeof CHANNEL; readonly type: "conflict" }
    | { readonly channel: typeof CHANNEL; readonly type: "open-failed"; readonly detail: string };

// Viewer to page.
export type ViewerMessage =
    // Write what the editor holds, if it holds anything unsaved: the viewer's call when the document is left.
    | { readonly channel: typeof CHANNEL; readonly type: "save" }
    // Say again where things stand (unsaved, a conflict waiting): an editor kept out of sight spoke to no viewer.
    | { readonly channel: typeof CHANNEL; readonly type: "sync" }
    | { readonly channel: typeof CHANNEL; readonly type: "resolve"; readonly choice: ConflictChoice };

const CONFLICT_CHOICES: readonly string[] = ["overwrite", "copy", "reload"] satisfies readonly ConflictChoice[];

// A message on this channel, its fields still to be checked; anything else (another sender's message) is undefined.
const record = (data: unknown): Record<string, unknown> | undefined => {
    if (typeof data !== "object" || data === null) {
        return undefined;
    }
    // SAFETY: a structured-clone payload that is an object; every field is checked before it is read as anything.
    const fields = data as Record<string, unknown>;
    return fields["channel"] === CHANNEL ? fields : undefined;
};

export const pageMessage = (data: unknown): PageMessage | undefined => {
    const message = record(data);
    switch (message?.["type"]) {
        case "ready":
        case "conflict":
            return { channel: CHANNEL, type: message["type"] };
        case "dirty":
            return typeof message["dirty"] === "boolean" ? { channel: CHANNEL, type: "dirty", dirty: message["dirty"] } : undefined;
        case "saved":
            return typeof message["path"] === "string" ? { channel: CHANNEL, type: "saved", path: message["path"] } : undefined;
        case "save-failed":
        case "open-failed":
            return typeof message["detail"] === "string" ? { channel: CHANNEL, type: message["type"], detail: message["detail"] } : undefined;
        default:
            return undefined;
    }
};

export const viewerMessage = (data: unknown): ViewerMessage | undefined => {
    const message = record(data);
    if (message?.["type"] === "save" || message?.["type"] === "sync") {
        return { channel: CHANNEL, type: message["type"] };
    }
    const choice = message?.["choice"];
    if (message?.["type"] === "resolve" && typeof choice === "string" && CONFLICT_CHOICES.includes(choice)) {
        // SAFETY: `choice` was just found among the ConflictChoice values.
        return { channel: CHANNEL, type: "resolve", choice: choice as ConflictChoice };
    }
    return undefined;
};
