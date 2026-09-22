import type { WorkspaceTreeEntry } from "@intentic/api-contract";
import { describe, it, expect } from "bun:test";
import { archiveAbove, isArchiveContent, opensAsFolder } from "./archiveEntries";

const file = (path: string): WorkspaceTreeEntry => ({ name: path.split(`/`).at(-1) ?? path, path, type: `file` });
const dir = (path: string): WorkspaceTreeEntry => ({ name: path.split(`/`).at(-1) ?? path, path, type: `dir` });

// The tree as these helpers read it: a path it knows, or undefined for one the walk never listed.
const treeOf = (...entries: readonly WorkspaceTreeEntry[]) => {
    const byPath = new Map(entries.map((entry) => [entry.path, entry]));
    return (path: string): WorkspaceTreeEntry | undefined => byPath.get(path);
};

describe(`which entries open like a folder`, () => {
    it(`takes a zip or tar, and leaves the single-file formats alone`, () => {
        expect(opensAsFolder(file(`drop/photos.zip`))).toBe(true);
        expect(opensAsFolder(file(`drop/site.tar.gz`))).toBe(true);
        // One compressed file, no structure inside: Extract is the only thing to do with it.
        expect(opensAsFolder(file(`drop/server.log.gz`))).toBe(false);
        expect(opensAsFolder(file(`drop/bundle.7z`))).toBe(false);
        expect(opensAsFolder(file(`src/a.ts`))).toBe(false);
    });

    it(`never takes a folder, whatever it is called`, () => {
        expect(opensAsFolder(dir(`drop/photos.zip`))).toBe(false);
    });
});

describe(`what counts as an archive's contents`, () => {
    const tree = treeOf(file(`drop/photos.zip`), dir(`drop/photos.zip/holiday`), file(`drop/photos.zip/holiday/a.jpg`), dir(`src`), file(`src/a.ts`));

    it(`leaves the workspace proper alone`, () => {
        expect(isArchiveContent(`src/a.ts`, tree)).toBe(false);
        expect(archiveAbove(`src`, tree)).toBeUndefined();
    });

    it(`counts everything under an archive, at any depth`, () => {
        expect(isArchiveContent(`drop/photos.zip/holiday/a.jpg`, tree)).toBe(true);
        expect(archiveAbove(`drop/photos.zip/holiday`, tree)).toBe(`drop/photos.zip`);
    });

    it(`keeps the archive file itself writable, while the folder it opens as is not`, () => {
        // Renaming, moving or deleting the zip is ordinary file management.
        expect(isArchiveContent(`drop/photos.zip`, tree)).toBe(false);
        // Creating or dropping INTO it is not: as a folder, it is the archive's contents.
        expect(archiveAbove(`drop/photos.zip`, tree)).toBe(`drop/photos.zip`);
    });

    it(`believes the tree over the name: a folder called photos.zip is a folder`, () => {
        const folders = treeOf(dir(`drop/photos.zip`), file(`drop/photos.zip/a.jpg`));
        expect(isArchiveContent(`drop/photos.zip/a.jpg`, folders)).toBe(false);
        expect(archiveAbove(`drop/photos.zip`, folders)).toBeUndefined();
    });

    it(`errs towards read-only for a prefix the tree has not listed`, () => {
        // Nothing reaches a path under an unlisted archive except by having been told it is one; refusing a write the
        // daemon would refuse anyway beats offering it.
        expect(isArchiveContent(`drop/photos.zip/a.jpg`, treeOf())).toBe(true);
    });
});
