import { describe, expect, it } from "vitest";
import { codeLangForPath, highlightLangFor, langFromShebang } from "./lang-for-path.js";

// Which grammar a path resolves to, the first question every reading here asks: the table, the shebang
// fallback VSCode uses for extensionless scripts, and the size cap past which nothing is tokenized at all.

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

// The tokenizer decision once the daemon's size is in hand: extension, then shebang, and nothing over the cap.
describe(`highlightLangFor`, () => {
    it(`resolves from the extension`, () => {
        expect(highlightLangFor(`src/app.ts`, 1000, `export const a = 1;`)).toBe(`typescript`);
        expect(highlightLangFor(`build.log`, 1000, `2026-01-01 ok`)).toBe(`log`);
    });

    it(`falls back to the shebang for an extensionless script`, () => {
        expect(highlightLangFor(`run`, 1000, `#!/usr/bin/env bash\nset -eu\n`)).toBe(`bash`);
    });

    it(`gives up over the highlight cap: the size that matters is the daemon's, not the tree's`, () => {
        expect(highlightLangFor(`src/app.ts`, 1_000_000, `export const a = 1;`)).toBeUndefined();
        expect(highlightLangFor(`build.log`, 1_000_000, `2026-01-01 ok`)).toBeUndefined();
    });
});
