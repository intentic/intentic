import { STATE_DIR } from "@intentic/constants";
import "@intentic/testing/dom";
import type { WorkspaceTreeEntry } from "@intentic/api-contract";
import { resetSandboxScope } from "@intentic/extension-api";
import { h, nextTick, render, type VNode } from "vue";
import { dir, file, type StoreOptions, treeSurface } from "../../../../testing/treeSurface";
import { noteArriving } from "../../files/provisionalEntries";
import { focusField } from "./useTreeEdits";

// Pins what the inline field's gestures write, where the selection lands, when a new file opens, and that Enter writes once.

const ZIP: WorkspaceTreeEntry = { ...file(`assets.zip`), children: [file(`assets.zip/guide.md`)] };
// The daemon's answers park until the test lets them through, so the surface can be read while a write is in flight.
const editsOver = (options: StoreOptions = {}) => treeSurface([dir(`src`, [file(`src/main.ts`)]), ZIP], { park: true, ...options });

afterEach(() => {
    resetSandboxScope();
});

describe(`opening the field`, () => {
    it(`opens a rename on the entry's own name, but not on a locked, arriving or archived path`, () => {
        noteArriving(`src/arriving.md`, { kind: `upload` });
        const { inline, edits, store } = editsOver();

        edits.beginRename(`${STATE_DIR}/config/capabilities.json`);
        edits.beginRename(`src/arriving.md`);
        edits.beginRename(`assets.zip/guide.md`);
        expect([inline.edit.value, store.actionError.value?.title]).toEqual([
            { kind: `idle` },
            `An archive's contents are read-only. Extract it to change them.`,
        ]);

        edits.beginRename(`src/main.ts`);
        expect([inline.edit.value, inline.draft.value, inline.editing.value]).toEqual([{ kind: `renaming`, path: `src/main.ts` }, `main.ts`, true]);
    });

    it(`opens a create in its folder, opening that folder first, unless the folder refuses a write`, () => {
        const { inline, edits, store } = editsOver();

        edits.beginCreate(`assets.zip`, `file`);
        expect([inline.edit.value, [...store.expanded.value]]).toEqual([{ kind: `idle` }, []]);

        edits.beginCreate(`src`, `dir`);
        expect([inline.edit.value, inline.draft.value, [...store.expanded.value]]).toEqual([
            { kind: `creating`, dir: `src`, type: `dir` },
            ``,
            [`src`],
        ]);
    });

    it(`checks a new name as it is typed, and says nothing about an empty one`, () => {
        const { inline, edits } = editsOver();
        edits.beginCreate(`src`, `file`);

        expect(inline.createError.value).toBeUndefined();
        inline.draft.value = `main.ts`;
        expect(inline.createError.value).toBe(`"main.ts" already exists.`);
        inline.draft.value = `a/b`;
        expect(inline.createError.value).toBe(`Invalid name.`);
        inline.draft.value = `notes.md`;
        expect(inline.createError.value).toBeUndefined();
    });
});

describe(`ending the field`, () => {
    it(`renames in the entry's folder and selects the new name before the daemon answers`, async () => {
        const { inline, edits, store, selecting, calls, release } = editsOver();
        edits.beginRename(`src/main.ts`);
        inline.draft.value = `entry.ts`;

        await edits.endEdit(`commit`);
        expect([inline.edit.value, store.moveEntry.mock.calls, calls, [...selecting.selection.value]]).toEqual([
            { kind: `idle` },
            [[`src/main.ts`, `src/entry.ts`]],
            [`run: Couldn't rename that.`],
            [`src/entry.ts`],
        ]);
        release();
    });

    it(`creates a file, lands the selection and the keyboard on its entry, and opens it once the daemon has it`, async () => {
        const { inline, edits, selecting, calls, release } = editsOver();
        edits.beginCreate(`src`, `file`);
        inline.draft.value = `notes.md`;

        const ending = edits.endEdit(`commit`);
        await nextTick();
        expect([calls, [...selecting.selection.value]]).toEqual([[`run: Couldn't create that file.`, `focus`], [`src/notes.md`]]);

        release();
        await ending;
        expect(calls.slice(2)).toEqual([`write src/notes.md`, `opened src/notes.md`]);
    });

    it(`opens nothing for a file the daemon refused, and nothing for a folder`, async () => {
        const refusedFile = editsOver({ park: false, refused: new Set([`src/notes.md`]) });
        refusedFile.edits.beginCreate(`src`, `file`);
        refusedFile.inline.draft.value = `notes.md`;
        await refusedFile.edits.endEdit(`commit`);

        const folder = editsOver({ park: false });
        folder.edits.beginCreate(`src`, `dir`);
        folder.inline.draft.value = `drafts`;
        await folder.edits.endEdit(`commit`);

        expect([refusedFile.calls, folder.calls]).toEqual([
            [`run: Couldn't create that file.`, `focus`, `write src/notes.md`],
            [`run: Couldn't create that folder.`, `focus`, `mkdir src/drafts`],
        ]);
    });

    it(`writes once for an Enter held down while the first write is in flight`, async () => {
        const { inline, edits, store, release } = editsOver();
        edits.beginCreate(`src`, `file`);
        inline.draft.value = `notes.md`;

        const first = edits.endEdit(`commit`);
        const second = edits.endEdit(`commit`);
        const blur = edits.endEdit(`blur`);
        release();
        await Promise.all([first, second, blur]);

        expect(store.createFile.mock.calls).toEqual([[`src/notes.md`]]);
    });

    it(`drops a refused name on a blur, keeps it open on Enter, and closes on Escape`, async () => {
        const { inline, edits, store } = editsOver();
        edits.beginCreate(`src`, `file`);
        inline.draft.value = `main.ts`;

        await edits.endEdit(`commit`);
        expect(inline.edit.value).toEqual({ kind: `creating`, dir: `src`, type: `file` });
        await edits.endEdit(`blur`);
        expect(inline.edit.value).toEqual({ kind: `idle` });

        edits.beginRename(`src/main.ts`);
        await edits.endEdit(`cancel`);
        expect([inline.edit.value, store.createFile.mock.calls, store.moveEntry.mock.calls]).toEqual([{ kind: `idle` }, [], []]);
    });
});

describe(`the field's element`, () => {
    it(`takes the focus with its text selected the moment it mounts`, () => {
        const host = document.createElement(`div`);
        document.body.append(host);
        render(h(`input`, { value: `main.ts`, onVnodeMounted: (vnode: VNode) => focusField(vnode) }), host);
        const input = host.querySelector(`input`) as HTMLInputElement;

        expect([document.activeElement === input, input.selectionStart, input.selectionEnd]).toEqual([true, 0, 7]);
        render(null, host);
        host.remove();
    });
});
