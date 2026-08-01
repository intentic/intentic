import { afterEach, describe, expect, it } from "vitest";
import { registerViewer } from "../../../core-views/viewerRegistry";
import { RAW_MAX_BYTES } from "../fileType";
import { resolveOpenFile } from "./openFile";

/* The order between the core's text resolver and the extensions' viewer registry — the whole reason FileViewer
 * has no per-format branches. Registrations are made and disposed per test against the real registry (a
 * module-level singleton, the app's no-Pinia convention): the disposal path is half of what is under test,
 * since it is what "switch the extension off" runs. */

const component = async (): Promise<never> => {
    throw new Error(`never rendered in these tests`);
};

const disposables: { dispose: () => void }[] = [];
const register = (id: string, extensions: readonly string[], fetch: "text" | "blob" | "url"): void => {
    disposables.push(registerViewer({ owner: `intentic.viewers`, id, extensions, fetch, component: component as never }));
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
        // The behaviour this whole split is built to guarantee: no viewers extension ⇒ a download, not a crash
        // and not mojibake.
        expect(resolveOpenFile(`clip.mp4`, 1000)).toEqual({ kind: `binary` });
        expect(resolveOpenFile(`logo.png`, 1000)).toEqual({ kind: `binary` });
    });
});

describe(`resolveOpenFile with viewers registered`, () => {
    it(`lets a viewer claim an extension the core called binary`, () => {
        register(`image`, [`png`, `jpg`], `blob`);
        expect(resolveOpenFile(`logo.png`, 1000)).toMatchObject({ kind: `viewer`, viewer: { id: `image`, fetch: `blob` } });
        // Case-insensitively — a screenshot off a phone is as likely to be .PNG.
        expect(resolveOpenFile(`shots/Logo.PNG`, 1000)).toMatchObject({ kind: `viewer` });
        // An extension nobody claimed is untouched.
        expect(resolveOpenFile(`bundle.zip`, 1000)).toEqual({ kind: `binary` });
    });

    it(`lets a viewer claim a TEXT extension — that is what makes an .svg a picture`, () => {
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
});

/* Only a `blob` viewer can be beaten by size, and that is the point of the fetch kinds: it is served by
 * /workspace/raw, which holds the whole answer in memory and 413s past the cap. A `url` viewer range-reads
 * /workspace/media, which is exactly why video was unopenable before it existed. */
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

// Last registration wins, so a later-loaded extension can override a builtin viewer for the same type.
describe(`resolveOpenFile viewer precedence`, () => {
    it(`gives the file to the most recently registered claimant`, () => {
        register(`image`, [`png`], `blob`);
        register(`fancy-image`, [`png`], `url`);
        expect(resolveOpenFile(`logo.png`, 1000)).toMatchObject({ kind: `viewer`, viewer: { id: `fancy-image` } });
    });
});
