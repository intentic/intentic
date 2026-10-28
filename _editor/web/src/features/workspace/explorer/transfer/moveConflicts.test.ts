import { askMoveConflict, conflictQuestion, holdConflictAsker, keptName, planMoves, resolveMoves } from "./moveConflicts";

const TAKEN = new Set([`notes.md`, `notes 2.md`, `photos`]);

describe(`keptName`, () => {
    it(`numbers a taken name past the ones already used, keeping the extension and a dotfile whole`, () => {
        expect(keptName(`notes.md`, TAKEN)).toBe(`notes 3.md`);
        expect(keptName(`photos`, TAKEN)).toBe(`photos 2`);
        expect(keptName(`.env`, new Set([`.env`]))).toBe(`.env 2`);
        expect(keptName(`free.txt`, TAKEN)).toBe(`free.txt`);
    });
});

describe(`planning a move into a folder`, () => {
    const plan = planMoves([`a/notes.md`, `a/todo.md`, `a/photos`, `b/notes.md`], `b`, TAKEN);

    it(`names the sources landing on an entry already there, and leaves out one already in the folder`, () => {
        expect(plan).toEqual({ free: [`a/todo.md`], clashes: [`a/notes.md`, `a/photos`] });
    });

    it(`keeps both under free names`, () => {
        const resolved = resolveMoves(plan, `keep`, `b`, TAKEN);
        expect([resolved.sources, [...resolved.names], resolved.replaced]).toEqual([
            [`a/todo.md`, `a/notes.md`, `a/photos`],
            [
                [`a/notes.md`, `notes 3.md`],
                [`a/photos`, `photos 2`],
            ],
            [],
        ]);
    });

    it(`replaces what is there, sending it to the trash first`, () => {
        const resolved = resolveMoves(planMoves([`a/notes.md`, `c/notes.md`], `b`, TAKEN), `replace`, `b`, TAKEN);
        // The second arrival of one name replaces nothing: it was never there, so it lands beside the first.
        expect([resolved.sources, [...resolved.names], resolved.replaced]).toEqual([
            [`a/notes.md`, `c/notes.md`],
            [[`c/notes.md`, `notes 3.md`]],
            [`b/notes.md`],
        ]);
    });

    it(`skips the clashing ones and moves the rest`, () => {
        expect(resolveMoves(planMoves([`a/notes.md`, `a/todo.md`], ``, TAKEN), `skip`, ``, TAKEN)).toEqual({
            sources: [`a/todo.md`],
            names: new Map(),
            replaced: [],
        });
    });
});

describe(`asking`, () => {
    it(`keeps both at once when no dialog is there to ask`, async () => {
        expect(await askMoveConflict(`b`, [`notes.md`], false)).toBe(`keep`);
    });

    it(`puts the question up for a mounted dialog, and a second question answers the first with nothing`, async () => {
        const release = holdConflictAsker();
        const first = askMoveConflict(`b`, [`notes.md`], false);
        const second = askMoveConflict(`c`, [`a.txt`], true);
        expect(conflictQuestion.value?.dir).toBe(`c`);
        conflictQuestion.value?.answer(`replace`);
        expect([await first, await second, conflictQuestion.value]).toEqual([undefined, `replace`, undefined]);
        release();
    });
});
