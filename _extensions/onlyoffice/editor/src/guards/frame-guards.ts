// SPDX-License-Identifier: AGPL-3.0-only
// Ported from ranuts/document lib/onlyoffice/guards/{shared-worker,fetch-fonts,unload-prompt,chrome,canvas-loss,
// hint-fallback}.ts at 1301bb8b (AGPL-3.0); see editor/NOTICE. Changed: what a correction already patched is kept in a
// registry here, keyed by the frame's document or the vendor object it patched, not as a flag written onto the
// editor's globals. Each answers whether it is in place, so the caller re-applies until the SDK piece it hooks landed.
import { awaitFontSystem, type FontSystemWindow } from "./font-system.js";

// Per document, not per window: a frame's window object outlives the about:blank document it started with.
const sharedWorkerShadowed = new WeakSet<Document>();
const unloadPromptDropped = new WeakSet<Document>();
const canvasWatched = new WeakSet<Document>();
const fontsGuarded = new WeakSet<object>();
const hintsGuarded = new WeakSet<object>();

// Shadows SharedWorker in the editor frame. The SDK's spellchecker prefers `new SharedWorker(spell.js)`, and that load
// hangs forever on a cold profile in Chromium; the stuck load keeps isDocumentLoadComplete false, which silently breaks
// every save and export. Without SharedWorker it falls back to a dedicated Worker, which loads fine.
export const shadowSharedWorker = (frame: Window): boolean => {
    if (!sharedWorkerShadowed.has(frame.document)) {
        Object.defineProperty(frame, `SharedWorker`, { value: undefined, configurable: true });
        sharedWorkerShadowed.add(frame.document);
    }
    return true;
};

// Makes the vendor's AscCommon.fetchFonts wait for the font system instead of walking a half-built one: the open
// conversion awaits it, and losing that race is a -82 open error on a perfectly good file.
export const installFetchFontsGuard = (frame: Window): boolean => {
    // SAFETY: the frame's globals are the vendor's; FontSystemWindow declares every member read here as optional.
    const win = frame as Window & FontSystemWindow;
    const common = win.AscCommon;
    const original = common?.fetchFonts;
    if (common === undefined || original === undefined) {
        return false;
    }
    if (!fontsGuarded.has(common)) {
        common.fetchFonts = (cb: (fonts: unknown[]) => void) => awaitFontSystem(win, original, cb);
        fontsGuarded.add(common);
    }
    return true;
};

// Drops the frame's own beforeunload prompt. The vendor's answer comes from bookkeeping that never learns a serverless
// save happened, so it keeps asking after the file is saved; the editor page prompts from what it knows.
export const installSingleUnloadPrompt = (frame: Window): boolean => {
    if (unloadPromptDropped.has(frame.document)) {
        return true;
    }
    try {
        Object.defineProperty(frame, `onbeforeunload`, { configurable: true, get: () => null, set: () => undefined });
        unloadPromptDropped.add(frame.document);
        return true;
    } catch {
        // allow(silent-catch): an engine that refuses to redefine the handler keeps a cosmetic duplicate prompt.
        return false;
    }
};

// Hides the current-user and co-user widgets, which describe a collaboration session this build cannot have, and the
// right panel on phone-sized viewports. The product logo stays: the ONLYOFFICE terms (AGPL section 7(b)) require it.
export const injectLocalChromeCss = (doc: Document): void => {
    if (doc.getElementById(`oo-local-chrome-css`) !== null) {
        return;
    }
    const style = doc.createElement(`style`);
    style.id = `oo-local-chrome-css`;
    style.textContent = [
        `.btn-current-user, #tlb-box-users { display: none !important; }`,
        `@media (max-width: 600px), (pointer: coarse) and (max-height: 600px) {`,
        `  [data-layout-name="rightMenu"] { display: none !important; }`,
        `}`,
    ].join(`\n`);
    (doc.head ?? doc.documentElement).append(style);
};

interface RepaintApi {
    WordControl?: { OnResize?: () => void; OnScroll?: () => void };
    asc_Resize?: () => void;
}

// Repaints the editor after the browser discarded a canvas under memory pressure; the vendor listens for neither
// `contextlost` nor `contextrestored`, and leaves a blank page with live scrollbars.
export const installCanvasLossGuard = (frame: Window, doc: Document): boolean => {
    if (canvasWatched.has(doc)) {
        return true;
    }
    // SAFETY: the frame's globals are the vendor's; every member read below is optional and checked before it is called.
    const win = frame as Window & { Asc?: { editor?: RepaintApi } };
    const repaint = (): void => {
        const api = win.Asc?.editor;
        try {
            if (api?.WordControl?.OnResize !== undefined) {
                api.WordControl.OnResize();
            } else if (api?.WordControl?.OnScroll !== undefined) {
                api.WordControl.OnScroll();
            } else {
                // The spreadsheet editor has no WordControl at all.
                api?.asc_Resize?.();
            }
        } catch (error) {
            console.warn(`[onlyoffice] repainting after a lost canvas failed:`, error);
        }
    };
    // Capture phase: the events do not bubble. `contextlost` must not be cancelled, or the browser never restores.
    doc.addEventListener(`contextlost`, () => win.setTimeout(repaint, 500), true);
    for (const restored of [`contextrestored`, `webglcontextrestored`]) {
        doc.addEventListener(restored, repaint, true);
    }
    canvasWatched.add(doc);
    return true;
};

interface HintTarget {
    updateHint?: (hint?: unknown, ...rest: unknown[]) => unknown;
}

// Keeps a missing translation from becoming a document error: some tooltip strings exist only in the locale files, and
// the tooltip setter reads `hint[0]` of an undefined one, which the app reports as a failure to work with the document.
export const installHintFallbackGuard = (frame: Window): boolean => {
    // SAFETY: the frame's globals are the vendor's; the component table and each prototype are read as optional.
    const components = (frame as Window & { Common?: { UI?: Record<string, { prototype?: HintTarget } | undefined> } }).Common?.UI;
    const owners = components === undefined ? [] : Object.values(components).flatMap((component) => (component?.prototype?.updateHint === undefined ? [] : [component.prototype]));
    for (const prototype of owners) {
        const original = prototype.updateHint;
        if (hintsGuarded.has(prototype) || original === undefined) {
            continue;
        }
        prototype.updateHint = function (this: unknown, hint?: unknown, ...rest: unknown[]) {
            return hint === undefined || hint === null ? undefined : original.call(this, hint, ...rest);
        };
        hintsGuarded.add(prototype);
    }
    // Common.UI lands during the editor's boot; until it has, the caller keeps re-applying.
    return owners.length > 0;
};
