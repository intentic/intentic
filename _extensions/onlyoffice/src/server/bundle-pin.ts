import { MEDIA_INSERT_FLAG } from "../protocol.js";

// The editor bundle the browser engine runs: ONLYOFFICE's sdkjs and web-apps in their offline build, the x2t converter
// compiled to WebAssembly, and a font catalog whose files may be handed on. It is the vendor tree of ranuts/document
// (AGPL-3.0; see editor/NOTICE), taken at one commit and held to the digest of exactly the files kept from it.

export interface BundlePin {
    // Names the directory the tree is kept in and the /bundle/<id>/ segment it is served under. A new pin is a new
    // directory and a new URL, so neither a half-replaced tree nor a browser cache of the last one mixes into it.
    readonly id: string;
    // A gzipped tar of the source tree.
    readonly url: string;
    // The archive's size when the pin was made: the progress ring's denominator, nothing more. The archive's own bytes
    // are not checked (codeload regenerates archives, so they need not be stable); the files kept from it are.
    readonly approximateBytes: number;
    // The directory every entry of the archive sits under.
    readonly stripPrefix: string;
    // What is kept, as [archive path, bundle path] prefix pairs: a pair ending in `/` keeps a directory, any other keeps
    // one file. Everything else in the archive (the site around the editor) is skipped.
    readonly keep: readonly (readonly [string, string])[];
    // The kept tree: how many files, and the sha256 over each one's bundle path and sha256 in path order (treeDigest).
    readonly files: number;
    readonly digest: string;
    // Edits made to the tree after it verified, each of which must match exactly once. They are the vendor
    // modifications editor/NOTICE lists; a pin whose tree no longer carries the text fails its install rather than
    // serving an unpatched file.
    readonly patches: readonly BundlePatch[];
}

export interface BundlePatch {
    readonly file: string;
    readonly find: string;
    readonly replace: string;
    // Why the edit exists, for the log line and the NOTICE.
    readonly why: string;
}

const COMMIT = `4cc2bc5440abf0df4fbff93824ae372d5aacd6b2`;

// The editor pages that ranuts/document gives a "neutral presentation": a style that hides the ONLYOFFICE logo in the
// header and About pane. The ONLYOFFICE terms (AGPL section 7(b)) ask for the logo to stay, so each page loses that style.
const NEUTRAL_PAGES = [
    `common/index.html`,
    `documenteditor/main/index.html`,
    `documenteditor/main/index_loader.html`,
    `pdfeditor/main/index.html`,
    `pdfeditor/main/index_loader.html`,
    `presentationeditor/main/index.html`,
    `presentationeditor/main/index.reporter.html`,
    `presentationeditor/main/index_loader.html`,
    `spreadsheeteditor/main/index.html`,
    `spreadsheeteditor/main/index_internal.html`,
    `spreadsheeteditor/main/index_loader.html`,
    `visioeditor/main/index.html`,
    `visioeditor/main/index_loader.html`,
] as const;

const NEUTRAL_STYLE =
    `    <style id="neutral-product-presentation">\n` +
    `        #header-logo, .brand-logo, .asc-about-office, #id-about-company-logo { display: none !important; }\n` +
    `        #id-about-licensor-logo .asc-about-version:not(#id-about-licensor-version-name) { display: none !important; }\n` +
    `    </style>\n`;

export const BUNDLE_PIN: BundlePin = {
    id: `oo-9.3.0.133-r${COMMIT.slice(0, 8)}`,
    url: `https://codeload.github.com/ranuts/document/tar.gz/${COMMIT}`,
    approximateBytes: 214_952_998,
    stripPrefix: `document-${COMMIT}/`,
    keep: [
        [`public/sdkjs/`, `sdkjs/`],
        [`public/web-apps/`, `web-apps/`],
        [`public/fonts/`, `fonts/`],
        [`public/plugins.json`, `plugins.json`],
        [`public/themes.json`, `themes.json`],
        [`public/document_editor_service_worker.js`, `document_editor_service_worker.js`],
        [`LICENSE`, `LICENSE`],
        [`NOTICE`, `NOTICE`],
        [`docs/font-licenses.md`, `font-licenses.md`],
    ],
    files: 2548,
    digest: `3acdb2b33a60cb97f8af5442a4febb0f479783d2c988ae94bf3705d2cf808c28`,
    patches: [
        {
            file: `sdkjs/common/wasm/x2t/x2t_helper.js`,
            find: `                    try { t.postMessage(payload, '*'); } catch (e) {}\n`, // allow(silent-catch): upstream x2t source text the patch matches, not our code
            replace: `                    try { t.postMessage(payload, window.location.origin); } catch (e) {}\n`, // allow(silent-catch): upstream x2t source text, only the target origin changes
            why: `address the exported document to the editor page's own origin rather than to any`,
        },
        {
            file: `web-apps/apps/presentationeditor/main/app.js`,
            find: `Common.Controllers.Desktop.isActive()&&Common.Controllers.Desktop.isFeatureAvailable("IsSupportMedia")&&Common.Controllers.Desktop.call("IsSupportMedia")&&(n.btnInsAudio=`,
            replace: `(function(){try{return window.parent!==window&&window.parent.${MEDIA_INSERT_FLAG}===!0}catch(e){return!1}}()||Common.Controllers.Desktop.isActive()&&Common.Controllers.Desktop.isFeatureAvailable("IsSupportMedia")&&Common.Controllers.Desktop.call("IsSupportMedia"))&&(n.btnInsAudio=`, // allow(silent-catch): vendor script text; a parent on another origin reads as no flag
            why: `offer Insert > Audio and Video where the editor page says it can store them, not only in ONLYOFFICE's desktop app`,
        },
        ...NEUTRAL_PAGES.map((page) => ({
            file: `web-apps/apps/${page}`,
            find: NEUTRAL_STYLE,
            replace: ``,
            why: `keep the ONLYOFFICE logo, which the ONLYOFFICE terms (AGPL section 7(b)) ask to stay`,
        })),
    ],
};
