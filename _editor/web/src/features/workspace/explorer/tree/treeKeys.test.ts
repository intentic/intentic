import type { WorkspaceTreeEntry } from "@intentic/api-contract";
import { type KeyIntent, type KeyPress, keyIntent, type KeyView } from "./treeKeys";
import type { MoreRow, Row } from "./treeRows";

// Pins what every key the tree owns means, as a value, for each place the lead can stand, and that a key it doesn't own
// is left to the page: arrows and Home/End travel, Right and Left open, close and climb, and the verbs name their target.

const entry = (path: string, type: "file" | "dir"): WorkspaceTreeEntry => ({ name: path.slice(path.lastIndexOf(`/`) + 1), path, type });
const SRC = entry(`src`, `dir`);
const API = entry(`src/api`, `dir`);
const MAIN = entry(`src/main.ts`, `file`);
const PKG = entry(`package.json`, `file`);
const README = entry(`README.md`, `file`);
// src open over api (closed) and main.ts, a closed nest parent, a file, and a marker the arrows never land on.
const ROWS: readonly (Row | MoreRow)[] = [
    { entry: SRC, depth: 0, isExpanded: true },
    { entry: API, depth: 1, isExpanded: false },
    { entry: MAIN, depth: 1, isExpanded: false },
    { entry: PKG, depth: 0, isExpanded: false, nest: true },
    { entry: README, depth: 0, isExpanded: false },
    { more: 4, depth: 0, key: `#root-more` },
];
const ORDER = [`src`, `src/api`, `src/main.ts`, `package.json`, `README.md`];
const INDEX = new Map([SRC, API, MAIN, PKG, README].map((item) => [item.path, item]));

const view = (lead: string | null, over: Partial<KeyView> = {}): KeyView => ({
    rows: ROWS,
    order: ORDER,
    lead,
    selected: 1,
    entryAt: (path) => INDEX.get(path),
    ...over,
});
const press = (key: string, mods: Partial<Omit<KeyPress, `key`>> = {}): KeyPress => ({
    key,
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    ...mods,
});
const NONE: KeyIntent = { kind: `none` };

describe(`travelling the rows`, () => {
    it(`steps with the arrows, clamped at the ends, and lands on an end from no lead`, () => {
        expect(keyIntent(press(`ArrowDown`), view(`src`))).toEqual({ kind: `select`, path: `src/api` });
        expect(keyIntent(press(`ArrowUp`), view(`src/api`))).toEqual({ kind: `select`, path: `src` });
        expect(keyIntent(press(`ArrowUp`), view(`src`))).toEqual({ kind: `select`, path: `src` });
        expect(keyIntent(press(`ArrowDown`), view(`README.md`))).toEqual({ kind: `select`, path: `README.md` });
        expect(keyIntent(press(`ArrowDown`), view(null))).toEqual({ kind: `select`, path: `src` });
        expect(keyIntent(press(`ArrowUp`), view(null))).toEqual({ kind: `select`, path: `README.md` });
        expect(keyIntent(press(`ArrowDown`), view(null, { order: [] }))).toEqual(NONE);
    });

    it(`widens with Shift and moves the cursor alone with Ctrl or Cmd, Shift winning over both`, () => {
        expect(keyIntent(press(`ArrowDown`, { shiftKey: true }), view(`src`))).toEqual({ kind: `extend`, path: `src/api` });
        expect(keyIntent(press(`ArrowDown`, { ctrlKey: true }), view(`src`))).toEqual({ kind: `lead`, path: `src/api` });
        expect(keyIntent(press(`ArrowUp`, { metaKey: true }), view(`src/api`))).toEqual({ kind: `lead`, path: `src` });
        expect(keyIntent(press(`ArrowDown`, { shiftKey: true, ctrlKey: true }), view(`src`))).toEqual({ kind: `extend`, path: `src/api` });
    });

    it(`jumps to either end with Home and End, widening with Shift, and has nowhere to go in an empty tree`, () => {
        expect(keyIntent(press(`Home`), view(`README.md`))).toEqual({ kind: `select`, path: `src` });
        expect(keyIntent(press(`End`, { ctrlKey: true }), view(`src`))).toEqual({ kind: `select`, path: `README.md` });
        expect(keyIntent(press(`End`, { shiftKey: true }), view(`src`))).toEqual({ kind: `extend`, path: `README.md` });
        expect(keyIntent(press(`Home`), view(null, { order: [] }))).toEqual(NONE);
    });
});

describe(`opening, closing and climbing`, () => {
    it(`opens a closed folder or nest on Right, and steps into an open folder's first child`, () => {
        expect(keyIntent(press(`ArrowRight`), view(`src/api`))).toEqual({ kind: `toggleExpand`, path: `src/api` });
        expect(keyIntent(press(`ArrowRight`), view(`package.json`))).toEqual({ kind: `toggleExpand`, path: `package.json` });
        expect(keyIntent(press(`ArrowRight`), view(`src`))).toEqual({ kind: `select`, path: `src/api` });
    });

    it(`does nothing on Right for a file, an open folder with nothing under it, or a lead that is not a row`, () => {
        const openEmpty: readonly (Row | MoreRow)[] = [
            { entry: SRC, depth: 0, isExpanded: true },
            { more: 3, depth: 1, key: `src#more` },
        ];

        expect(keyIntent(press(`ArrowRight`), view(`README.md`))).toEqual(NONE);
        expect(keyIntent(press(`ArrowRight`), view(`src`, { rows: openEmpty }))).toEqual(NONE);
        expect(keyIntent(press(`ArrowRight`), view(`src/api/routes.ts`))).toEqual(NONE);
    });

    it(`closes an open folder on Left, and otherwise climbs to the nearest shallower row`, () => {
        expect(keyIntent(press(`ArrowLeft`), view(`src`))).toEqual({ kind: `toggleExpand`, path: `src` });
        expect(keyIntent(press(`ArrowLeft`), view(`src/main.ts`))).toEqual({ kind: `select`, path: `src` });
        expect(keyIntent(press(`ArrowLeft`), view(`src/api`))).toEqual({ kind: `select`, path: `src` });
        expect(keyIntent(press(`ArrowLeft`), view(`README.md`))).toEqual(NONE);
        expect(keyIntent(press(`ArrowLeft`), view(null))).toEqual(NONE);
    });
});

describe(`the verbs`, () => {
    it(`toggles the lead into the selection on Space, and activates its entry on Enter`, () => {
        expect(keyIntent(press(` `), view(`src/main.ts`))).toEqual({ kind: `toggleSelected`, path: `src/main.ts` });
        expect(keyIntent(press(` `), view(null))).toEqual(NONE);
        expect(keyIntent(press(`Enter`), view(`src/main.ts`))).toEqual({ kind: `activate`, entry: MAIN });
        expect(keyIntent(press(`Enter`), view(`gone.ts`))).toEqual(NONE);
        expect(keyIntent(press(`Enter`), view(null))).toEqual(NONE);
    });

    it(`renames on F2 only a lone lead, and deselects, deletes and selects all whatever the lead`, () => {
        expect(keyIntent(press(`F2`), view(`src/main.ts`))).toEqual({ kind: `rename`, path: `src/main.ts` });
        expect(keyIntent(press(`F2`), view(`src/main.ts`, { selected: 0 }))).toEqual({ kind: `rename`, path: `src/main.ts` });
        expect(keyIntent(press(`F2`), view(`src/main.ts`, { selected: 2 }))).toEqual(NONE);
        expect(keyIntent(press(`F2`), view(null))).toEqual(NONE);
        expect(keyIntent(press(`Escape`), view(null))).toEqual({ kind: `deselect` });
        expect(keyIntent(press(`Delete`), view(null))).toEqual({ kind: `delete` });
        expect(keyIntent(press(`a`, { ctrlKey: true }), view(null))).toEqual({ kind: `selectAll` });
        expect(keyIntent(press(`A`, { metaKey: true }), view(null))).toEqual({ kind: `selectAll` });
    });

    it(`leaves the page every key the tree does not own, the clipboard's chords included`, () => {
        expect(
            [press(`a`), press(`Tab`), press(`c`, { ctrlKey: true }), press(`v`, { metaKey: true }), press(`Backspace`)].map((key) =>
                keyIntent(key, view(`src`)),
            ),
        ).toEqual([undefined, undefined, undefined, undefined, undefined]);
    });
});
