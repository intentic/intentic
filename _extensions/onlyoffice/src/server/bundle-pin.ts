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

const COMMIT = `1301bb8bdac9092c4eb88a6f2f4ff5080cec68bd`;

export const BUNDLE_PIN: BundlePin = {
    id: `oo-9.3.0.133-r${COMMIT.slice(0, 8)}`,
    url: `https://codeload.github.com/ranuts/document/tar.gz/${COMMIT}`,
    approximateBytes: 196_930_830,
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
    digest: `90cc5998891e5ae45a055ff3ea635254f81d2b9ca3b95a43684f1127b75553e0`,
    patches: [
        {
            file: `sdkjs/common/wasm/x2t/x2t_helper.js`,
            find: `                if (window.top && window.top !== window && window.top !== window.parent) targets.push(window.top);\n`,
            replace: `                // intentic: the exported bytes go to the editor page that asked for them, never on up to the app around it.\n`,
            why: `post the exported document to the editor page only, not to the top window`,
        },
        {
            file: `sdkjs/common/wasm/x2t/x2t_helper.js`,
            find: `                    try { t.postMessage(payload, '*'); } catch (e) {}\n`, // allow(silent-catch): upstream x2t source text the patch matches, not our code
            replace: `                    try { t.postMessage(payload, window.location.origin); } catch (e) {}\n`, // allow(silent-catch): upstream x2t source text, only the target origin changes
            why: `address the exported document to the editor page's own origin rather than to any`,
        },
    ],
};
