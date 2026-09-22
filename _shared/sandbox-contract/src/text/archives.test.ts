import { describe, it, expect } from "bun:test";
import { archiveFormat, archivePrefixOf, archiveRootOf, archiveStem, isBrowsableArchive, wrapsItsOwnName } from "./archives.js";

describe(`archive names`, () => {
    it(`reads a compressed tar as a tar, not as its compression`, () => {
        expect(archiveFormat(`site.tar.gz`)).toBe(`tar`);
        expect(archiveStem(`site.tar.gz`)).toBe(`site`);
        expect(archiveFormat(`site.tgz`)).toBe(`tar`);
        expect(archiveFormat(`notes.txt.gz`)).toBe(`gzip`);
        expect(archiveStem(`notes.txt.gz`)).toBe(`notes.txt`);
    });

    it(`knows the formats this sandbox has no tool for, and the zips that aren't archives`, () => {
        expect(archiveFormat(`bundle.7z`)).toBeUndefined();
        expect(archiveFormat(`bundle.rar`)).toBeUndefined();
        expect(archiveFormat(`report.docx`)).toBeUndefined();
        expect(archiveFormat(`numpy.whl`)).toBeUndefined();
        expect(archiveFormat(`README.md`)).toBeUndefined();
    });

    it(`matches the suffix whatever its case, and never takes a dotfile for an archive`, () => {
        expect(archiveFormat(`SITE.ZIP`)).toBe(`zip`);
        expect(archiveStem(`SITE.ZIP`)).toBe(`SITE`);
        expect(archiveFormat(`.zip`)).toBeUndefined();
    });

    it(`counts a folder as the archive itself past a browser's copy marker`, () => {
        expect(wrapsItsOwnName(`landing-page`, `landing-page`)).toBe(true);
        expect(wrapsItsOwnName(`landing-page`, `landing-page (2)`)).toBe(true);
        expect(wrapsItsOwnName(`src`, `landing-page`)).toBe(false);
    });

    it(`offers to enter only the formats that hold a directory`, () => {
        expect(isBrowsableArchive(`photos.zip`)).toBe(true);
        expect(isBrowsableArchive(`site.tar.gz`)).toBe(true);
        // One compressed file, no structure: Extract is the only thing to do with it.
        expect(isBrowsableArchive(`notes.txt.gz`)).toBe(false);
        expect(isBrowsableArchive(`bundle.7z`)).toBe(false);
    });
});

describe(`reading a path through an archive`, () => {
    const anyArchive = (): boolean => true;

    it(`splits at the archive and keeps the rest as the path inside it`, () => {
        expect(archivePrefixOf(`drop/photos.zip/holiday/a.jpg`, anyArchive)).toEqual({ archive: `drop/photos.zip`, inside: `holiday/a.jpg` });
        // The archive's own top level: entering it asks for its whole listing.
        expect(archivePrefixOf(`photos.zip/a.jpg`, anyArchive)).toEqual({ archive: `photos.zip`, inside: `a.jpg` });
    });

    it(`leaves the archive itself alone, and anything holding no archive`, () => {
        expect(archivePrefixOf(`drop/photos.zip`, anyArchive)).toBeUndefined();
        expect(archivePrefixOf(`drop/notes/a.md`, anyArchive)).toBeUndefined();
    });

    it(`counts the archive itself as archive contents, which reading through it does not`, () => {
        expect(archiveRootOf(`drop/photos.zip`, anyArchive)).toEqual({ archive: `drop/photos.zip`, inside: `` });
        expect(archiveRootOf(`drop/photos.zip/holiday`, anyArchive)).toEqual({ archive: `drop/photos.zip`, inside: `holiday` });
        expect(archiveRootOf(`drop/notes`, anyArchive)).toBeUndefined();
    });

    it(`takes the probe's word over the name, so a folder called photos.zip is just a folder`, () => {
        expect(archivePrefixOf(`drop/photos.zip/a.jpg`, () => false)).toBeUndefined();
        expect(archivePrefixOf(`drop/photos.zip/a.jpg`, (path) => path === `drop/photos.zip`)).toEqual({
            archive: `drop/photos.zip`,
            inside: `a.jpg`,
        });
    });

    it(`reads through the outer archive first: the inner one is a file in its unpacked copy, split again there`, () => {
        expect(archivePrefixOf(`outer.zip/inner.zip/a.txt`, anyArchive)).toEqual({ archive: `outer.zip`, inside: `inner.zip/a.txt` });
        // What the second pass, against the outer archive's own contents, then answers.
        expect(archivePrefixOf(`inner.zip/a.txt`, anyArchive)).toEqual({ archive: `inner.zip`, inside: `a.txt` });
    });

    it(`reads a platform path the same as a posix one`, () => {
        expect(archivePrefixOf(`.\\drop\\photos.zip\\a.jpg`, anyArchive)).toEqual({ archive: `drop/photos.zip`, inside: `a.jpg` });
    });
});
