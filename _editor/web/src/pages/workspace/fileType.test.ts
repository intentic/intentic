import { describe, expect, it } from "vitest";
import { codeLangForPath } from "@intentic/code-read";
import { rendersAsBytes, resolveFile, TEXT_EDIT_MAX_BYTES } from "./fileType";

// Empty (0-byte) files: text types stay editable (code/markdown); binary ones show the "empty" fallback.
describe(`resolveFile empty files`, () => {
    it(`empty text files resolve to an editable mode`, () => {
        expect(resolveFile(`new.ts`, 0)).toEqual({ mode: `code`, lang: `typescript` });
        expect(resolveFile(`README.md`, 0)).toEqual({ mode: `markdown`, lang: `markdown` });
        expect(resolveFile(`.gitignore`, 0)).toEqual({ mode: `code`, lang: `gitignore` });
        // SVG is text here too: the picture is a viewers extension's job, the markup is the core's.
        expect(resolveFile(`icon.svg`, 0)).toEqual({ mode: `code`, lang: `xml` });
    });

    it(`empty binary files stay "empty"`, () => {
        expect(resolveFile(`logo.png`, 0)).toEqual({ mode: `empty` });
        expect(resolveFile(`doc.pdf`, 0)).toEqual({ mode: `empty` });
        expect(resolveFile(`archive.zip`, 0)).toEqual({ mode: `empty` });
        expect(resolveFile(`song.mp3`, 0)).toEqual({ mode: `empty` });
        expect(resolveFile(`clip.mp4`, 0)).toEqual({ mode: `empty` });
        expect(resolveFile(`report.docx`, 0)).toEqual({ mode: `empty` });
        expect(resolveFile(`sheet.xlsx`, 0)).toEqual({ mode: `empty` });
    });
});

/* Both TEXT modes carry a grammar, not just `code`. Markdown renders its source through the same editor, so a
 * viewer that shows source, and the DIFF surface, which is one component for both: gets the language from the
 * resolution rather than hardcoding one per mode. Markdown used to resolve with no `lang` at all, which is
 * exactly how .md diffs ended up as uncolored plaintext while the file viewer looked fine. */
describe(`resolveFile text modes carry a lang`, () => {
    it(`resolves a grammar for markdown`, () => {
        expect(resolveFile(`ARCHITECTURE.md`, 1000)).toEqual({ mode: `markdown`, lang: `markdown` });
        expect(resolveFile(`notes.markdown`, 1000)).toEqual({ mode: `markdown`, lang: `markdown` });
        expect(resolveFile(`page.mdx`, 1000)).toEqual({ mode: `markdown`, lang: `markdown` });
    });

    it(`resolves svg markup as xml`, () => {
        expect(resolveFile(`icon.svg`, 1000)).toEqual({ mode: `code`, lang: `xml` });
        // The same answer for a path, whichever surface asks: this is what the chat's Read card colors from too.
        expect(codeLangForPath(`icon.svg`)).toBe(`xml`);
    });

    /* The component formats, whose one file holds markup, script and styles together. `.astro` had no row at
     * all while its siblings did, so a component that reads as three languages in its editor came out of the
     * DIFF surface as undivided grey text: the same failure as markdown's, one extension along. */
    it(`resolves a grammar for component files`, () => {
        expect(codeLangForPath(`Card.vue`)).toBe(`vue`);
        expect(codeLangForPath(`Card.svelte`)).toBe(`svelte`);
        expect(resolveFile(`docs/extensions/build.astro`, 1000)).toEqual({ mode: `code`, lang: `astro` });
    });

    it(`applies the highlight cap to every text mode, not just code`, () => {
        expect(resolveFile(`huge.md`, 1_000_000)).toEqual({ mode: `markdown` });
        expect(resolveFile(`huge.svg`, 1_000_000)).toEqual({ mode: `code` });
    });
});

// .env files have no regular extension (dot at index 0), so langFor matches them by name.
describe(`resolveFile dotenv`, () => {
    it(`highlights .env variants as dotenv`, () => {
        expect(resolveFile(`.env`, 100)).toEqual({ mode: `code`, lang: `dotenv` });
        expect(resolveFile(`.env.example`, 100)).toEqual({ mode: `code`, lang: `dotenv` });
        expect(resolveFile(`.env.local`, 100)).toEqual({ mode: `code`, lang: `dotenv` });
        expect(resolveFile(`config/prod.env`, 100)).toEqual({ mode: `code`, lang: `dotenv` });
    });
});

// Config dotfiles carry no usable extension (dot at index 0), so langFor matches them by name: generically
// for the ".xxxignore" family, exactly for the rest.
describe(`resolveFile config dotfiles`, () => {
    it(`highlights ignore files as gitignore`, () => {
        expect(resolveFile(`.gitignore`, 100)).toEqual({ mode: `code`, lang: `gitignore` });
        expect(resolveFile(`.dockerignore`, 100)).toEqual({ mode: `code`, lang: `gitignore` });
        expect(resolveFile(`.prettierignore`, 100)).toEqual({ mode: `code`, lang: `gitignore` });
        expect(resolveFile(`.gitattributes`, 100)).toEqual({ mode: `code`, lang: `gitignore` });
    });

    it(`maps known config names to shipped grammars`, () => {
        expect(resolveFile(`.npmrc`, 100)).toEqual({ mode: `code`, lang: `ini` });
        expect(resolveFile(`.editorconfig`, 100)).toEqual({ mode: `code`, lang: `ini` });
        expect(resolveFile(`.prettierrc`, 100)).toEqual({ mode: `code`, lang: `json` });
        expect(resolveFile(`.zshrc`, 100)).toEqual({ mode: `code`, lang: `bash` });
        expect(resolveFile(`Makefile`, 100)).toEqual({ mode: `code`, lang: `make` });
        expect(resolveFile(`manifest.webmanifest`, 100)).toEqual({ mode: `code`, lang: `json` });
    });

    it(`leaves unknown dotfiles plain`, () => {
        expect(resolveFile(`.foorc`, 100)).toEqual({ mode: `code`, lang: undefined });
    });
});

/* The formats a VIEWERS EXTENSION renders. The core's answer for all of them is `binary`: opaque bytes, and
 * a download, with no size gate and no per-format branch: which of them is actually showable, and what the
 * ceiling is, belongs to the extension that claims the extension (viewers/openFile.ts). Listing them here is
 * what makes switching that extension off degrade to a download rather than to mojibake. */
describe(`resolveFile leaves extension-owned formats binary`, () => {
    it(`claims no picture, document, or recording for itself`, () => {
        for (const name of [`logo.png`, `photo.jpeg`, `anim.gif`, `doc.pdf`, `report.docx`, `budget.xlsx`]) {
            expect(resolveFile(name, 1000)).toEqual({ mode: `binary` });
        }
        for (const ext of [`mp3`, `wav`, `flac`, `ogg`, `opus`, `m4a`, `aac`, `mp4`, `mov`, `webm`, `mkv`, `avi`]) {
            expect(resolveFile(`clip.${ext}`, 1000)).toEqual({ mode: `binary` });
        }
    });

    it(`applies no size gate: a viewer that streams has no ceiling to pre-empt`, () => {
        expect(resolveFile(`film.mp4`, 2_000_000_000)).toEqual({ mode: `binary` });
    });
});


// Which diffs the byte viewer takes over. The daemon's `binary` flag answers for a file whose extension says
// nothing; the PATH answers for the case that flag misses entirely: an image over the 512 KiB text-diff cap,
// which arrives flagged `truncated` and is nonetheless perfectly showable.
describe(`rendersAsBytes`, () => {
    it(`takes the daemon's word when a file has NUL bytes and no telling extension`, () => {
        expect(rendersAsBytes(`data`, true)).toBe(true);
        expect(rendersAsBytes(`notes.txt`, true)).toBe(true);
    });

    it(`claims every non-text path regardless of what the response said`, () => {
        // The case this exists for: a big screenshot, reported truncated rather than binary.
        expect(rendersAsBytes(`shots/rg-2.png`, undefined)).toBe(true);
        expect(rendersAsBytes(`doc.pdf`, undefined)).toBe(true);
        expect(rendersAsBytes(`fonts/Inter.woff2`, undefined)).toBe(true);
        expect(rendersAsBytes(`bundle.zip`, undefined)).toBe(true);
    });

    it(`leaves text to the text diff, including the genuinely oversized kind`, () => {
        expect(rendersAsBytes(`src/main.ts`, undefined)).toBe(false);
        expect(rendersAsBytes(`README.md`, undefined)).toBe(false);
        // SVG is text and gets a source toggle in the viewer: it is diffable as lines.
        expect(rendersAsBytes(`icon.svg`, undefined)).toBe(false);
        // …and a recording is not, however many viewers claim it.
        expect(rendersAsBytes(`clip.mp4`, undefined)).toBe(true);
        expect(rendersAsBytes(`LICENSE`, undefined)).toBe(false);
    });
});

/* Text no longer dead-ends on size. It used to resolve to `too-large`: a panel offering nothing but a Download
 * that itself 413s above RAW_MAX_BYTES, so a big log could be neither read nor saved. And because the size came
 * from a tree entry, a file the loaded tree didn't hold resolved with `size: undefined` and skipped every cap.
 * Text now always resolves to text; FileViewer decides editable-vs-windowed from the size the daemon reports. */
describe(`resolveFile large text`, () => {
    it(`resolves text to text at any size`, () => {
        expect(resolveFile(`build.log`, TEXT_EDIT_MAX_BYTES * 60)).toEqual({ mode: `code` });
        expect(resolveFile(`app.ts`, TEXT_EDIT_MAX_BYTES * 60)).toEqual({ mode: `code` });
        expect(resolveFile(`ARCHITECTURE.md`, TEXT_EDIT_MAX_BYTES * 60)).toEqual({ mode: `markdown` });
    });

    it(`drops the tokenizer past the highlight cap, whatever the extension says`, () => {
        expect(resolveFile(`app.ts`, 1_000_000)).toEqual({ mode: `code` });
        expect(resolveFile(`app.ts`, 1000)).toEqual({ mode: `code`, lang: `typescript` });
    });

    it(`treats an unknown size optimistically: the read is bounded either way`, () => {
        expect(resolveFile(`mystery.log`, undefined)).toEqual({ mode: `code`, lang: `log` });
    });
});
