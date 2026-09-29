// SPDX-License-Identifier: AGPL-3.0-only
import { CHANNEL, CONFIG_ELEMENT_ID, viewerMessage, type EditorPageConfig, type PageMessage } from "../../src/protocol.js";
import { changePoint, exportDocument, frameWindow, markSaved } from "./frame.js";
import { prepareEditorFrame, type FrameHooks } from "./guards/index.js";
import { SaveController } from "./save.js";
import { downloadFile, writeDocument } from "./workspace.js";

// The browser engine's editor page: ONLYOFFICE's offline build in a frame, converting with x2t in this browser, the
// document read from and written back to the workspace through the listener, and the viewer around the page told what
// it needs to know (open, unsaved, saved, a conflict to settle). The page is served on the listener's origin; the app
// frames it and never runs any of this code on its own.

interface DocsApi {
    DocEditor: new (placeholder: string, config: Record<string, unknown>) => { destroyEditor?: () => void };
}

interface FileStream {
    readonly type?: string;
    readonly fileName?: string;
    readonly fileType?: string;
    readonly buffer?: ArrayBuffer;
}

// SAFETY: the page's own global, read by the offline build's x2t helper; only this flag is written.
const page = window as Window & { OO_FILE_STREAM_ONLY?: boolean; DocsAPI?: DocsApi };
// Tells the offline build's x2t helper to hand exported bytes to this page rather than start a download itself.
page.OO_FILE_STREAM_ONLY = true;

// How long the page keeps applying the runtime corrections while the editor boots.
const GUARD_POLL_MS = 100;
const GUARD_POLL_LIMIT_MS = 60_000;

const note = (text: string): void => {
    const paragraph = document.createElement(`p`);
    paragraph.id = `note`;
    paragraph.textContent = text;
    document.body.replaceChildren(paragraph);
};

const readConfig = (): EditorPageConfig | undefined => {
    const text = document.getElementById(CONFIG_ELEMENT_ID)?.textContent ?? ``;
    try {
        // SAFETY: the backend renders this element from an EditorPageConfig (browser-page.ts); nothing else writes it.
        return text === `` ? undefined : (JSON.parse(text) as EditorPageConfig);
    } catch {
        // allow(silent-catch): a page without a readable config is answered with the note below.
        return undefined;
    }
};

// The exported bytes an `onlyoffice-file-stream` message carries, or undefined for any other message.
const fileStreamOf = (event: MessageEvent<FileStream | null>): Required<FileStream> | undefined => {
    const data = event.data;
    // Checked by the buffer's own tag, not instanceof: it was made in the editor frame's realm.
    const buffer = Object.prototype.toString.call(data?.buffer) === `[object ArrayBuffer]` ? data?.buffer : undefined;
    if (data?.type !== `onlyoffice-file-stream` || buffer === undefined) {
        return undefined;
    }
    return { type: data.type, buffer, fileName: data.fileName ?? ``, fileType: data.fileType ?? `` };
};

// The DocEditor's config for this page's document.
const editorConfigFor = (config: EditorPageConfig, events: Record<string, unknown>) => {
    const editing = config.mode === `edit`;
    return {
        type: `desktop`,
        width: `100%`,
        height: `100%`,
        documentType: config.documentType,
        document: {
            title: config.title,
            url: new URL(config.fileUrl, window.location.href).href,
            fileType: config.fileType,
            key: config.key,
            permissions: { edit: editing, review: editing, comment: editing, fillForms: editing, download: true, print: true, chat: false, protect: false },
        },
        editorConfig: {
            mode: config.mode,
            lang: config.lang,
            user: { id: `owner`, name: `Owner` },
            // No document server, so no co-editing: the mode is pinned and its switch hidden.
            coEditing: { mode: `fast`, change: false },
            customization: {
                compactHeader: true,
                help: false,
                feedback: false,
                uiTheme: config.theme === `dark` ? `theme-dark` : `theme-light`,
                anonymous: { request: false, label: `Owner` },
                // The spellchecker's dictionaries are not in the bundle, and its worker is what hangs a cold open.
                features: { featuresTips: false, spellcheck: { mode: false, change: false } },
            },
        },
        events,
    };
};

// Applies the runtime corrections while the editor boots, until those a document needs are in and it has opened.
const applyGuardsWhileBooting = (hooks: FrameHooks, opened: () => boolean): (() => void) => {
    let guarded = false;
    const apply = (): void => {
        const frame = frameWindow();
        if (frame !== undefined) {
            guarded = prepareEditorFrame(frame, hooks) || guarded;
        }
    };
    const began = Date.now();
    const poll = window.setInterval(() => {
        apply();
        if ((guarded && opened()) || Date.now() - began > GUARD_POLL_LIMIT_MS) {
            window.clearInterval(poll);
        }
    }, GUARD_POLL_MS);
    return apply;
};

// Takes what the editor frame and the viewer say to this page.
const listen = (save: SaveController, config: EditorPageConfig): void => {
    window.addEventListener(`message`, (event: MessageEvent<FileStream | null>) => {
        const frame = frameWindow();
        if (frame !== undefined && event.source === frame && event.origin === window.location.origin) {
            const stream = fileStreamOf(event);
            if (stream !== undefined) {
                save.fileStream(stream.buffer, stream.fileName === `` ? config.title : stream.fileName, stream.fileType);
            }
            return;
        }
        if (window.parent === window || event.source !== window.parent) {
            return;
        }
        const message = viewerMessage(event.data);
        if (message?.type === `save`) {
            save.request();
        } else if (message?.type === `sync`) {
            save.sync();
        } else if (message?.type === `resolve`) {
            save.resolve(message.choice);
        }
    });
};

const start = (config: EditorPageConfig, api: DocsApi): void => {
    const post = (message: PageMessage): void => {
        if (config.parentOrigin !== undefined && window.parent !== window) {
            window.parent.postMessage(message, config.parentOrigin);
        }
    };
    // Set before a reload the owner chose, so the page's own unsaved-changes prompt does not ask them again.
    let leaving = false;
    let opened = false;
    const save = new SaveController({
        fileType: config.fileType,
        version: config.version,
        saveable: config.saveable && config.mode === `edit`,
        effects: {
            exportDocument,
            changePoint,
            markSaved,
            write: (bytes, kind) => writeDocument(config.fileUrl, bytes, kind),
            download: downloadFile,
            reload: () => {
                leaving = true;
                window.location.reload();
            },
            post,
        },
    });
    const applyGuards = applyGuardsWhileBooting(
        {
            opened: () => opened,
            openFailed: (detail) => post({ channel: CHANNEL, type: `open-failed`, detail }),
            exportFailed: (detail) => save.exportFailed(detail),
            userSave: () => save.request(),
        },
        () => opened,
    );
    const docEditor = new api.DocEditor(
        `placeholder`,
        editorConfigFor(config, {
            onAppReady: applyGuards,
            onDocumentReady: () => {
                opened = true;
                applyGuards();
                // Input in the editor frame, which the automatic save waits for a pause in.
                for (const type of [`keydown`, `pointerdown`, `wheel`, `touchstart`]) {
                    frameWindow()?.document.addEventListener(type, () => save.touched(), { capture: true, passive: true });
                }
                save.opened();
                post({ channel: CHANNEL, type: `ready` });
                // Where things stand on a page loaded again (a conflict settled by a copy, or by taking the file on disk):
                // the viewer last heard the page before it.
                save.sync();
            },
            onDocumentStateChange: (event: { data?: boolean }) => save.modified(event.data === true),
            // Declared for the api layer, which only runs an export when it exists; the bytes arrive as a message.
            onDownloadAs: () => undefined,
            onError: (event: { data?: { errorCode?: number; errorDescription?: string } }) => {
                if (!opened) {
                    post({ channel: CHANNEL, type: `open-failed`, detail: event.data?.errorDescription ?? `the editor reported error ${String(event.data?.errorCode)}` });
                }
            },
        }),
    );
    listen(save, config);
    // The owner leaving the browser tab, or the app going away, is a moment to write what is unsaved.
    document.addEventListener(`visibilitychange`, () => {
        if (document.visibilityState === `hidden`) {
            save.request();
        }
    });
    window.addEventListener(`beforeunload`, (event) => {
        if (save.unsaved && !leaving) {
            event.preventDefault();
        }
    });
    // The page is going (its frame removed, or reloaded): the editor's timers and worker go with it.
    window.addEventListener(`pagehide`, () => {
        save.dispose();
        docEditor.destroyEditor?.();
    });
};

const config = readConfig();
const api = page.DocsAPI;
if (config === undefined || api === undefined) {
    note(`The editor could not load. Close this file and open it again.`);
    if (config?.parentOrigin !== undefined && window.parent !== window) {
        window.parent.postMessage({ channel: CHANNEL, type: `open-failed`, detail: `the editor could not load` } satisfies PageMessage, config.parentOrigin);
    }
} else {
    start(config, api);
}
