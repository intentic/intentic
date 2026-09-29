import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveIn, SEARCH_BOUNDS, type SearchQuery, searchFolder } from "./search.js";

// Search and the lookup of a written path, over a real folder: what is read and what is left alone (ignored folders, a
// version history, binaries, a link out), how a line and its matches come back, and where a search stops.

let base: string;
let root: string;
beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), `local-files-search-`)));
    root = join(base, `project`);
    const files = {
        ".gitignore": `build\n`,
        "src/app.ts": `export const greet = (name: string) => \`Hello, \${name}\`;\nconst hello = 1;\n`,
        "src/util/strings.ts": `// helpers\nexport const hello_world = 2;\n`,
        "docs/guide.md": `# Guide\nSay Hello to everyone.\nhello again, hello\n`,
        "docs/util-notes.md": `Crème brûlée\n`,
        "docs/index.md": `docs index\n`,
        "blog/index.md": `blog index\n`,
        "build/out.js": `hello from the build\n`,
        "node_modules/pkg/index.js": `hello from a package\n`,
        ".git/HEAD": `hello from git\n`,
        "image.png": Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x68, 0x65, 0x6c, 0x6c, 0x6f]),
    } satisfies Readonly<Record<string, string | Uint8Array>>;
    for (const [path, content] of Object.entries(files)) {
        mkdirSync(join(root, path, `..`), { recursive: true });
        writeFileSync(join(root, path), content);
    }
    writeFileSync(join(base, `outside.md`), `hello from outside\n`);
    symlinkSync(join(base, `outside.md`), join(root, `link-out.md`));
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

const find = (query: string, options: Omit<SearchQuery, `query`> = {}) => searchFolder(root, { query, mode: `find`, ...options });
const paths = async (query: string, options: Omit<SearchQuery, `query`> = {}): Promise<string[]> =>
    (await find(query, options)).groups.map((group) => group.path);

describe(`a text search`, () => {
    it(`finds every line, most matches first, and reads nothing ignored, locked, binary or outside`, async () => {
        const found = await find(`hello`);
        expect(found).toMatchObject({ mode: `find`, total: 5, files: 3, shown: 5, truncated: false, freshness: { state: `fresh` } });
        expect(found.groups.map((group) => [group.path, group.hits.map((hit) => hit.line)])).toEqual([
            [`docs/guide.md`, [2, 3]],
            [`src/app.ts`, [1, 2]],
            [`src/util/strings.ts`, [2]],
        ]);
        expect(found.groups[0]?.hits[1]).toEqual({ line: 3, text: `hello again, hello`, spans: [{ start: 0, end: 5 }, { start: 13, end: 18 }], tags: [{ kind: `text` }] });
    });

    // Offsets count characters as the page slices them, not the bytes on disk.
    it(`spans a match by character, past letters that take more than a byte`, async () => {
        expect((await find(`brûlée`)).groups[0]?.hits[0]).toMatchObject({ line: 1, text: `Crème brûlée`, spans: [{ start: 6, end: 12 }] });
    });

    it(`honours case, whole words and plain text as the search box asks`, async () => {
        expect(await paths(`Hello`, { caseSensitive: true })).toEqual([`docs/guide.md`, `src/app.ts`]);
        expect(await paths(`hello`, { word: true })).toEqual([`docs/guide.md`, `src/app.ts`]);
        expect(await paths(`\${name}`, { literal: true })).toEqual([`src/app.ts`]);
        expect(await paths(`h.llo_w`)).toEqual([`src/util/strings.ts`]);
    });

    // A pattern this engine cannot read is still a question: it is asked as plain text, and the answer says so.
    it(`searches a pattern it cannot read as plain text, and says it did`, async () => {
        const found = await find(`(name`);
        expect(found.groups.map((group) => group.path)).toEqual([`src/app.ts`]);
        expect(found.note).toBe(`The query isn't a pattern this search reads, so it was searched as plain text.`);
    });

    it(`looks inside ignored folders when asked, and never inside a version history`, async () => {
        expect(await paths(`hello from`, { includeIgnored: true })).toEqual([`build/out.js`, `node_modules/pkg/index.js`]);
    });

    it(`narrows to a folder and to the files to include`, async () => {
        expect(await paths(`hello`, { dir: `src` })).toEqual([`src/app.ts`, `src/util/strings.ts`]);
        expect(await paths(`hello`, { include: `*.md` })).toEqual([`docs/guide.md`]);
        expect(await paths(`hello`, { include: `!docs` })).toEqual([`src/app.ts`, `src/util/strings.ts`]);
        expect(await paths(`hello`, { dir: `../` })).toEqual([]);
    });

    it(`pages by file, and hands back where the next page starts`, async () => {
        const first = await find(`hello`, { limit: 2 });
        expect([first.groups.map((group) => group.path), first.shown, first.cursor, first.truncated]).toEqual([[`docs/guide.md`, `src/app.ts`], 4, `2`, true]);
        const next = await find(`hello`, { limit: 2, after: first.cursor });
        expect([next.groups.map((group) => group.path), next.cursor, next.truncated, next.total]).toEqual([[`src/util/strings.ts`], undefined, false, 5]);
    });

    // A pattern that backtracks without end would hold every window of the app while it ran on one line.
    it(`refuses a pattern that could backtrack without end, and searches the same text as typed`, async () => {
        await expect(find(`(a+)+$`)).rejects.toMatchObject({
            status: 400,
            message: `This pattern could take too long to search. Simplify it, or search for the text as typed.`,
        });
        expect((await find(`(a+)+$`, { literal: true })).groups).toEqual([]);
    });

    // A clock that moves a millisecond each time it is read: the budget runs out on a count of reads, not on a race.
    it(`stops inside a long file when the budget runs out, rather than at its end`, async () => {
        mkdirSync(join(root, `long`));
        writeFileSync(join(root, `long`, `log.txt`), `${`x\n`.repeat(1_000)}needle\n`);
        let tick = 0;
        const found = await searchFolder(root, { query: `needle`, dir: `long` }, { ...SEARCH_BOUNDS, budgetMs: 50, now: () => tick++ });
        expect(found).toMatchObject({ files: 0, truncated: true, partial: true });
        expect(await paths(`needle`, { dir: `long` })).toEqual([`long/log.txt`]);
    });

    // A bound that stops the search makes every count a floor, and the answer says how to get the rest.
    it(`says when a bound stopped it`, async () => {
        const found = await searchFolder(root, { query: `hello` }, { ...SEARCH_BOUNDS, scanned: 2 });
        // The first two files the walk meets are the top level's own, neither of which says hello.
        expect(found).toMatchObject({
            files: 0,
            truncated: true,
            partial: true,
            note: `Stopped early: the folder is larger than one search reads. Narrow it to a folder or a file pattern.`,
        });
    });
});

describe(`a file-name search`, () => {
    // The same scorer as quick-open's: a name that holds the query beats a folder that does.
    it(`ranks a match in a file's own name first`, async () => {
        const found = await searchFolder(root, { query: `util`, mode: `files` });
        expect(found.groups.map((group) => group.path)).toEqual([`docs/util-notes.md`, `src/util/strings.ts`]);
        expect(found).toMatchObject({ mode: `files`, total: 2, files: 2 });
        expect(found.groups[0]?.hits).toEqual([{ line: 1, text: `docs/util-notes.md`, spans: [], tags: [{ kind: `fuzzy`, score: found.groups[0]?.score }] }]);
    });

    it(`runs any other mode as a text search`, async () => {
        expect((await searchFolder(root, { query: `hello again`, mode: `sym` })).mode).toBe(`find`);
    });
});

describe(`resolveIn`, () => {
    it(`answers a path that is there as written`, async () => {
        expect(await resolveIn(root, `src/app.ts`)).toEqual({ path: `src/app.ts` });
        expect(await resolveIn(root, join(root, `docs`, `guide.md`))).toEqual({ path: `docs/guide.md` });
    });

    it(`finds the one file a path's ending or a bare name means`, async () => {
        expect(await resolveIn(root, `packages/web/src/util/strings.ts`)).toEqual({ path: `src/util/strings.ts` });
        expect(await resolveIn(root, `strings.ts`)).toEqual({ path: `src/util/strings.ts` });
        expect(await resolveIn(root, `blog/index.md`)).toEqual({ path: `blog/index.md` });
    });

    // The walk stopped before the folder was all looked at: here the twin past where it stopped is real.
    it(`resolves nothing by name when the walk was cut short, but still what is there as written`, async () => {
        mkdirSync(join(root, `vendor`, `lib`, `text`), { recursive: true });
        writeFileSync(join(root, `vendor`, `lib`, `text`, `strings.ts`), `export {};\n`);
        expect(await resolveIn(root, `strings.ts`, { ...SEARCH_BOUNDS, scanned: 1 })).toEqual({});
        expect(await resolveIn(root, `src/util/strings.ts`, { ...SEARCH_BOUNDS, scanned: 1 })).toEqual({ path: `src/util/strings.ts` });
        expect(await resolveIn(root, `util/strings.ts`)).toEqual({ path: `src/util/strings.ts` });
    });

    // Two files end that way: a guess would be a link to the wrong one.
    it(`resolves nothing that two files could mean, or that nothing means`, async () => {
        expect(await resolveIn(root, `index.md`)).toEqual({});
        expect(await resolveIn(root, `gone.md`)).toEqual({});
        expect(await resolveIn(root, `out.js`)).toEqual({});
    });
});
