import { expect, test } from "vitest";
import { includeGlobs } from "./search-globs.js";

test("an empty field scopes nothing", () => {
    expect(includeGlobs(undefined)).toEqual({ globs: [], notGlobs: [] });
    expect(includeGlobs(" , ")).toEqual({ globs: [], notGlobs: [] });
});

// The reported bug: a file name read as a folder name found nothing. Both forms come out, as VSCode's
// expandGlobalGlob emits them.
test("a bare name is a file as well as a folder, at any depth", () => {
    expect(includeGlobs(`package.json`).globs).toEqual([`**/package.json`, `**/package.json/**`]);
    expect(includeGlobs(`docs`).globs).toEqual([`**/docs`, `**/docs/**`]);
    // A trailing slash is noise — the folder form is generated either way.
    expect(includeGlobs(`docs/`).globs).toEqual([`**/docs`, `**/docs/**`]);
});

test("a path is matched at any depth unless ./ anchors it to the root", () => {
    expect(includeGlobs(`src/db`).globs).toEqual([`**/src/db`, `**/src/db/**`]);
    expect(includeGlobs(`./src/db`).globs).toEqual([`./src/db`, `./src/db/**`]);
    expect(includeGlobs(`/src/db`).globs).toEqual([`./src/db`, `./src/db/**`]);
});

test("a leading dot is the extension shorthand", () => {
    expect(includeGlobs(`.ts`).globs).toEqual([`**/*.ts`, `**/*.ts/**`]);
});

test("wildcards are passed through as typed", () => {
    expect(includeGlobs(`*.test.ts`).globs).toEqual([`**/*.test.ts`, `**/*.test.ts/**`]);
    expect(includeGlobs(`src/**/*.vue`).globs).toEqual([`**/src/**/*.vue`, `**/src/**/*.vue/**`]);
});

test("commas separate patterns except inside a brace group or a character class", () => {
    expect(includeGlobs(`*.{ts,py}`).globs).toEqual([`**/*.{ts,py}`, `**/*.{ts,py}/**`]);
    expect(includeGlobs(`f[a,b].ts`).globs).toEqual([`**/f[a,b].ts`, `**/f[a,b].ts/**`]);
    expect(includeGlobs(`docs, *.md`).globs).toEqual([`**/docs`, `**/docs/**`, `**/*.md`, `**/*.md/**`]);
});

test("a leading ! excludes instead", () => {
    expect(includeGlobs(`src, !*.test.ts`)).toEqual({
        globs: [`**/src`, `**/src/**`],
        notGlobs: [`**/*.test.ts`, `**/*.test.ts/**`],
    });
    // A lone "!" excludes nothing — expanded, it would have matched everything.
    expect(includeGlobs(`!`)).toEqual({ globs: [], notGlobs: [] });
});
