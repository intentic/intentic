import { STATE_DIR } from "@intentic/constants";
import "@intentic/testing/dom";
import type { WorkspaceTreeEntry } from "@intentic/api-contract";
import { afterEach, describe, expect, it, mock } from "bun:test";
import { computed, effectScope, ref, shallowRef } from "vue";
import type { OpenMode } from "../../tabs/workspaceTabs";
import { beginEntryDrag } from "../transfer/useEntryDrag";
import type { MoreRow, Row } from "./treeRows";
import { useTreeGestures } from "./useTreeGestures";
import { useTreeSelection } from "./useTreeSelection";

// Pins what a press on the tree does: a click selects, picks and activates, Shift and Ctrl only select, a double-click
// keeps a file, a nest's chevron toggles it, the background drops the selection, and each key's intent is carried out.

const entry = (path: string, type: "file" | "dir"): WorkspaceTreeEntry => ({ name: path.slice(path.lastIndexOf(`/`) + 1), path, type });
const SRC = entry(`src`, `dir`);
const MAIN = entry(`src/main.ts`, `file`);
const PKG = entry(`package.json`, `file`);
const ZIP = entry(`bundle.zip`, `file`);
const AUTH = entry(`${STATE_DIR}/secrets/auth`, `dir`);
const NOTES = entry(`notes.md`, `file`);
const README = entry(`README.md`, `file`);
const ROWS: readonly (Row | MoreRow)[] = [
    { entry: SRC, depth: 0, isExpanded: true },
    { entry: MAIN, depth: 1, isExpanded: false },
    { entry: PKG, depth: 0, isExpanded: false, nest: true },
    { entry: ZIP, depth: 0, isExpanded: false },
    { entry: AUTH, depth: 0, isExpanded: false },
    { entry: NOTES, depth: 0, isExpanded: false },
    { entry: README, depth: 0, isExpanded: false },
];
const rowOf = (target: WorkspaceTreeEntry): Row => ROWS.find((row): row is Row => !(`more` in row) && row.entry === target) as Row;

const gesturesOver = () => {
    const rows = shallowRef(ROWS);
    const order = computed(() => rows.value.flatMap((row) => (`more` in row ? [] : [row.entry.path])));
    const done: string[] = [];
    const host = {
        rows,
        order,
        byPath: shallowRef(new Map([SRC, MAIN, PKG, ZIP, AUTH, NOTES, README].map((item) => [item.path, item]))),
        manageableDirs: () => new Set([`src`]),
        pending: (path: string) => path === `notes.md`,
        toggleExpand: mock((path: string) => done.push(`toggle ${path}`)),
        editing: ref(false),
        beginRename: mock((path: string) => done.push(`rename ${path}`)),
        requestDelete: mock(() => done.push(`delete`)),
        focusRow: mock((path: string) => done.push(`focus ${path}`)),
        focusLead: mock(() => {
            done.push(`focus lead`);
            return Promise.resolve();
        }),
        openFile: mock((path: string, mode: OpenMode) => done.push(`open ${path} ${mode}`)),
        openDirectory: mock((path: string) => done.push(`manage ${path}`)),
        pick: mock((picked: WorkspaceTreeEntry) => done.push(`pick ${picked.path}`)),
        cleared: mock(() => done.push(`cleared`)),
    };
    const { selecting, gestures } = effectScope().run(() => {
        const selection = useTreeSelection({ selectedPath: () => undefined, order });
        return { selecting: selection, gestures: useTreeGestures({ ...host, selecting: selection }) };
    })!;
    const state = () => ({ selected: [...selecting.selection.value], anchor: selecting.anchor.value, lead: selecting.lead.value });
    return { gestures, selecting, host, done, state };
};
const click = (mods: MouseEventInit = {}): MouseEvent => new MouseEvent(`click`, { bubbles: true, ...mods });
const key = (name: string, mods: KeyboardEventInit = {}): KeyboardEvent => new KeyboardEvent(`keydown`, { key: name, cancelable: true, ...mods });

afterEach(() => {
    Reflect.deleteProperty(document, `elementFromPoint`);
});

describe(`a click on a row`, () => {
    it(`focuses and selects it, picks it, then opens a file as a peek, or toggles a folder`, () => {
        const { gestures, done, state } = gesturesOver();

        gestures.onRowClick(click(), rowOf(MAIN));
        expect([done, state()]).toEqual([
            [`focus src/main.ts`, `pick src/main.ts`, `open src/main.ts preview`],
            { selected: [`src/main.ts`], anchor: `src/main.ts`, lead: `src/main.ts` },
        ]);

        done.length = 0;
        gestures.onRowClick(click(), rowOf(SRC));
        gestures.onRowClick(click(), rowOf(ZIP));
        expect(done).toEqual([`focus src`, `pick src`, `toggle src`, `focus bundle.zip`, `pick bundle.zip`, `toggle bundle.zip`]);
    });

    it(`opens a locked path's explanation instead of expanding it, and nothing for a row still arriving`, () => {
        const { gestures, done } = gesturesOver();

        gestures.onRowClick(click(), rowOf(AUTH));
        gestures.onRowClick(click(), rowOf(NOTES));
        expect(done).toEqual([
            `focus .intentic/secrets/auth`,
            `pick .intentic/secrets/auth`,
            `open .intentic/secrets/auth preview`,
            `focus notes.md`,
            `pick notes.md`,
        ]);
    });

    it(`ranges from the anchor with Shift and toggles with Ctrl or Cmd, opening nothing`, () => {
        const { gestures, done, state } = gesturesOver();
        gestures.onRowClick(click({ shiftKey: true }), rowOf(PKG));
        expect(done.at(-1)).toBe(`open package.json preview`);

        done.length = 0;
        gestures.onRowClick(click({ shiftKey: true }), rowOf(MAIN));
        expect([done, state()]).toEqual([
            [`focus src/main.ts`],
            { selected: [`src/main.ts`, `package.json`], anchor: `package.json`, lead: `src/main.ts` },
        ]);

        gestures.onRowClick(click({ metaKey: true }), rowOf(README));
        gestures.onRowClick(click({ ctrlKey: true }), rowOf(PKG));
        expect([done, state()]).toEqual([
            [`focus src/main.ts`, `focus README.md`, `focus package.json`],
            { selected: [`src/main.ts`, `README.md`], anchor: `package.json`, lead: `package.json` },
        ]);
    });

    it(`is not a click at all when it is the release that ended a drag`, () => {
        const { gestures, done, state } = gesturesOver();
        document.elementFromPoint = () => null;
        beginEntryDrag(new PointerEvent(`pointerdown`, { button: 0, clientX: 0, clientY: 0 }), { paths: [`README.md`], onDrop: () => undefined });
        window.dispatchEvent(new PointerEvent(`pointermove`, { cancelable: true, clientX: 60, clientY: 60 }));
        window.dispatchEvent(new PointerEvent(`pointerup`));

        gestures.onRowClick(click(), rowOf(README));
        expect([done, state().selected]).toEqual([[], []]);
    });
});

describe(`the other presses`, () => {
    it(`keeps a double-clicked file or locked path, and leaves a folder, an archive or an arriving row alone`, () => {
        const { gestures, done } = gesturesOver();

        for (const target of [MAIN, SRC, ZIP, AUTH, NOTES]) {
            gestures.onRowDblClick(rowOf(target));
        }
        expect(done).toEqual([`open src/main.ts keep`, `open .intentic/secrets/auth keep`]);
    });

    it(`toggles a nest from its chevron without the row hearing, and lets a folder's chevron through to the row`, () => {
        const { gestures, done } = gesturesOver();
        const onNest = click();
        const onFolder = click();

        gestures.onChevronClick(onNest, rowOf(PKG));
        gestures.onChevronClick(onFolder, rowOf(SRC));
        expect([done, onNest.cancelBubble, onFolder.cancelBubble]).toEqual([[`toggle package.json`], true, false]);
    });

    it(`drops the selection and its anchor on a background click, keeping the lead, and says it did`, () => {
        const { gestures, selecting, done, state } = gesturesOver();
        selecting.selectSingle(`README.md`);

        gestures.onBackgroundClick();
        expect([state(), done]).toEqual([{ selected: [], anchor: null, lead: `README.md` }, [`cleared`]]);
    });
});

describe(`the keyboard`, () => {
    it(`moves the selection or the cursor and takes the focus with it`, () => {
        const { gestures, selecting, done, state } = gesturesOver();
        selecting.selectSingle(`src`);

        gestures.onKeydown(key(`ArrowDown`));
        expect([state(), done]).toEqual([{ selected: [`src/main.ts`], anchor: `src/main.ts`, lead: `src/main.ts` }, [`focus lead`]]);
        gestures.onKeydown(key(`ArrowDown`, { ctrlKey: true }));
        gestures.onKeydown(key(` `));
        expect(state()).toEqual({ selected: [`src/main.ts`, `package.json`], anchor: `package.json`, lead: `package.json` });
        gestures.onKeydown(key(`End`, { shiftKey: true }));
        expect(state().selected).toEqual([`package.json`, `bundle.zip`, `.intentic/secrets/auth`, `notes.md`, `README.md`]);
    });

    it(`activates the lead on Enter as a click would, and also opens a managed folder's panel`, () => {
        const { gestures, selecting, done } = gesturesOver();
        selecting.selectSingle(`src`);

        gestures.onKeydown(key(`Enter`));
        expect(done).toEqual([`pick src`, `toggle src`, `manage src`]);
    });

    it(`deselects keeping the lead, selects all, renames and deletes, each kept from the page`, () => {
        const { gestures, selecting, done, state } = gesturesOver();
        selecting.selectSingle(`README.md`);
        const escape = key(`Escape`);

        gestures.onKeydown(escape);
        expect([state(), escape.defaultPrevented]).toEqual([{ selected: [], anchor: `README.md`, lead: `README.md` }, true]);
        gestures.onKeydown(key(`a`, { metaKey: true }));
        expect(state().selected).toEqual([`src`, `src/main.ts`, `package.json`, `bundle.zip`, `.intentic/secrets/auth`, `notes.md`, `README.md`]);
        gestures.onKeydown(key(`Delete`));
        selecting.selectSingle(`README.md`);
        gestures.onKeydown(key(`F2`));
        expect(done).toEqual([`delete`, `rename README.md`]);
    });

    it(`leaves the page every key it does not own, and every key while a name is being typed`, () => {
        const { gestures, host, selecting, done } = gesturesOver();
        selecting.selectSingle(`src`);
        const tab = key(`Tab`);
        gestures.onKeydown(tab);

        host.editing.value = true;
        const typed = key(`ArrowDown`);
        gestures.onKeydown(typed);
        expect([tab.defaultPrevented, typed.defaultPrevented, done, selecting.lead.value]).toEqual([false, false, [], `src`]);
    });
});
