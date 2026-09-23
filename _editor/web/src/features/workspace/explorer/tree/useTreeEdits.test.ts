import { STATE_DIR } from "@intentic/constants";
import "@intentic/testing/dom";
import type { WorkspaceTreeEntry } from "@intentic/api-contract";
import { resetSandboxScope } from "@intentic/extension-api";
import { afterEach, describe, expect, it, mock } from "bun:test";
import { effectScope, h, nextTick, render, shallowRef, type VNode } from "vue";
import { focusField, useInlineEdit, useTreeEdits } from "./useTreeEdits";

// Pins what the inline field's gestures do to the tree: who may open it, the live check on a new name, the rename and
// the create each writes, where the selection and the keyboard land, when a new file opens, and that Enter can't write twice.

const file = (path: string): WorkspaceTreeEntry => ({ name: path.slice(path.lastIndexOf(`/`) + 1), path, type: `file` });

// The daemon's answers park until the test lets them through, so the tree can be read while a write is in flight.
const editsOver = (listed: readonly string[] = [`src/main.ts`], refused: ReadonlySet<string> = new Set()) => {
    const byPath = shallowRef(new Map(listed.map((path) => [path, file(path)])));
    let release = (): void => undefined;
    const answered = new Promise<void>((resolve) => {
        release = resolve;
    });
    const calls: string[] = [];
    const store = {
        run: mock(async (task: () => Promise<void>, wrote: string): Promise<void> => {
            calls.push(`run: ${wrote}`);
            await task();
        }),
        moveEntry: mock(async (from: string, to: string): Promise<void> => {
            await answered;
            if (!refused.has(to)) {
                byPath.value = new Map([...byPath.value].filter(([path]) => path !== from).concat([[to, file(to)]]));
            }
        }),
        createFile: mock(async (path: string): Promise<void> => {
            await answered;
            if (!refused.has(path)) {
                byPath.value = new Map([...byPath.value, [path, file(path)]]);
            }
        }),
        createDir: mock(async (path: string): Promise<void> => {
            await answered;
            calls.push(`mkdir ${path}`);
        }),
    };
    const host = {
        byPath,
        rules: { pending: mock((path: string) => path === `src/arriving.md`), refuseIn: mock((dir: string) => dir === `docs`) },
        targetDir: (path: string | null) => (path === null ? `` : path.slice(0, Math.max(0, path.lastIndexOf(`/`)))),
        openFolder: mock((dir: string) => calls.push(`open ${dir}`)),
        selectSingle: mock((path: string) => calls.push(`select ${path}`)),
        focusLead: mock(async () => {
            calls.push(`focus`);
        }),
        store,
        openCreated: mock((path: string) => calls.push(`opened ${path}`)),
    };
    const { inline, edits } = effectScope().run(() => {
        const field = useInlineEdit((path) => byPath.value.has(path));
        return { inline: field, edits: useTreeEdits({ inline: field, ...host }) };
    })!;
    return { inline, edits, host, store, calls, release };
};
const typeInto = (inline: ReturnType<typeof useInlineEdit>, text: string): void => {
    inline.draft.value = text;
};

afterEach(() => {
    resetSandboxScope();
});

describe(`opening the field`, () => {
    it(`opens a rename on the row's own name, but not on a locked, arriving or refused path`, () => {
        const { inline, edits, host } = editsOver();

        edits.beginRename(`${STATE_DIR}/config/capabilities.json`);
        edits.beginRename(`src/arriving.md`);
        edits.beginRename(`docs/guide.md`);
        expect(inline.edit.value).toEqual({ kind: `idle` });
        expect(host.rules.refuseIn.mock.calls).toEqual([[`docs`]]);

        edits.beginRename(`src/main.ts`);
        expect([inline.edit.value, inline.draft.value, inline.editing.value]).toEqual([{ kind: `renaming`, path: `src/main.ts` }, `main.ts`, true]);
    });

    it(`opens a create in its folder, opening that folder first, unless the folder refuses a write`, () => {
        const { inline, edits, calls } = editsOver();

        edits.beginCreate(`docs`, `file`);
        expect([inline.edit.value, calls]).toEqual([{ kind: `idle` }, []]);

        edits.beginCreate(`src`, `dir`);
        expect([inline.edit.value, inline.draft.value, calls]).toEqual([{ kind: `creating`, dir: `src`, type: `dir` }, ``, [`open src`]]);
    });

    it(`checks a new name as it is typed, and says nothing about an empty one`, () => {
        const { inline, edits } = editsOver();
        edits.beginCreate(`src`, `file`);

        expect(inline.createError.value).toBeUndefined();
        typeInto(inline, `main.ts`);
        expect(inline.createError.value).toBe(`"main.ts" already exists.`);
        typeInto(inline, `a/b`);
        expect(inline.createError.value).toBe(`Invalid name.`);
        typeInto(inline, `notes.md`);
        expect(inline.createError.value).toBeUndefined();
    });
});

describe(`ending the field`, () => {
    it(`renames in the row's folder and selects the new name before the daemon answers`, async () => {
        const { inline, edits, store, calls, release } = editsOver();
        edits.beginRename(`src/main.ts`);
        typeInto(inline, `entry.ts`);

        await edits.endEdit(`commit`);
        expect([inline.edit.value, store.moveEntry.mock.calls, calls]).toEqual([
            { kind: `idle` },
            [[`src/main.ts`, `src/entry.ts`]],
            [`run: Couldn't rename that.`, `select src/entry.ts`],
        ]);
        release();
    });

    it(`creates a file, lands the selection and the keyboard on its row, and opens it once the daemon has it`, async () => {
        const { inline, edits, calls, release } = editsOver();
        edits.beginCreate(`src`, `file`);
        typeInto(inline, `notes.md`);

        const ending = edits.endEdit(`commit`);
        await nextTick();
        expect(calls).toEqual([`open src`, `run: Couldn't create that file.`, `select src/notes.md`, `focus`]);

        release();
        await ending;
        expect(calls.at(-1)).toBe(`opened src/notes.md`);
    });

    it(`opens nothing for a file the daemon refused, and nothing for a folder`, async () => {
        const refusedFile = editsOver([], new Set([`src/notes.md`]));
        refusedFile.edits.beginCreate(`src`, `file`);
        typeInto(refusedFile.inline, `notes.md`);
        refusedFile.release();
        await refusedFile.edits.endEdit(`commit`);

        const folder = editsOver();
        folder.edits.beginCreate(`src`, `dir`);
        typeInto(folder.inline, `drafts`);
        folder.release();
        await folder.edits.endEdit(`commit`);

        expect([refusedFile.host.openCreated.mock.calls, folder.host.openCreated.mock.calls]).toEqual([[], []]);
        expect(folder.calls).toEqual([`open src`, `run: Couldn't create that folder.`, `select src/drafts`, `focus`, `mkdir src/drafts`]);
    });

    it(`writes once for an Enter held down while the first write is in flight`, async () => {
        const { inline, edits, store, release } = editsOver();
        edits.beginCreate(`src`, `file`);
        typeInto(inline, `notes.md`);

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
        typeInto(inline, `main.ts`);

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
