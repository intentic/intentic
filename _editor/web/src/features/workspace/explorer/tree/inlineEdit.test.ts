import { advanceEdit, type EditStep, IDLE, type InlineEdit, type InlineEditEvent } from "./inlineEdit";

// Pins every move the inline field can make, as a table of state, event and step: what opens it and with which text,
// what a commit writes, what a refused, empty or unchanged name does, and that an idle field commits nothing.

const CREATING_FILE: InlineEdit = { kind: `creating`, dir: `src`, type: `file` };
const CREATING_DIR_AT_ROOT: InlineEdit = { kind: `creating`, dir: ``, type: `dir` };
const RENAMING: InlineEdit = { kind: `renaming`, path: `src/main.ts` };
const typed = (kind: `commit` | `blur`, draft: string, refused = false): InlineEditEvent => ({ kind, draft, refused });

const MOVES: readonly (readonly [string, InlineEdit, InlineEditEvent, EditStep])[] = [
    [`New File opens an empty field in its folder`, IDLE, { kind: `create`, dir: `src`, type: `file` }, { edit: CREATING_FILE, draft: `` }],
    [`New Folder replaces a rename in progress`, RENAMING, { kind: `create`, dir: ``, type: `dir` }, { edit: CREATING_DIR_AT_ROOT, draft: `` }],
    [`Rename opens on the current name`, IDLE, { kind: `rename`, path: `src/main.ts` }, { edit: RENAMING, draft: `main.ts` }],
    [`Rename replaces a create in progress`, CREATING_FILE, { kind: `rename`, path: `src/main.ts` }, { edit: RENAMING, draft: `main.ts` }],
    [
        `Enter creates the trimmed name in the field's folder`,
        CREATING_FILE,
        typed(`commit`, `  notes.md `),
        { edit: IDLE, write: { kind: `create`, path: `src/notes.md`, type: `file` } },
    ],
    [
        `Enter creates at the root`,
        CREATING_DIR_AT_ROOT,
        typed(`commit`, `drafts`),
        { edit: IDLE, write: { kind: `create`, path: `drafts`, type: `dir` } },
    ],
    [`Enter on an empty name is a silent cancel`, CREATING_FILE, typed(`commit`, `   `), { edit: IDLE }],
    [`Enter on an empty name cancels even while refused`, CREATING_FILE, typed(`commit`, ``, true), { edit: IDLE }],
    [`Enter on a refused name keeps the field open`, CREATING_FILE, typed(`commit`, `main.ts`, true), { edit: CREATING_FILE }],
    [`a blur drops a refused name`, CREATING_FILE, typed(`blur`, `main.ts`, true), { edit: IDLE }],
    [
        `a blur commits an accepted name`,
        CREATING_FILE,
        typed(`blur`, `b.ts`),
        { edit: IDLE, write: { kind: `create`, path: `src/b.ts`, type: `file` } },
    ],
    [
        `Enter renames within the same folder`,
        RENAMING,
        typed(`commit`, ` entry.ts `),
        { edit: IDLE, write: { kind: `rename`, from: `src/main.ts`, to: `src/entry.ts` } },
    ],
    [`Enter on the unchanged name closes the field`, RENAMING, typed(`commit`, `main.ts`), { edit: IDLE }],
    [`Enter on an empty name closes the field`, RENAMING, typed(`commit`, ``), { edit: IDLE }],
    [
        `a blur commits a rename`,
        RENAMING,
        typed(`blur`, `entry.ts`),
        { edit: IDLE, write: { kind: `rename`, from: `src/main.ts`, to: `src/entry.ts` } },
    ],
    [
        `a refusal is about a new name, not a rename`,
        RENAMING,
        typed(`blur`, `entry.ts`, true),
        { edit: IDLE, write: { kind: `rename`, from: `src/main.ts`, to: `src/entry.ts` } },
    ],
    [`Escape closes a create`, CREATING_FILE, { kind: `cancel` }, { edit: IDLE }],
    [`Escape closes a rename`, RENAMING, { kind: `cancel` }, { edit: IDLE }],
    [`an idle field commits nothing on Enter`, IDLE, typed(`commit`, `notes.md`), { edit: IDLE }],
    [`an idle field commits nothing on a blur`, IDLE, typed(`blur`, `notes.md`), { edit: IDLE }],
];

describe(`the inline field`, () => {
    it(`makes every move in the table`, () => {
        expect(MOVES.map(([move, edit, event]) => [move, advanceEdit(edit, event)])).toEqual(MOVES.map(([move, , , step]) => [move, step]));
    });

    it(`keeps the very same state for a refused name, so nothing watching it wakes`, () => {
        expect(advanceEdit(CREATING_FILE, typed(`commit`, `main.ts`, true)).edit).toBe(CREATING_FILE);
    });

    // The re-entry guard for Enter: the first commit closes the field before its write is awaited.
    it(`commits a second Enter as nothing, once the first has closed the field`, () => {
        const first = advanceEdit(CREATING_FILE, typed(`commit`, `notes.md`));
        const second = advanceEdit(first.edit, typed(`commit`, `notes.md`));

        expect([first.write, second.write]).toEqual([{ kind: `create`, path: `src/notes.md`, type: `file` }, undefined]);
    });
});
