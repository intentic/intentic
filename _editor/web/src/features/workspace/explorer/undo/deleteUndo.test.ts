import { resetSandboxScope } from "@intentic/extension-api";
import { type DeleteBatch, deleteUndoable, rememberDelete, takeDelete } from "./deleteUndo";

// Pins the stack Mod+Z and a receipt's Undo share: newest first, and a batch taken back only once whichever asks.

const batch = (...paths: string[]): DeleteBatch => ({ entries: paths.map((path) => ({ path, type: `file`, trashed: `t:${path}` })) });

afterEach(() => {
    resetSandboxScope();
});

it(`walks back newest first, one gesture at a time`, () => {
    const first = batch(`a.txt`);
    const second = batch(`b.txt`, `c.txt`);
    rememberDelete(first);
    rememberDelete(second);

    expect([takeDelete(), takeDelete(), takeDelete(), deleteUndoable.value]).toEqual([second, first, undefined, false]);
});

it(`takes a named batch from anywhere in the stack, and only once`, () => {
    const first = batch(`a.txt`);
    const second = batch(`b.txt`);
    rememberDelete(first);
    rememberDelete(second);

    expect([takeDelete(first), takeDelete(first), takeDelete()]).toEqual([first, undefined, second]);
});

it(`remembers nothing for a delete that sent nothing to the trash`, () => {
    rememberDelete(batch());
    expect(deleteUndoable.value).toBe(false);
});
