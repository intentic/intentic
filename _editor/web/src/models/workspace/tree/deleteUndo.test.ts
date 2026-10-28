import { resetSandboxScope } from "@intentic/extension-api";
import { type DeleteBatch, fileUndoable, rememberCreated, rememberDelete, rememberMoves, takeStep } from "./deleteUndo";

// Pins the stack Mod+Z and a receipt's Undo share: newest first, and a step taken back only once whichever asks.

const batch = (...paths: string[]): DeleteBatch => ({ entries: paths.map((path) => ({ path, type: `file`, trashed: `t:${path}` })) });

afterEach(() => {
    resetSandboxScope();
});

it(`walks back newest first, one gesture at a time`, () => {
    const first = batch(`a.txt`);
    const second = batch(`b.txt`, `c.txt`);
    rememberDelete(first);
    rememberDelete(second);

    expect([takeStep(), takeStep(), takeStep(), fileUndoable.value]).toEqual([second, first, undefined, false]);
});

it(`takes a named batch from anywhere in the stack, and only once`, () => {
    const first = batch(`a.txt`);
    const second = batch(`b.txt`);
    rememberDelete(first);
    rememberDelete(second);

    expect([takeStep(first), takeStep(first), takeStep()]).toEqual([first, undefined, second]);
});

it(`remembers nothing for a delete that sent nothing to the trash`, () => {
    rememberDelete(batch());
    expect(fileUndoable.value).toBe(false);
});

it(`holds moves and entries made beside deletes, in the order they were done`, () => {
    const deleted = batch(`a.txt`);
    rememberDelete(deleted);
    rememberMoves([{ from: `b.txt`, to: `docs/b.txt` }]);
    rememberCreated([`new.txt`]);
    rememberMoves([]);
    rememberCreated([]);

    expect([takeStep(), takeStep(), takeStep(), takeStep()]).toEqual([{ created: [`new.txt`] }, { moves: [{ from: `b.txt`, to: `docs/b.txt` }] }, deleted, undefined]);
});
