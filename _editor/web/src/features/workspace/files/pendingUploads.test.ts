import { afterEach, describe, expect, it } from "vitest";
import type { WorkspaceTreeEntry } from "@intentic/api-contract";
import {
    clearUnlandedUploads,
    markUploadFailed,
    markUploadLanded,
    notePendingUpload,
    pendingStateOf,
    resetPendingUploads,
    retireListedUploads,
    withPendingEntries,
} from "./pendingUploads";

/* Placeholder rows for files the daemon's listing hasn't caught up with: what the explorer draws between a drop and
   the walk that proves it landed. */

const file = (name: string, path: string): WorkspaceTreeEntry => ({ name, path, type: `file` });
const dir = (name: string, path: string): WorkspaceTreeEntry => ({ name, path, type: `dir`, children: [] });
const names = (entries: readonly WorkspaceTreeEntry[]): string[] => entries.map((entry) => entry.name);

afterEach(() => resetPendingUploads());

describe(`withPendingEntries`, () => {
    it(`returns the listing unchanged when nothing is pending`, () => {
        const listed = [file(`a.txt`, `a.txt`)];
        expect(withPendingEntries(``, listed)).toBe(listed);
    });

    it(`merges a pending file into its directory, folders first then by name`, () => {
        notePendingUpload(`docs/notes.md`, 12);
        expect(names(withPendingEntries(`docs`, [file(`alpha.md`, `docs/alpha.md`), file(`zulu.md`, `docs/zulu.md`)]))).toEqual([
            `alpha.md`,
            `notes.md`,
            `zulu.md`,
        ]);
        expect(names(withPendingEntries(``, [file(`readme.md`, `readme.md`)]))).toEqual([`docs`, `readme.md`]);
    });

    it(`stands a directory up for a dropped folder that doesn't exist yet`, () => {
        notePendingUpload(`photos/trip/one.jpg`, 3);
        expect(names(withPendingEntries(``, []))).toEqual([`photos`]);
        expect(names(withPendingEntries(`photos`, []))).toEqual([`trip`]);
        expect(names(withPendingEntries(`photos/trip`, []))).toEqual([`one.jpg`]);
    });

    it(`leaves a name the listing already has to the real entry`, () => {
        notePendingUpload(`docs/notes.md`, 12);
        const listed = [dir(`docs`, `docs`)];
        expect(withPendingEntries(``, listed)).toBe(listed);
    });

    it(`carries the size onto the placeholder, so the row reads like the real one`, () => {
        notePendingUpload(`a.bin`, 4096);
        expect(withPendingEntries(``, [])[0]?.size).toBe(4096);
    });
});

describe(`pendingStateOf`, () => {
    it(`follows a file from sending to landed`, () => {
        notePendingUpload(`docs/notes.md`, 12);
        expect(pendingStateOf(`docs/notes.md`)).toBe(`uploading`);
        markUploadLanded(`docs/notes.md`);
        expect(pendingStateOf(`docs/notes.md`)).toBe(`landing`);
    });

    it(`reports a failure on the row that failed`, () => {
        notePendingUpload(`a.txt`, 1);
        markUploadFailed(`a.txt`);
        expect(pendingStateOf(`a.txt`)).toBe(`failed`);
    });

    it(`shows a folder as still sending while any file under it is`, () => {
        notePendingUpload(`photos/one.jpg`, 1);
        notePendingUpload(`photos/two.jpg`, 1);
        markUploadLanded(`photos/one.jpg`);
        expect(pendingStateOf(`photos`)).toBe(`uploading`);
        markUploadLanded(`photos/two.jpg`);
        expect(pendingStateOf(`photos`)).toBe(`landing`);
    });

    it(`says nothing about a path with no placeholder`, () => {
        expect(pendingStateOf(`a.txt`)).toBeUndefined();
    });
});

describe(`retiring placeholders`, () => {
    it(`drops the one the listing now has, and keeps the rest`, () => {
        notePendingUpload(`a.txt`, 1);
        notePendingUpload(`b.txt`, 1);
        markUploadLanded(`a.txt`);
        retireListedUploads((path) => path === `a.txt`);
        expect(pendingStateOf(`a.txt`)).toBeUndefined();
        expect(pendingStateOf(`b.txt`)).toBe(`uploading`);
    });

    it(`drops a folder placeholder once its last file is listed`, () => {
        notePendingUpload(`photos/one.jpg`, 1);
        retireListedUploads(() => true);
        expect(pendingStateOf(`photos`)).toBeUndefined();
        expect(withPendingEntries(``, [])).toEqual([]);
    });

    it(`clears what never landed on a cancel, and keeps what did`, () => {
        notePendingUpload(`sent.txt`, 1);
        notePendingUpload(`stopped.txt`, 1);
        notePendingUpload(`broken.txt`, 1);
        markUploadLanded(`sent.txt`);
        markUploadFailed(`broken.txt`);
        clearUnlandedUploads();
        expect(pendingStateOf(`sent.txt`)).toBe(`landing`);
        expect(pendingStateOf(`stopped.txt`)).toBeUndefined();
        expect(pendingStateOf(`broken.txt`)).toBeUndefined();
    });

    it(`takes a retried file back to sending, so its row stops reading as failed`, () => {
        notePendingUpload(`a.txt`, 1);
        markUploadFailed(`a.txt`);
        notePendingUpload(`a.txt`, 1);
        expect(pendingStateOf(`a.txt`)).toBe(`uploading`);
    });
});
