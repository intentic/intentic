import { deletedReceipt, deleteHeader, joinPath, newNameError } from "./entryNames";

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
    const typeOf = (path: string): "file" | "dir" | undefined => (path === `src` ? `dir` : path === `gone` ? undefined : `file`);

    it(`names the one kind, or counts several`, () => {
        expect(deleteHeader([`src`], typeOf)).toBe(`Delete folder?`);
        expect(deleteHeader([`a.ts`], typeOf)).toBe(`Delete file?`);
        expect(deleteHeader([`gone`], typeOf)).toBe(`Delete file?`);
        expect(deleteHeader([`a.ts`, `src`], typeOf)).toBe(`Delete 2 items?`);
    });

    it(`receipts by name, or by count`, () => {
        expect(deletedReceipt([`src/a.ts`])).toBe(`a.ts deleted`);
        expect(deletedReceipt([`a`, `b`, `c`])).toBe(`3 items deleted`);
    });
});
