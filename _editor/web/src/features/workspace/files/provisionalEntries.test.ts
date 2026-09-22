import { describe, it, expect, afterEach } from "bun:test";
import type { WorkspaceTreeEntry } from "@intentic/api-contract";
import {
    clearUnsettledUploads,
    dropProvisional,
    isLeaving,
    markFailed,
    markSettled,
    noteArriving,
    noteLeaving,
    provisionalAt,
    reconcileProvisional,
    resetProvisional,
    withProvisionalEntries,
} from "./provisionalEntries";

/* The tree as the explorer draws it between a gesture and the walk that proves it happened: rows for what is arriving,
   no rows for what is leaving, and every one of them retired by the real listing rather than a timer. */

const file = (name: string, path: string): WorkspaceTreeEntry => ({ name, path, type: `file` });
const dir = (name: string, path: string): WorkspaceTreeEntry => ({ name, path, type: `dir`, children: [] });
const names = (entries: readonly WorkspaceTreeEntry[]): string[] => entries.map((entry) => entry.name);

afterEach(() => resetProvisional());

describe(`arrivals`, () => {
    it(`returns the listing unchanged when nothing is provisional`, () => {
        const listed = [file(`a.txt`, `a.txt`)];
        expect(withProvisionalEntries(``, listed)).toBe(listed);
    });

    it(`merges an arriving file into its directory, folders first then by name`, () => {
        noteArriving(`docs/notes.md`, { kind: `upload`, size: 12 });
        expect(names(withProvisionalEntries(`docs`, [file(`alpha.md`, `docs/alpha.md`), file(`zulu.md`, `docs/zulu.md`)]))).toEqual([
            `alpha.md`,
            `notes.md`,
            `zulu.md`,
        ]);
        expect(names(withProvisionalEntries(``, [file(`readme.md`, `readme.md`)]))).toEqual([`docs`, `readme.md`]);
    });

    it(`stands a directory up for a dropped folder that doesn't exist yet`, () => {
        noteArriving(`photos/trip/one.jpg`, { kind: `upload`, size: 3 });
        expect(names(withProvisionalEntries(``, []))).toEqual([`photos`]);
        expect(names(withProvisionalEntries(`photos`, []))).toEqual([`trip`]);
        expect(names(withProvisionalEntries(`photos/trip`, []))).toEqual([`one.jpg`]);
    });

    it(`draws a new folder as a folder, not as the file an upload would be`, () => {
        noteArriving(`src/generated`, { kind: `write`, type: `dir` });
        expect(withProvisionalEntries(`src`, [])[0]).toMatchObject({ name: `generated`, path: `src/generated`, type: `dir` });
    });

    it(`leaves a name the listing already has to the real entry`, () => {
        noteArriving(`docs/notes.md`, { kind: `upload`, size: 12 });
        const listed = [dir(`docs`, `docs`)];
        expect(withProvisionalEntries(``, listed)).toBe(listed);
    });

    it(`carries the size onto the placeholder, so the row reads like the real one`, () => {
        noteArriving(`a.bin`, { kind: `upload`, size: 4096 });
        expect(withProvisionalEntries(``, [])[0]?.size).toBe(4096);
    });

    it(`keeps a file's size off the folder standing in above it`, () => {
        noteArriving(`photos/one.jpg`, { kind: `upload`, size: 4096 });
        expect(Object.keys(withProvisionalEntries(``, [])[0] ?? {})).not.toContain(`size`);
    });
});

describe(`departures`, () => {
    it(`takes a leaving entry out of its directory's listing`, () => {
        noteLeaving(`src/old.ts`);
        expect(names(withProvisionalEntries(`src`, [file(`old.ts`, `src/old.ts`), file(`new.ts`, `src/new.ts`)]))).toEqual([`new.ts`]);
    });

    it(`reports a leaving path so nothing acts on a row that is going`, () => {
        noteLeaving(`src/old.ts`);
        expect(isLeaving(`src/old.ts`)).toBe(true);
        expect(isLeaving(`src/new.ts`)).toBe(false);
    });

    it(`says nothing about the folder a deleted file was in`, () => {
        noteLeaving(`src/old.ts`);
        expect(isLeaving(`src`)).toBe(false);
        expect(names(withProvisionalEntries(``, [dir(`src`, `src`)]))).toEqual([`src`]);
    });

    it(`swaps both rows for a rename, in one listing`, () => {
        noteLeaving(`src/old.ts`);
        noteArriving(`src/new.ts`, { kind: `write`, type: `file` });
        expect(names(withProvisionalEntries(`src`, [file(`old.ts`, `src/old.ts`)]))).toEqual([`new.ts`]);
    });
});

describe(`provisionalAt`, () => {
    it(`follows an upload from sending to landed`, () => {
        noteArriving(`docs/notes.md`, { kind: `upload`, size: 12 });
        expect(provisionalAt(`docs/notes.md`)).toMatchObject({ state: `arriving`, kind: `upload` });
        markSettled(`docs/notes.md`);
        expect(provisionalAt(`docs/notes.md`)).toMatchObject({ state: `landing` });
    });

    it(`keeps a settled departure leaving, since its row must stay gone until the listing agrees`, () => {
        noteLeaving(`a.txt`);
        markSettled(`a.txt`);
        expect(provisionalAt(`a.txt`)).toMatchObject({ state: `leaving` });
    });

    it(`reports a failure on the row that failed`, () => {
        noteArriving(`a.txt`, { kind: `upload`, size: 1 });
        markFailed(`a.txt`);
        expect(provisionalAt(`a.txt`)).toMatchObject({ state: `failed` });
    });

    it(`shows a folder as still sending while any file under it is`, () => {
        noteArriving(`photos/one.jpg`, { kind: `upload`, size: 1 });
        noteArriving(`photos/two.jpg`, { kind: `upload`, size: 1 });
        markSettled(`photos/one.jpg`);
        expect(provisionalAt(`photos`)).toMatchObject({ state: `arriving` });
        markSettled(`photos/two.jpg`);
        expect(provisionalAt(`photos`)).toMatchObject({ state: `landing` });
    });

    it(`says nothing about a path with no entry`, () => {
        expect(provisionalAt(`a.txt`)).toBeUndefined();
    });
});

describe(`retiring against the listing`, () => {
    it(`drops the arrival the listing now has, and keeps the rest`, () => {
        noteArriving(`a.txt`, { kind: `upload`, size: 1 });
        noteArriving(`b.txt`, { kind: `upload`, size: 1 });
        markSettled(`a.txt`);
        reconcileProvisional((path) => path === `a.txt`);
        expect(provisionalAt(`a.txt`)).toBeUndefined();
        expect(provisionalAt(`b.txt`)).toMatchObject({ state: `arriving` });
    });

    it(`retires a departure only once the listing has stopped reporting it`, () => {
        noteLeaving(`a.txt`);
        reconcileProvisional((path) => path === `a.txt`);
        expect(isLeaving(`a.txt`)).toBe(true);
        reconcileProvisional(() => false);
        expect(isLeaving(`a.txt`)).toBe(false);
    });

    it(`keeps a departure the listing never reported, since absence there is not evidence of a delete`, () => {
        // The reconciled listing is the eager walk plus loaded lazy subtrees: an unexpanded folder, a path past the
        // walk's budget and the first load all read as absent, and retiring on that puts the deleted row back.
        noteLeaving(`unlisted/deep/a.txt`);
        reconcileProvisional(() => false);
        reconcileProvisional(() => false);
        expect(isLeaving(`unlisted/deep/a.txt`)).toBe(true);
    });

    it(`retires a departure whose listing dropped it after holding it`, () => {
        noteLeaving(`a.txt`);
        reconcileProvisional(() => true);
        reconcileProvisional(() => false);
        expect(isLeaving(`a.txt`)).toBe(false);
    });

    it(`drops a folder placeholder once its last file is listed`, () => {
        noteArriving(`photos/one.jpg`, { kind: `upload`, size: 1 });
        reconcileProvisional(() => true);
        expect(provisionalAt(`photos`)).toBeUndefined();
        expect(withProvisionalEntries(``, [])).toEqual([]);
    });

    it(`takes back a refused write, leaving the listing as the whole truth again`, () => {
        noteLeaving(`src/old.ts`);
        noteArriving(`src/new.ts`, { kind: `write`, type: `file` });
        dropProvisional(`src/old.ts`);
        dropProvisional(`src/new.ts`);
        const listed = [file(`old.ts`, `src/old.ts`)];
        expect(withProvisionalEntries(`src`, listed)).toBe(listed);
    });

    it(`clears what never landed on a cancel, and keeps what did`, () => {
        noteArriving(`sent.txt`, { kind: `upload`, size: 1 });
        noteArriving(`stopped.txt`, { kind: `upload`, size: 1 });
        noteArriving(`broken.txt`, { kind: `upload`, size: 1 });
        markSettled(`sent.txt`);
        markFailed(`broken.txt`);
        clearUnsettledUploads();
        expect(provisionalAt(`sent.txt`)).toMatchObject({ state: `landing` });
        expect(provisionalAt(`stopped.txt`)).toBeUndefined();
        expect(provisionalAt(`broken.txt`)).toBeUndefined();
    });

    it(`leaves a tree write alone when the upload card is dismissed`, () => {
        noteArriving(`made.ts`, { kind: `write`, type: `file` });
        noteLeaving(`gone.ts`);
        clearUnsettledUploads();
        expect(provisionalAt(`made.ts`)).toMatchObject({ state: `arriving` });
        expect(isLeaving(`gone.ts`)).toBe(true);
    });

    it(`takes a retried file back to sending, so its row stops reading as failed`, () => {
        noteArriving(`a.txt`, { kind: `upload`, size: 1 });
        markFailed(`a.txt`);
        noteArriving(`a.txt`, { kind: `upload`, size: 1 });
        expect(provisionalAt(`a.txt`)).toMatchObject({ state: `arriving` });
    });
});
