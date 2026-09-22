import type { WorkspaceTreeEntry } from "@intentic/api-contract";
import type { MenuItem } from "primevue/menuitem";
import { describe, it, expect, mock } from "bun:test";
import { type EntryMenuInput, type EntryVerbs, entryMenuItems } from "./entryMenu";

const file: WorkspaceTreeEntry = { name: `a.ts`, path: `src/a.ts`, type: `file` };
const dir: WorkspaceTreeEntry = { name: `src`, path: `src`, type: `dir`, children: [] };

const verbs = (): EntryVerbs => ({
    newFile: mock(),
    newFolder: mock(),
    rename: mock(),
    extract: mock(),
    keepFolder: mock(),
    remove: mock(),
    cut: mock(),
    copy: mock(),
    paste: mock(),
});
const input = (over: Partial<EntryMenuInput> = {}): EntryMenuInput => ({
    target: file,
    locked: false,
    canEdit: true,
    archived: false,
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

    it(`offers Extract to one archive, and to nothing the sandbox can't unpack`, () => {
        const zip: WorkspaceTreeEntry = { name: `site.zip`, path: `drops/site.zip`, type: `file` };
        expect(labels(entryMenuItems(input({ target: zip })))).toEqual([
            `New File`,
            `New Folder`,
            `—`,
            `Extract`,
            `Rename`,
            `Delete`,
            `—`,
            `Cut`,
            `Copy`,
        ]);
        expect(labels(entryMenuItems(input({ target: zip, multi: true, count: 2 })))).not.toContain(`Extract`);
        expect(labels(entryMenuItems(input({ target: { ...zip, name: `site.7z`, path: `drops/site.7z` } })))).not.toContain(`Extract`);
        // A folder can be named like an archive without being one.
        expect(labels(entryMenuItems(input({ target: { ...dir, name: `site.zip`, path: `site.zip` } })))).not.toContain(`Extract`);
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
        expect(labels(items)).toEqual([`Open management panel`, `—`, `Read-only: changing files needs writer access`]);
        expect(items.at(-1)?.disabled).toBe(true);
    });

    it(`does not lead a read-only menu with a separator when nothing else is readable`, () => {
        const items = entryMenuItems(input({ canEdit: false }));
        expect(labels(items)).toEqual([`Read-only: changing files needs writer access`]);
        expect(items[0]?.separator).not.toBe(true);
    });

    it(`inside an archive keeps the read verbs and the one that gets something out`, () => {
        const items = entryMenuItems(input({ archived: true, head: [{ label: `Open` }], tail: [{ label: `Collapse Folders` }] }));
        expect(labels(items)).toEqual([`Open`, `—`, `Copy`, `—`, `Collapse Folders`, `—`, `Inside an archive: extract it to change anything`]);
        expect(items.at(-1)?.disabled).toBe(true);
    });

    it(`counts a bulk copy out of an archive, and offers nothing on its background`, () => {
        expect(labels(entryMenuItems(input({ archived: true, multi: true, count: 3 })))).toContain(`Copy 3 items`);
        // Nothing lands in an archive, so its background has no create to offer.
        expect(labels(entryMenuItems(input({ archived: true, target: undefined, clipboardFull: true })))).toEqual([
            `Inside an archive: extract it to change anything`,
        ]);
    });

    it(`drops a folder's own rows inside an archive: they are about the workspace, not a copy of one`, () => {
        expect(labels(entryMenuItems(input({ archived: true, target: dir, lead: [{ label: `Open management panel` }] })))).not.toContain(
            `Open management panel`,
        );
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
        expect(spec.verbs.remove).toHaveBeenCalledTimes(1);
    });
});
