import { describe, expect, it } from "vitest";
import { codeLangForPath, langFromShebang, RAW_MAX_BYTES, resolveFile } from "./fileType";

// Empty (0-byte) files: text types stay editable (code/markdown); non-text preview types show the "empty" fallback.
describe(`resolveFile empty files`, () => {
    it(`empty text files resolve to an editable mode`, () => {
        expect(resolveFile(`new.ts`, 0)).toEqual({ mode: `code`, lang: `typescript` });
        expect(resolveFile(`README.md`, 0)).toEqual({ mode: `markdown` });
        expect(resolveFile(`.gitignore`, 0)).toEqual({ mode: `code`, lang: `gitignore` });
    });

    it(`empty non-text files stay "empty"`, () => {
        expect(resolveFile(`logo.png`, 0)).toEqual({ mode: `empty` });
        expect(resolveFile(`doc.pdf`, 0)).toEqual({ mode: `empty` });
        expect(resolveFile(`icon.svg`, 0)).toEqual({ mode: `empty` });
        expect(resolveFile(`archive.zip`, 0)).toEqual({ mode: `empty` });
        expect(resolveFile(`song.mp3`, 0)).toEqual({ mode: `empty` });
        expect(resolveFile(`report.docx`, 0)).toEqual({ mode: `empty` });
        expect(resolveFile(`sheet.xlsx`, 0)).toEqual({ mode: `empty` });
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

// Config dotfiles carry no usable extension (dot at index 0), so langFor matches them by name — generically
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

// Raw-byte preview families: audio plays inline, docx/xlsx parse client-side. All fetched via /workspace/raw,
// so the 25 MiB cap sends oversize files to the download fallback.
describe(`resolveFile audio / docx / xlsx`, () => {
    it(`routes each extension to its own mode`, () => {
        for (const ext of [`mp3`, `wav`, `flac`, `ogg`, `m4a`, `aac`]) {
            expect(resolveFile(`clip.${ext}`, 1000)).toEqual({ mode: `audio` });
        }
        expect(resolveFile(`report.docx`, 1000)).toEqual({ mode: `docx` });
        expect(resolveFile(`budget.xlsx`, 1000)).toEqual({ mode: `xlsx` });
    });

    it(`falls back to a download past the raw cap`, () => {
        expect(resolveFile(`clip.mp3`, RAW_MAX_BYTES + 1)).toEqual({ mode: `too-large` });
        expect(resolveFile(`report.docx`, RAW_MAX_BYTES + 1)).toEqual({ mode: `too-large` });
        expect(resolveFile(`budget.xlsx`, RAW_MAX_BYTES + 1)).toEqual({ mode: `too-large` });
    });
});

// The content-based fallback used post-fetch when the filename resolved no language (extensionless scripts
// like `intentic-machine-boot`), mirroring VSCode's first-line detection.
describe(`langFromShebang`, () => {
    it(`maps absolute-path shells to bash`, () => {
        expect(langFromShebang(`#!/bin/sh\nset -eu\n`)).toBe(`bash`);
        expect(langFromShebang(`#!/bin/bash -x`)).toBe(`bash`);
        expect(langFromShebang(`#!/usr/bin/zsh`)).toBe(`bash`);
    });

    it(`resolves the interpreter through env, skipping flags`, () => {
        expect(langFromShebang(`#!/usr/bin/env bash`)).toBe(`bash`);
        expect(langFromShebang(`#!/usr/bin/env -S bash -eu`)).toBe(`bash`);
        expect(langFromShebang(`#!/usr/bin/env node`)).toBe(`javascript`);
    });

    it(`trims version suffixes`, () => {
        expect(langFromShebang(`#!/usr/bin/python3`)).toBe(`python`);
        expect(langFromShebang(`#!/usr/bin/env python3.11`)).toBe(`python`);
    });

    it(`covers the other shipped interpreters`, () => {
        expect(langFromShebang(`#!/usr/bin/env ruby`)).toBe(`ruby`);
        expect(langFromShebang(`#!/usr/bin/env php`)).toBe(`php`);
        expect(langFromShebang(`#!/usr/bin/env pwsh`)).toBe(`powershell`);
        expect(langFromShebang(`#!/usr/bin/env deno run`)).toBe(`typescript`);
    });

    it(`returns undefined without a shebang or for an unshipped interpreter`, () => {
        expect(langFromShebang(`set -eu\necho hi\n`)).toBeUndefined();
        expect(langFromShebang(``)).toBeUndefined();
        expect(langFromShebang(`#!/usr/bin/env perl`)).toBeUndefined();
        expect(langFromShebang(`#!`)).toBeUndefined();
    });
});

// The path→lang resolver the chat's Read cards share with the workspace viewer: the same extension table and
// dockerfile/.env/ignore specials as resolveFile, but from a bare path (no size gate, no content shebang).
describe(`codeLangForPath`, () => {
    it(`resolves by extension, ignoring the directory prefix`, () => {
        expect(codeLangForPath(`src/app/main.ts`)).toBe(`typescript`);
        expect(codeLangForPath(`a/b/c/styles.scss`)).toBe(`scss`);
        expect(codeLangForPath(`main.py`)).toBe(`python`);
    });

    it(`matches the extensionless specials by name`, () => {
        expect(codeLangForPath(`services/Dockerfile`)).toBe(`docker`);
        expect(codeLangForPath(`.env.local`)).toBe(`dotenv`);
        expect(codeLangForPath(`.dockerignore`)).toBe(`gitignore`);
        expect(codeLangForPath(`Makefile`)).toBe(`make`);
    });

    it(`returns undefined for an extension we ship no grammar for`, () => {
        expect(codeLangForPath(`notes.xyz`)).toBeUndefined();
        expect(codeLangForPath(`LICENSE`)).toBeUndefined();
    });
});
