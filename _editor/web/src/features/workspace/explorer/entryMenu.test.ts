import type { WorkspaceTreeEntry } from "@intentic/api-contract";
import type { MenuItem } from "primevue/menuitem";
import { describe, expect, it, vi } from "vitest";
import { type EntryMenuInput, type EntryVerbs, entryMenuItems } from "./entryMenu";

const file: WorkspaceTreeEntry = { name: `a.ts`, path: `src/a.ts`, type: `file` };
const dir: WorkspaceTreeEntry = { name: `src`, path: `src`, type: `dir`, children: [] };

const verbs = (): EntryVerbs => ({
    newFile: vi.fn(),
    newFolder: vi.fn(),
    rename: vi.fn(),
    keepFolder: vi.fn(),
    remove: vi.fn(),
    cut: vi.fn(),
    copy: vi.fn(),
    paste: vi.fn(),
});
const input = (over: Partial<EntryMenuInput> = {}): EntryMenuInput => ({
    target: file,
    locked: false,
    canEdit: true,
    multi: false,
    count: 1,
    barren: false,
    clipboardFull: false,
    verbs: verbs(),
    ...over,
});
// The menu as a reader scans it: labels, with a separator drawn as a rule.
const labels = (items: readonly MenuItem[]): string[] => items.map((item) => (item.separator === true ? `—` : String(item.label)));

describe(`the entry menu`, () => {
    it(`offers a file its verbs, with the creates first`, () => {
        expect(labels(entryMenuItems(input()))).toEqual([`New File`, `New Folder`, `—`, `Rename`, `Delete`, `—`, `Cut`, `Copy`]);
    });

    it(`counts a bulk verb and drops Rename, which only ever names one`, () => {
        expect(labels(entryMenuItems(input({ multi: true, count: 3 })))).toEqual([
            `New File`,
            `New Folder`,
            `—`,
            `Delete 3 items`,
            `—`,
            `Cut 3 items`,
            `Copy 3 items`,
        ]);
    });

    it(`offers only the creates on the background, and Paste once something is staged`, () => {
        expect(labels(entryMenuItems(input({ target: undefined })))).toEqual([`New File`, `New Folder`]);
        expect(labels(entryMenuItems(input({ target: undefined, clipboardFull: true })))).toEqual([`New File`, `New Folder`, `Paste`]);
    });

    it(`offers Keep folder to one empty folder chain, never to a file or a bulk selection`, () => {
        expect(labels(entryMenuItems(input({ target: dir, barren: true })))).toContain(`Keep folder`);
        expect(labels(entryMenuItems(input({ target: dir, barren: true, multi: true, count: 2 })))).not.toContain(`Keep folder`);
        expect(labels(entryMenuItems(input({ target: file, barren: true })))).not.toContain(`Keep folder`);
    });

    it(`seats each surface's own rows where it asked`, () => {
        const head = [{ label: `Open` }];
        const lead = [{ label: `Open management panel` }];
        const tail = [{ label: `Collapse Folders` }];
        expect(labels(entryMenuItems(input({ target: dir, head, lead, tail })))).toEqual([
            `Open`,
            `—`,
            `New File`,
            `New Folder`,
            `Open management panel`,
            `—`,
            `Rename`,
            `Delete`,
            `—`,
            `Cut`,
            `Copy`,
            `—`,
            `Collapse Folders`,
        ]);
    });

    it(`keeps a read-only member to the readable rows and says why`, () => {
        const items = entryMenuItems(input({ canEdit: false, lead: [{ label: `Open management panel` }] }));
        expect(labels(items)).toEqual([`Open management panel`, `—`, `Read-only: changing files needs maintainer access`]);
        expect(items.at(-1)?.disabled).toBe(true);
    });

    it(`explains a locked entry and offers nothing else`, () => {
        const items = entryMenuItems(input({ locked: true }));
        expect(labels(items)).toEqual([`Kept private by the sandbox`]);
        expect(items[0]?.disabled).toBe(true);
    });

    it(`runs the closure behind a verb`, () => {
        const spec = input();
        const remove = entryMenuItems(spec).find((item) => item.label === `Delete`);
        remove?.command?.({ originalEvent: new Event(`click`), item: remove });
        expect(spec.verbs.remove).toHaveBeenCalledOnce();
    });
});
