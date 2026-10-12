import { globMatcher, includeGlobs, includeMatcher } from "../search-globs.js";

test("an empty field scopes nothing", () => {
    expect(includeGlobs(undefined)).toEqual({ globs: [], notGlobs: [] });
    expect(includeGlobs(" , ")).toEqual({ globs: [], notGlobs: [] });
});

// The reported bug: a file name read as a folder name found nothing. Both forms come out, as VSCode's
// expandGlobalGlob emits them.
test("a bare name is a file as well as a folder, at any depth", () => {
    expect(includeGlobs(`package.json`).globs).toEqual([`**/package.json`, `**/package.json/**`]);
    expect(includeGlobs(`docs`).globs).toEqual([`**/docs`, `**/docs/**`]);
    // A trailing slash is noise: the folder form is generated either way.
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
    // A lone "!" excludes nothing: expanded, it would have matched everything.
    expect(includeGlobs(`!`)).toEqual({ globs: [], notGlobs: [] });
});

describe("globMatcher", () => {
    // Every construct, held against Bun.Glob itself: the desktop folder server matches with Bun.Glob, so any
    // disagreement here is two machines admitting different files for one pattern.
    const patterns = [
        `*.ts`, `**/*.ts`, `**/*.[!t]s`, `**/*.[^t]s`, `src/**`, `src/**/*.ts`, `a/**/b`, `a?c`, `[a-c]x`, `[!a]`, `[]]`,
        `*.{ts,js}`, `{a,{b,c}}/*`, `a/{b,c/**}`, `{**/x,y}`, `a**b`, `**`, `**/`, `**/**/x`, `{,a}b`, `\\*x`, `**.ts`, `a/**b`,
    ];
    const paths = [
        `a.ts`, `a.js`, `a/b.ts`, `a/b.js`, `.hidden.ts`, `.x/y.ts`, `src`, `src/a.ts`, `src/a/b.ts`, `a/b`, `a/x/b`, `abc`, `a/c`,
        `bx`, `dx`, `/`, `a`, `]`, `c/x`, `a/c/d`, `a/x`, `x`, `y`, `axxb`, `ax/xb`, `b`, `ab`, `*x`, `a/xb`, `a/c/xb`, `a/`, `a/b/`,
    ];
    for (const pattern of patterns) {
        test(`reads ${pattern} as Bun.Glob does`, () => {
            const glob = new Bun.Glob(pattern);
            const matches = globMatcher(pattern);
            expect(paths.filter((path) => matches(path))).toEqual(paths.filter((path) => glob.match(path)));
        });
    }

    test("[!t] means anything but t", () => {
        const matches = globMatcher(`**/*.[!t]s`);
        expect([matches(`src/a.js`), matches(`src/a.ts`)]).toEqual([true, false]);
    });

    test("an unclosed set or group is literal", () => {
        expect([globMatcher(`[ab`)(`[ab`), globMatcher(`{a,b`)(`{a,b`)]).toEqual([true, true]);
    });
});

describe("includeMatcher", () => {
    test("admits by any include and refuses by any exclude", () => {
        const matches = includeMatcher(`src, !*.test.ts`);
        expect([`src/a.ts`, `src/a.test.ts`, `lib/src/b.ts`, `docs/c.md`].map(matches)).toEqual([true, false, true, false]);
    });

    test("an anchored include matches from the root only", () => {
        const matches = includeMatcher(`./src`);
        expect([matches(`src/a.ts`), matches(`lib/src/a.ts`)]).toEqual([true, false]);
    });

    test("nothing typed admits every path", () => {
        expect(includeMatcher(undefined)(`any/where.ts`)).toBe(true);
    });
});
