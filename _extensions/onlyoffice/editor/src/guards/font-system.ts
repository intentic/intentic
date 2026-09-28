// SPDX-License-Identifier: AGPL-3.0-only
// Ported from ranuts/document lib/onlyoffice/font-system.ts at 1301bb8b (AGPL-3.0); see editor/NOTICE.

// The font-system dependency the vendor never declared. The open conversion awaits `AscCommon.fetchFonts`, which walks
// a font system that is initialised in parallel with the document load; losing that race is a TypeError that fails the
// open with -82. Ordering the two is what removes it.

// The parts of an editor frame the vendor's `AscCommon.fetchFonts` walks before the open conversion can proceed.
export interface FontSystemWindow {
    AscCommon?: {
        fetchFonts?: (cb: (fonts: unknown[]) => void) => unknown;
        g_font_loader?: { fontFiles?: unknown };
    };
    AscFonts?: { g_font_infos?: unknown };
}

// Both halves of the font system have to be up before the vendor's `fetchFonts` is safe to run: it iterates
// `AscFonts.g_font_infos` and, for every face that needs styles, dereferences `AscCommon.g_font_loader.fontFiles[index].Id`.
const isFontSystemReady = (win: FontSystemWindow): boolean => {
    const infos = win.AscFonts?.g_font_infos;
    if (!Array.isArray(infos)) {
        return false;
    }
    // Nothing to look up: the loop body never runs, so an empty catalog is safe.
    if (infos.length === 0) {
        return true;
    }
    const files = win.AscCommon?.g_font_loader?.fontFiles;
    return Array.isArray(files) && files.length > 0;
};

// A bound on a font system that is genuinely broken, not on one that is merely slower than x2t: past it the conversion
// goes ahead without fonts rather than never.
const FONT_SYSTEM_WAIT_MS = 15_000;
const FONT_SYSTEM_POLL_MS = 50;

// The same wait as a promise, for callers with no vendor callback to hand over to (the x2t worker proxy).
export const waitForFontSystem = async (win: FontSystemWindow, timeoutMs = FONT_SYSTEM_WAIT_MS): Promise<boolean> => {
    for (let waited = 0; waited < timeoutMs; waited += FONT_SYSTEM_POLL_MS) {
        try {
            if (isFontSystemReady(win)) {
                return true;
            }
        } catch (error) {
            console.warn(`[onlyoffice] the font wait could not read the editor frame:`, error);
            return false;
        }
        await new Promise((resolve) => setTimeout(resolve, FONT_SYSTEM_POLL_MS));
    }
    console.warn(`[onlyoffice] the font system was not ready after ${timeoutMs} ms; converting without fonts`);
    return false;
};

// Holds the conversion's callback until the font system is up, then hands over to the vendor's own implementation. The
// wait is capped, and the fallback is what the code did before: report no fonts, which imports survive.
export const awaitFontSystem = (win: FontSystemWindow, original: (cb: (fonts: unknown[]) => void) => unknown, cb: (fonts: unknown[]) => void): void => {
    // Ready already, the normal path: hand over at once, as the vendor's own call would.
    if (isFontSystemReady(win)) {
        original.call(win.AscCommon, cb);
        return;
    }
    void waitForFontSystem(win).then((ready) => {
        // The frame this callback belongs to may have been torn down while it waited; handing over to a dead realm throws.
        try {
            if (ready) {
                original.call(win.AscCommon, cb);
                return;
            }
            cb([]);
        } catch (error) {
            console.warn(`[onlyoffice] the font wait could not hand the conversion over:`, error);
            // A font system that is up but incomplete throws inside the vendor's walk; answer it as a fontless import
            // rather than leave the conversion waiting for a callback that never comes.
            try {
                cb([]);
            } catch {
                // allow(silent-catch): the frame really is gone and nothing waits on the callback.
            }
        }
    });
};
