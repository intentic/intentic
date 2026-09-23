import { PLAN_DOCUMENTS_DIR, STATE_DIR } from "@intentic/sandbox-contract";
import { registerViewer, renderViewerForExtension } from "../../../core-views/viewerRegistry";
import { RAW_MAX_BYTES } from "../explorer/fileType";
import { resolveOpenFile } from "./openFile";

// Order between the core's text resolver and the extensions' viewer registry: FileViewer itself has no per-format
// branches. Registrations are made/disposed per test against the real registry, a module-level singleton (no-Pinia).

const component = async (): Promise<never> => {
    throw new Error(`never rendered in these tests`);
};

const disposables: { dispose: () => void }[] = [];
const register = (
    id: string,
    extensions: readonly string[],
    fetch: "text" | "blob" | "url" | "path",
    options: { owner?: string; edit?: boolean } = {},
): void => {
    disposables.push(
        registerViewer({
            owner: options.owner ?? `intentic.viewers`,
            id,
            extensions,
            fetch,
            edit: options.edit ?? false,
            component: component as never,
        }),
    );
};
afterEach(() => {
    while (disposables.length > 0) {
        disposables.pop()?.dispose();
    }
});

describe(`resolveOpenFile without any viewer extension`, () => {
    it(`opens text as the editor and everything else as bytes`, () => {
        expect(resolveOpenFile(`src/app.ts`, 1000)).toEqual({ kind: `code`, lang: `typescript` });
        expect(resolveOpenFile(`README.md`, 1000)).toEqual({ kind: `markdown`, lang: `markdown` });
        expect(resolveOpenFile(`clip.mp4`, 1000)).toEqual({ kind: `binary` });
        expect(resolveOpenFile(`logo.png`, 1000)).toEqual({ kind: `binary` });
    });
});

describe(`resolveOpenFile over the daemon's control plane`, () => {
    it(`refuses the entries the file API refuses, from the path alone`, () => {
        expect(resolveOpenFile(`${STATE_DIR}/records/sessions/claude/projects/x.jsonl`, 1000)).toEqual({ kind: `locked` });
        expect(resolveOpenFile(`${STATE_DIR}/config/capabilities.json`, 1000)).toEqual({ kind: `locked` });
    });

    it(`opens a plan document as the document it is`, () => {
        // Plan documents live inside the locked session store but are not themselves locked.
        expect(resolveOpenFile(`${PLAN_DOCUMENTS_DIR}/twinkly-soaring-floyd.md`, 1000)).toEqual({ kind: `markdown`, lang: `markdown` });
    });
});

describe(`resolveOpenFile with viewers registered`, () => {
    it(`lets a viewer claim an extension the core called binary`, () => {
        register(`image`, [`png`, `jpg`], `blob`);
        expect(resolveOpenFile(`logo.png`, 1000)).toMatchObject({ kind: `viewer`, viewer: { id: `image`, fetch: `blob` } });
        expect(resolveOpenFile(`shots/Logo.PNG`, 1000)).toMatchObject({ kind: `viewer` });
        expect(resolveOpenFile(`bundle.zip`, 1000)).toEqual({ kind: `binary` });
    });

    it(`lets a viewer claim a TEXT extension: that is what makes an .svg a picture`, () => {
        expect(resolveOpenFile(`icon.svg`, 1000)).toEqual({ kind: `code`, lang: `xml` });
        register(`svg`, [`svg`], `text`);
        expect(resolveOpenFile(`icon.svg`, 1000)).toMatchObject({ kind: `viewer`, viewer: { fetch: `text` } });
    });

    it(`returns to the core's answer when the extension is switched off`, () => {
        register(`image`, [`png`], `blob`);
        expect(resolveOpenFile(`logo.png`, 1000)).toMatchObject({ kind: `viewer` });
        disposables.pop()?.dispose();
        expect(resolveOpenFile(`logo.png`, 1000)).toEqual({ kind: `binary` });
    });

    it(`never hands a viewer an empty file`, () => {
        register(`image`, [`png`], `blob`);
        register(`media`, [`mp4`], `url`);
        expect(resolveOpenFile(`logo.png`, 0)).toEqual({ kind: `empty` });
        expect(resolveOpenFile(`clip.mp4`, 0)).toEqual({ kind: `empty` });
    });

    it(`prefers an editing viewer over a render-only one for the same extension, whichever registered first`, () => {
        register(`office`, [`docx`], `path`, { owner: `intentic.onlyoffice`, edit: true });
        register(`docx`, [`docx`], `blob`);
        expect(resolveOpenFile(`brief.docx`, 1000)).toMatchObject({ kind: `viewer`, viewer: { id: `office`, fetch: `path` } });
        // The editor switched off: the render-only viewer takes the format back.
        disposables.shift()?.dispose();
        expect(resolveOpenFile(`brief.docx`, 1000)).toMatchObject({ kind: `viewer`, viewer: { id: `docx`, fetch: `blob` } });
    });

    it(`never size-gates a path viewer: its backend reads the file, not /workspace/raw`, () => {
        register(`office`, [`xlsx`], `path`, { edit: true });
        expect(resolveOpenFile(`ledger.xlsx`, RAW_MAX_BYTES + 1)).toMatchObject({ kind: `viewer`, viewer: { id: `office` } });
    });
});

// A `blob` viewer is refused past the size cap since /workspace/raw holds the whole answer in memory; a `url` viewer
// range-reads /workspace/media and isn't size-gated.
describe(`resolveOpenFile size gates follow the fetch kind`, () => {
    it(`refuses an oversize blob and streams an oversize url`, () => {
        register(`docx`, [`docx`], `blob`);
        register(`media`, [`mp4`], `url`);
        expect(resolveOpenFile(`report.docx`, RAW_MAX_BYTES + 1)).toEqual({ kind: `too-large` });
        expect(resolveOpenFile(`film.mp4`, RAW_MAX_BYTES * 80)).toMatchObject({ kind: `viewer`, viewer: { fetch: `url` } });
    });

    it(`proceeds optimistically when the tree never reported a size`, () => {
        register(`docx`, [`docx`], `blob`);
        expect(resolveOpenFile(`report.docx`, undefined)).toMatchObject({ kind: `viewer` });
    });
});

// Last registration wins: a later-loaded extension can override a builtin viewer for the same type.
describe(`resolveOpenFile viewer precedence`, () => {
    it(`gives the file to the most recently registered claimant`, () => {
        register(`image`, [`png`], `blob`);
        register(`fancy-image`, [`png`], `url`);
        expect(resolveOpenFile(`logo.png`, 1000)).toMatchObject({ kind: `viewer`, viewer: { id: `fancy-image` } });
    });
});

describe(`renderViewerForExtension, for a surface holding bytes rather than a path`, () => {
    it(`passes over a path-fed editing viewer, whatever its rank, for one that can be handed the bytes`, () => {
        register(`docx`, [`docx`], `blob`);
        register(`office`, [`docx`], `path`, { owner: `intentic.onlyoffice`, edit: true });
        expect(resolveOpenFile(`brief.docx`, 1000)).toMatchObject({ kind: `viewer`, viewer: { id: `office` } });
        expect(renderViewerForExtension(`docx`)).toMatchObject({ id: `docx`, fetch: `blob` });
        expect(renderViewerForExtension(`DOCX`)).toMatchObject({ id: `docx` });
    });

    it(`answers nothing when only a path viewer claims the extension`, () => {
        register(`office`, [`xlsx`], `path`, { owner: `intentic.onlyoffice`, edit: true });
        expect(renderViewerForExtension(`xlsx`)).toBeUndefined();
    });
});
