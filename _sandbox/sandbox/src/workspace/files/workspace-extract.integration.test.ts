import { execFile, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { requires } from "@intentic/testing/requires";
import { extractArchive, UnknownArchiveError } from "./workspace-extract.js";

// Drives the real tar/gzip/unzip the daemon spawns, over real archives. The rules are covered with tar and gzip,
// which every Debian base carries, so the suite guards them wherever it runs; the zip pair is asserted separately
// because a CI image gains a new tool only after the image change lands (.github/workflows/ci.yml, the ci-base job).
// ci-base carries zip and unzip (_tools/ci-base/Dockerfile), so CI always runs the zip case.
const zipTools = requires(spawnSync(`sh`, [`-c`, `command -v zip && command -v unzip`]).status === 0, `zip and unzip on PATH`);

const run = promisify(execFile);
let root: string;

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), `extract-`));
});
afterEach(async () => {
    await rm(root, { recursive: true, force: true });
});

// Writes `files` (path → contents) under a staging folder and packs them into `archive`, whose suffix picks the tool.
const archiveOf = async (archive: string, files: Record<string, string>): Promise<string> => {
    const staging = join(root, `.staging`);
    await rm(staging, { recursive: true, force: true });
    for (const [path, contents] of Object.entries(files)) {
        await mkdir(join(staging, dirname(path)), { recursive: true });
        await writeFile(join(staging, path), contents);
    }
    const target = join(root, archive);
    const members = [...new Set(Object.keys(files).map((path) => path.split(`/`)[0] ?? path))];
    await (archive.endsWith(`.zip`)
        ? run(`zip`, [`-q`, `-r`, target, ...members], { cwd: staging })
        : run(`tar`, [`-c`, `-z`, `-f`, target, `-C`, staging, ...members]));
    await rm(staging, { recursive: true });
    return target;
};

const listing = async (dir: string): Promise<string[]> => (await readdir(dir)).toSorted();

test("an archive that is one folder of its own name lands as that folder, not as it twice", async () => {
    const archive = await archiveOf(`landing-page.tar.gz`, { "landing-page/index.html": `<h1>hi</h1>`, "landing-page/src/app.ts": `export {};` });
    const landed = await extractArchive(archive);
    expect(basename(landed)).toBe(`landing-page`);
    expect(await listing(landed)).toEqual([`index.html`, `src`]);
    expect(await readFile(join(landed, `index.html`), `utf8`)).toBe(`<h1>hi</h1>`);
});

test("a browser's copy marker still names the archive's own folder, and still collapses", async () => {
    const archive = await archiveOf(`landing-page (2).tar.gz`, { "landing-page/index.html": `x` });
    const landed = await extractArchive(archive);
    expect(basename(landed)).toBe(`landing-page (2)`);
    expect(await listing(landed)).toEqual([`index.html`]);
});

test("loose files are wrapped in a folder named after the archive", async () => {
    const archive = await archiveOf(`notes.tar.gz`, { "a.txt": `a`, "b.txt": `b` });
    const landed = await extractArchive(archive);
    expect(basename(landed)).toBe(`notes`);
    expect(await listing(landed)).toEqual([`a.txt`, `b.txt`]);
});

test("a single folder under another name is kept, since only a doubled name is the duplicate", async () => {
    const archive = await archiveOf(`bundle.tar.gz`, { "src/app.ts": `export {};` });
    const landed = await extractArchive(archive);
    expect(await listing(landed)).toEqual([`src`]);
});

test("a Mac's resource forks are dropped, so the folder they hid still collapses", async () => {
    const archive = await archiveOf(`site.tar.gz`, { "site/index.html": `x`, "__MACOSX/._index.html": `junk` });
    const landed = await extractArchive(archive);
    expect(await listing(landed)).toEqual([`index.html`]);
});

test("an existing folder of that name is never written over", async () => {
    await mkdir(join(root, `notes`));
    await writeFile(join(root, `notes/mine.txt`), `keep`);
    const landed = await extractArchive(await archiveOf(`notes.tar.gz`, { "a.txt": `a` }));
    expect(basename(landed)).toBe(`notes 2`);
    expect(await listing(join(root, `notes`))).toEqual([`mine.txt`]);
});

test("one compressed file lands as the file it was made from, beside the archive", async () => {
    await writeFile(join(root, `server.log`), `line one\n`);
    await run(`gzip`, [join(root, `server.log`)]);
    const landed = await extractArchive(join(root, `server.log.gz`));
    expect(basename(landed)).toBe(`server.log`);
    expect(await readFile(landed, `utf8`)).toBe(`line one\n`);
});

test("a format nothing here unpacks is refused before anything is created", async () => {
    await writeFile(join(root, `bundle.7z`), `not really`);
    await expect(extractArchive(join(root, `bundle.7z`))).rejects.toBeInstanceOf(UnknownArchiveError);
    expect(await listing(root)).toEqual([`bundle.7z`]);
});

test("a corrupt archive leaves no half-written folder behind", async () => {
    await writeFile(join(root, `broken.tar.gz`), `nothing a reader can use`);
    await expect(extractArchive(join(root, `broken.tar.gz`))).rejects.toThrow(/unpack broken\.tar\.gz/);
    expect(await listing(root)).toEqual([`broken.tar.gz`]);
});

// The zip path is its own tool with its own argv, so it is asserted against a real zip rather than assumed from tar.
test.skipIf(!zipTools.runs)(zipTools.title("a zip unpacks by the same rules"), async () => {
    const archive = await archiveOf(`landing-page (2).zip`, { "landing-page/index.html": `<h1>hi</h1>`, "landing-page/src/app.ts": `export {};` });
    const landed = await extractArchive(archive);
    expect(basename(landed)).toBe(`landing-page (2)`);
    expect(await listing(landed)).toEqual([`index.html`, `src`]);
    expect(await readFile(join(landed, `index.html`), `utf8`)).toBe(`<h1>hi</h1>`);
});
