import { deletedReceipt, joinPath, newNameError, restoredReceipt } from "./entryNames";

describe(`a new name being typed`, () => {
    const taken = new Set([`src/index.ts`, `notes`]);
    const exists = (path: string): boolean => taken.has(path);

    it(`says nothing while the field is empty`, () => {
        expect(newNameError(``, `src`, exists)).toBeUndefined();
        expect(newNameError(`   `, `src`, exists)).toBeUndefined();
    });

    it(`refuses a path, a dot, or a double dot`, () => {
        for (const draft of [`a/b`, `a\\b`, `.`, `..`]) {
            expect(newNameError(draft, `src`, exists), draft).toBe(`Invalid name.`);
        }
    });

    it(`refuses a name already in that folder, trimmed`, () => {
        expect(newNameError(` index.ts `, `src`, exists)).toBe(`"index.ts" already exists.`);
        expect(newNameError(`notes`, ``, exists)).toBe(`"notes" already exists.`);
    });

    it(`accepts a free name`, () => {
        expect(newNameError(`main.ts`, `src`, exists)).toBeUndefined();
    });

    it(`joins under the root without a leading slash`, () => {
        expect(joinPath(``, `a`)).toBe(`a`);
        expect(joinPath(`src`, `a`)).toBe(`src/a`);
    });
});

describe(`what a delete says`, () => {
    it(`receipts by name, or by count`, () => {
        expect(deletedReceipt([`src/a.ts`])).toBe(`a.ts deleted`);
        expect(deletedReceipt([`a`, `b`, `c`])).toBe(`3 items deleted`);
    });
});

describe(`what an undo says`, () => {
    it(`names the one thing back where it was, or counts several`, () => {
        expect(restoredReceipt([`src/a.ts`], [`src/a.ts`], 0)).toBe(`a.ts restored`);
        expect(restoredReceipt([`a`, `b`], [`b`, `a`], 0)).toBe(`2 items restored`);
    });

    it(`names the new name when something took the old one meanwhile`, () => {
        expect(restoredReceipt([`docs/plan.pdf`], [`docs/plan (restored).pdf`], 0)).toBe(`Restored as plan (restored).pdf`);
    });

    it(`adds what had aged out of the trash, and leaves an all-gone undo to a warning`, () => {
        expect(restoredReceipt([`a`, `b`], [`a`], 1)).toBe(`a restored; 1 no longer in the trash`);
        expect(restoredReceipt([`a`], [], 1)).toBeUndefined();
    });
});
