import { execFile, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
    ArchiveTooLargeError,
    archiveChildrenOf,
    archiveMemberPath,
    isBrowsableArchiveFile,
    resetArchiveCache,
    unpackedArchiveDir,
} from "./workspace-archive-browse.js";

// Drives the real unzip/tar the daemon spawns, over real archives, since what a listing says about an archive is only
// as true as the tool that unpacked it.
// zip is asserted separately: a CI image gains a new tool only after the image change lands (ci.yml, the ci-base job).
const ZIP_TOOLS = spawnSync(`sh`, [`-c`, `command -v zip && command -v unzip`]).status === 0;

const run = promisify(execFile);
let root: string;

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), `archive-browse-`));
    await resetArchiveCache();
});
afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await resetArchiveCache();
});

// Writes `files` (path → contents) under a staging folder and packs them into `archive`, whose suffix picks the tool.
// Contents may be bytes, so one archive can be packed into another without a utf8 round trip mangling it.
const archiveOf = async (archive: string, files: Record<string, string | Buffer>): Promise<string> => {
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

const names = async (absArchive: string, workspacePath: string, inside = ``): Promise<string[]> =>
    (await archiveChildrenOf(absArchive, workspacePath, inside)).entries.map((entry) => entry.path).toSorted();

test("an archive lists like the folder it holds, under its own path", async () => {
    const archive = await archiveOf(`notes.tar.gz`, { "a.txt": `a`, "deep/b.txt": `b` });
    expect(await names(archive, `drop/notes.tar.gz`)).toEqual([`drop/notes.tar.gz/a.txt`, `drop/notes.tar.gz/deep`]);
    expect(await names(archive, `drop/notes.tar.gz`, `deep`)).toEqual([`drop/notes.tar.gz/deep/b.txt`]);
});

test("the listing carries what the browser draws a tile from", async () => {
    const archive = await archiveOf(`notes.tar.gz`, { "a.txt": `hello`, "deep/b.txt": `b` });
    const { entries } = await archiveChildrenOf(archive, `notes.tar.gz`, ``);
    expect(entries.find((entry) => entry.name === `a.txt`)).toMatchObject({ type: `file`, size: 5 });
    expect(entries.find((entry) => entry.name === `deep`)).toMatchObject({ type: `dir` });
});

test("its contents are a real tree on disk, so a member reads as bytes", async () => {
    const archive = await archiveOf(`notes.tar.gz`, { "a.txt": `hello` });
    const dir = await unpackedArchiveDir(archive);
    expect(await readFile(join(dir, `a.txt`), `utf8`)).toBe(`hello`);
});

test("it is laid out the way Extract lays it out, so browsing and extracting agree", async () => {
    const archive = await archiveOf(`site.tar.gz`, { "site/index.html": `x`, "__MACOSX/._index.html": `junk` });
    expect(await names(archive, `site.tar.gz`)).toEqual([`site.tar.gz/index.html`]);
});

test("a .gitignore inside an archive hides nothing: it is the archive's own content", async () => {
    const archive = await archiveOf(`bundle.tar.gz`, { ".gitignore": `secret.txt\n`, "secret.txt": `s`, "node_modules/left.js": `x` });
    expect(await names(archive, `bundle.tar.gz`)).toEqual([
        `bundle.tar.gz/.gitignore`,
        `bundle.tar.gz/node_modules`,
        `bundle.tar.gz/secret.txt`,
    ]);
});

test("the same archive unpacks once, however many readers ask at the same time", async () => {
    const archive = await archiveOf(`notes.tar.gz`, { "a.txt": `a` });
    const [first, ...rest] = await Promise.all([unpackedArchiveDir(archive), unpackedArchiveDir(archive), unpackedArchiveDir(archive)]);
    expect(rest.every((dir) => dir === first)).toBe(true);
});

test("a rewritten archive lands somewhere else, so a listing can never be stale", async () => {
    const before = await unpackedArchiveDir(await archiveOf(`notes.tar.gz`, { "a.txt": `a` }));
    const after = await unpackedArchiveDir(await archiveOf(`notes.tar.gz`, { "a.txt": `changed` }));
    expect(after).not.toBe(before);
    expect(await readFile(join(after, `a.txt`), `utf8`)).toBe(`changed`);
});

test("an archive inside an archive opens too, out of its own unpacked copy", async () => {
    const inner = await archiveOf(`inner.tar.gz`, { "a.txt": `deep` });
    const outer = await archiveOf(`outer.tar.gz`, { "inner.tar.gz": await readFile(inner) });
    // The outer one lists the inner as the file it is.
    expect(await names(outer, `outer.tar.gz`)).toEqual([`outer.tar.gz/inner.tar.gz`]);
    // Entering it lists the inner's own contents, under the path that reached it.
    expect(await names(outer, `outer.tar.gz`, `inner.tar.gz`)).toEqual([`outer.tar.gz/inner.tar.gz/a.txt`]);
    // The member's bytes come from the inner archive's own unpacked copy, not the outer one's.
    const member = await archiveMemberPath(outer, `inner.tar.gz/a.txt`);
    expect(member).toMatch(/intentic-archives\/[\da-f]{64}\/a\.txt$/);
    expect(await readFile(member ?? ``, `utf8`)).toBe(`deep`);
});

test("a path that climbs out of an archive resolves to nothing", async () => {
    const archive = await archiveOf(`notes.tar.gz`, { "a.txt": `a` });
    expect(await archiveMemberPath(archive, `../../etc/passwd`)).toBeUndefined();
});

test("a corrupt archive fails without leaving a half-written tree to be read as complete", async () => {
    const archive = join(root, `broken.tar.gz`);
    await writeFile(archive, `nothing a reader can use`);
    await expect(unpackedArchiveDir(archive)).rejects.toThrow(/unpack broken\.tar\.gz/);
    // The second ask must fail the same way, not find the wreckage of the first.
    await expect(unpackedArchiveDir(archive)).rejects.toThrow(/unpack broken\.tar\.gz/);
});

test("an archive past the ceiling is refused rather than unpacked", async () => {
    const archive = join(root, `huge.zip`);
    await writeFile(archive, `x`);
    await expect(unpackedArchiveDir(archive, { maxBytes: 0 })).rejects.toBeInstanceOf(ArchiveTooLargeError);
});

test("only the formats holding a directory can be opened as one", async () => {
    await writeFile(join(root, `notes.txt.gz`), `x`);
    await expect(unpackedArchiveDir(join(root, `notes.txt.gz`))).rejects.toThrow(/holds no directory/);
});

test("a folder named like an archive is a folder", async () => {
    await mkdir(join(root, `photos.zip`));
    expect(isBrowsableArchiveFile(join(root, `photos.zip`))).toBe(false);
    await writeFile(join(root, `real.zip`), `x`);
    expect(isBrowsableArchiveFile(join(root, `real.zip`))).toBe(true);
    // One compressed file: there is no folder in it to open.
    await writeFile(join(root, `notes.txt.gz`), `x`);
    expect(isBrowsableArchiveFile(join(root, `notes.txt.gz`))).toBe(false);
});

// The zip path is its own tool with its own argv, so it is asserted against a real zip rather than assumed from tar.
test.skipIf(!ZIP_TOOLS)("a zip lists by the same rules", async () => {
    const archive = await archiveOf(`holiday.zip`, { "holiday/a.txt": `a`, "holiday/deep/b.txt": `b` });
    expect(await names(archive, `drop/holiday.zip`)).toEqual([`drop/holiday.zip/a.txt`, `drop/holiday.zip/deep`]);
});
