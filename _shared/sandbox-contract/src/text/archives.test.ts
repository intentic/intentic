import { describe, expect, it } from "vitest";
import { archiveFormat, archiveStem, wrapsItsOwnName } from "./archives.js";

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
});
