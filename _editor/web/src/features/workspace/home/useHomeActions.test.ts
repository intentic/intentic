import "@intentic/testing/dom";
import type { WorkspaceTreeEntry } from "@intentic/api-contract";
import { resetSandboxScope } from "@intentic/extension-api";
import { unstubbed } from "@intentic/testing";
import { effectScope, nextTick, ref } from "vue";
import { dir, fakeTreeStore, file } from "../../../testing/treeSurface";

// Pins what the home adds to the tree's verbs (pinned in explorer/tree): the shared lead, and the open folder as target.

const SUB = dir(`docs/sub`, []);
const A = file(`docs/a.md`);
const B = file(`docs/b.md`);
const TREE = [dir(`docs`, [SUB, A, B])];

let current = fakeTreeStore(TREE);
const uploads = { enqueue: jest.fn(() => Promise.resolve()), enqueueFromDataTransfer: jest.fn() };
jest.mock(`../explorer/useWorkspaceTree`, () => ({ useWorkspaceTree: () => current.store }));
jest.mock(`../files/upload/useUploadQueue`, () => ({ useUploadQueue: () => uploads }));
const { useHomeActions } = await import(`./useHomeActions`);

// The home open on `docs`, its three tiles in reading order.
const homeOver = () => {
    current = fakeTreeStore(TREE);
    const order = ref<readonly WorkspaceTreeEntry[]>([SUB, A, B]);
    const lead = ref<string | undefined>(undefined);
    const open = jest.fn((entry: WorkspaceTreeEntry) => entry.path);
    const el = document.createElement(`div`);
    document.body.append(el);
    const home = effectScope().run(() =>
        useHomeActions({ dir: ref(`docs`), order, lead, host: ref(el), open, openCreated: jest.fn(), dirActions: () => [] }),
    )!;
    const marked = (): string[] => [...home.selection.value];
    return { home, order, lead, open, store: current.store, marked };
};
const CTRL = { shiftKey: false, ctrlKey: true, metaKey: false };
const SHIFT = { shiftKey: true, ctrlKey: false, metaKey: false };
const key = (name: string, init: KeyboardEventInit = {}): KeyboardEvent => new KeyboardEvent(`keydown`, { key: name, cancelable: true, ...init });

afterEach(() => {
    resetSandboxScope();
    document.body.replaceChildren();
});

describe(`the tiles' selection`, () => {
    it(`selects like the tree, moving the shared current entry with every gesture`, async () => {
        const { home, lead, marked } = homeOver();
        home.select(A.path);
        home.select(SUB.path, SHIFT);
        await nextTick();
        const ranged = [marked(), lead.value];
        home.select(B.path, CTRL);
        home.select(SUB.path, CTRL);
        await nextTick();
        const toggled = [marked(), lead.value];
        home.handleKey(key(`a`, { ctrlKey: true }));
        const all = marked();
        home.clear();

        expect([ranged, toggled, all, [marked(), lead.value]]).toEqual([
            [[`docs/sub`, `docs/a.md`], `docs/sub`],
            [[`docs/a.md`, `docs/b.md`], `docs/sub`],
            [`docs/sub`, `docs/a.md`, `docs/b.md`],
            [[], undefined],
        ]);
    });

    it(`follows a current entry set elsewhere, drops one that is no tile here, and forgets tiles that left`, async () => {
        const { home, order, lead, marked } = homeOver();
        lead.value = B.path;
        await nextTick();
        const followed = marked();
        lead.value = `docs`;
        await nextTick();
        const dropped = marked();
        home.select(A.path);
        home.select(B.path, CTRL);
        await nextTick();
        order.value = [SUB, A];
        await nextTick();

        expect([followed, dropped, marked()]).toEqual([[`docs/b.md`], [], [`docs/a.md`]]);
    });
});

describe(`the verbs`, () => {
    it(`create in the open folder from a folder tile's menu, which leads with Open`, () => {
        const { home, open } = homeOver();
        home.menu.value = { show: jest.fn() };
        home.openMenu(new MouseEvent(`contextmenu`), SUB);
        const [first] = home.menuItems.value;
        first?.command?.({ originalEvent: new Event(`click`), item: first });
        home.menuItems.value.find((item) => item.label === `New File`)?.command?.({ originalEvent: new Event(`click`), item: {} });

        expect([first?.label, open.mock.calls, home.inline.edit.value]).toEqual([`Open`, [[SUB]], { kind: `creating`, dir: `docs`, type: `file` }]);
    });

    it(`paste from the keyboard into the open folder, marking what landed, and into a folder tile unmarked`, async () => {
        const { home, order, store, marked } = homeOver();
        store.clipboard.value = { mode: `copy`, paths: [A.path] };
        // Drawn the moment the copy is asked for, as the store's provisional entry is.
        order.value = [...order.value, file(`docs/a copy.md`)];
        home.select(SUB.path);
        const event = unstubbed<ClipboardEvent>(`paste`, {
            clipboardData: unstubbed<DataTransfer>(`clipboardData`, { files: [] as unknown as FileList }),
            preventDefault: jest.fn(),
        });
        home.transfer.onPasteEvent(event);
        await new Promise((resolve) => setTimeout(resolve, 0));
        const landed = marked();
        await home.transfer.paste(SUB.path);

        expect([store.copyEntries.mock.calls, landed, marked()]).toEqual([
            [[[{ from: `docs/a.md`, to: `docs/a copy.md` }]], [[{ from: `docs/a.md`, to: `docs/sub/a.md` }]]],
            [`docs/a copy.md`],
            [`docs/a copy.md`],
        ]);
    });

    it(`rename the lead alone on F2, ask about the whole selection on Delete, and leave every key to a name being typed`, async () => {
        const { home, marked } = homeOver();
        home.select(A.path);
        home.handleKey(key(`F2`));
        const renaming = home.inline.edit.value;
        const typing = [home.handleKey(key(`Delete`)), home.confirmPaths.value];
        await home.endEdit(`cancel`);
        home.select(B.path, CTRL);
        home.handleKey(key(`F2`));
        home.handleKey(key(`Delete`));

        expect([renaming, typing, home.inline.edit.value, home.confirmPaths.value, marked()]).toEqual([
            { kind: `renaming`, path: `docs/a.md` },
            [true, undefined],
            { kind: `idle` },
            [`docs/a.md`, `docs/b.md`],
            [`docs/a.md`, `docs/b.md`],
        ]);
    });
});
