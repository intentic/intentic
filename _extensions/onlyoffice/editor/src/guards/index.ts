// SPDX-License-Identifier: AGPL-3.0-only
// After ranuts/document lib/onlyoffice/iframe-guards.ts at 1301bb8b (AGPL-3.0); see editor/NOTICE.
import { installAboutSourceNotice } from "./about-source.js";
import {
    installBadImageUrlGuard,
    installCommentSelectionGuard,
    installFontLoadAcceleration,
    installLongActionLeakGuard,
    installSeriesSettingsGuard,
    installServerlessImagePipeline,
    installServerlessSaveSemantics,
} from "./api-guards.js";
import { injectLocalChromeCss, installCanvasLossGuard, installFetchFontsGuard, installHintFallbackGuard, installSingleUnloadPrompt, shadowSharedWorker } from "./frame-guards.js";
import { installOpenFailureGuard, type OpenFailureHooks } from "./open-failure.js";
import { releaseWasmBinary } from "./wasm-binary-release.js";
import { installX2tWorkerProxy } from "./x2t-worker.js";

// The runtime corrections the offline build needs to open and save documents without a document server, each one a
// defect that reached real users of the build (the files beside this one say which). All are idempotent per frame and
// independent of each other; the SDK pieces they hook land at different points of the editor's boot, so the page
// applies them repeatedly until the ones a document needs are in place.

export interface FrameHooks extends OpenFailureHooks {
    // The reader asked to save (Ctrl+S, the Save button).
    readonly userSave: () => void;
}

// Applies every correction to the editor frame `win`; true once those a document needs to open and save have landed.
export const prepareEditorFrame = (win: Window, hooks: FrameHooks): boolean => {
    const doc = win.document;
    installOpenFailureGuard(win, hooks);
    injectLocalChromeCss(doc);
    const essential = [
        shadowSharedWorker(win),
        installFetchFontsGuard(win),
        installServerlessImagePipeline(win),
        installServerlessSaveSemantics(win, hooks.userSave),
        installLongActionLeakGuard(win),
        installX2tWorkerProxy(win),
        releaseWasmBinary(win),
    ];
    installSeriesSettingsGuard(win);
    installFontLoadAcceleration(win);
    installCommentSelectionGuard(win);
    installCanvasLossGuard(win, doc);
    installSingleUnloadPrompt(win);
    installHintFallbackGuard(win);
    installBadImageUrlGuard(win);
    installAboutSourceNotice(doc);
    return essential.every(Boolean);
};
