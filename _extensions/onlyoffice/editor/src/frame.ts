// SPDX-License-Identifier: AGPL-3.0-only

// What the page reaches for inside the ONLYOFFICE frame: the one iframe the DocEditor placed, its export of the document
// in its own format, and its change history. Every member is optional, since the frame's globals land during its boot.

interface EditorApi {
    asc_DownloadAs?: (options: unknown) => void;
    isLoadFullApi?: boolean;
    isDocumentLoadComplete?: boolean;
    isLongAction?: () => boolean;
    documentFormatSave?: number | null;
    CheckChangedDocument?: () => void;
    SetUnchangedDocument?: () => void;
}

interface EditorHistory {
    Index?: number;
    ForceSave?: boolean;
    Reset_SavedIndex?: (userSave: boolean) => void;
    Set_SavedIndex?: (index: number) => void;
}

export type EditorFrame = Window & {
    Asc?: { editor?: EditorApi; asc_CDownloadOptions?: new (format: number) => unknown };
    AscCommon?: { History?: EditorHistory };
};

// The editor's frame, once the DocEditor has placed it: the only iframe on the page.
export const frameWindow = (): EditorFrame | undefined => {
    // SAFETY: the page holds exactly one iframe, the DocEditor's; EditorFrame declares its globals as optional.
    const frame = document.querySelector(`iframe`)?.contentWindow as EditorFrame | null | undefined;
    return frame ?? undefined;
};

// Asks the editor for its document in its own format; false while it cannot take the request. An export asked for
// while the editor is still loading, or inside another long action, is dropped silently, so neither is asked.
export const exportDocument = (): boolean => {
    const frame = frameWindow();
    const editor = frame?.Asc?.editor;
    const Options = frame?.Asc?.asc_CDownloadOptions;
    const format = editor?.documentFormatSave;
    if (editor?.asc_DownloadAs === undefined || Options === undefined || format === undefined || format === null) {
        return false;
    }
    if (editor.isLoadFullApi !== true || editor.isDocumentLoadComplete !== true || editor.isLongAction?.() === true) {
        return false;
    }
    editor.asc_DownloadAs(new Options(format));
    return true;
};

// Where the editor's change history stands.
export const changePoint = (): number | undefined => frameWindow()?.AscCommon?.History?.Index;

// Marks the history as saved up to `point`, the position an export was taken at, and has the editor recompute its
// modified flag: edits typed while the save ran stay unsaved.
export const markSaved = (point: number | undefined): void => {
    const frame = frameWindow();
    const history = frame?.AscCommon?.History;
    if (history?.Reset_SavedIndex !== undefined && (point === undefined || history.Index === point)) {
        history.Reset_SavedIndex(true);
    } else if (history?.Set_SavedIndex !== undefined && point !== undefined) {
        history.Set_SavedIndex(point);
        history.ForceSave = false;
    }
    const editor = frame?.Asc?.editor;
    if (editor?.CheckChangedDocument === undefined) {
        editor?.SetUnchangedDocument?.();
        return;
    }
    editor.CheckChangedDocument();
};
