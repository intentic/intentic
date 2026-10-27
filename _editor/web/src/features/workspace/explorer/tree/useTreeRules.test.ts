import "@intentic/testing/dom";
import { STATE_DIR } from "@intentic/constants";
import type { WorkspaceTreeEntry } from "@intentic/sandbox-contract/schemas/workspace/workspace-tree";
import { resetSandboxScope } from "@intentic/extension-api";
import { dir, file, treeSurface } from "../../../../testing/treeSurface";
import { markFailed, noteArriving, noteLeaving } from "../../../../models/workspace/files/provisionalEntries";
import type { Row } from "./treeRows";

// Pins what a file surface lets a verb touch: never a locked, leaving or unlisted path, nor an archive's contents.

const row = (entry: WorkspaceTreeEntry): Row => ({ entry, depth: 0, isExpanded: false });
// A zip the tree has been into: its members are listed under it as ordinary rows.
const TREE = [
    dir(`src`, [file(`src/main.ts`)]),
    { ...file(`assets.zip`), children: [dir(`assets.zip/img`, [file(`assets.zip/img/logo.png`)])] },
    dir(STATE_DIR, [file(`${STATE_DIR}/config/capabilities.json`)]),
    { ...file(`gone`), link: { to: `../nowhere`, state: `broken` as const } },
];

afterEach(() => {
    resetSandboxScope();
});

describe(`what a verb may touch`, () => {
    it(`leaves out a locked path, one on its way out, and one the listing hasn't caught up with`, () => {
        noteArriving(`src/notes.md`, { kind: `upload` });
        noteLeaving(`src/main.ts`);
        const { rules } = treeSurface(TREE);

        expect(rules.unlockedOnly([`src`, `src/main.ts`, `src/notes.md`, `.intentic/config/capabilities.json`, `.intentic`])).toEqual([
            `src`,
            `.intentic`,
        ]);
    });

    it(`calls a row provisional only where the listing lacks it`, () => {
        noteArriving(`photos/trip/one.jpg`, { kind: `upload` });
        noteArriving(`src/main.ts`, { kind: `write` });
        const { rules } = treeSurface(TREE);

        expect([rules.pendingRow(`photos/trip/one.jpg`)?.state, rules.pending(`photos`), rules.pending(`src/main.ts`), rules.pending(`src`)]).toEqual(
            [`arriving`, true, false, false],
        );
        markFailed(`photos/trip/one.jpg`);
        expect(rules.pendingRow(`photos/trip/one.jpg`)?.state).toBe(`failed`);
    });
});

describe(`an archive's contents`, () => {
    it(`are read-only below the archive, which is itself ordinary workspace content`, () => {
        const { rules } = treeSurface(TREE);

        expect([rules.archiveDir(`assets.zip`), rules.archiveDir(`assets.zip/img`), rules.archiveDir(`src`)]).toEqual([true, true, false]);
        expect([rules.archived(`assets.zip/img/logo.png`), rules.archived(`assets.zip`), rules.archived(`src/main.ts`)]).toEqual([
            true,
            false,
            false,
        ]);
    });

    it(`refuse a verb aimed inside them in words, before the member tier is even asked`, () => {
        const { rules, store } = treeSurface(TREE);

        expect(rules.refuseIn(`assets.zip/img`)).toBe(true);
        expect(store.actionError.value).toEqual({ tone: `danger`, title: `An archive's contents are read-only. Extract it to change them.` });
    });

    it(`pass any other folder to the member's edit fence, refused without a word since no verb was offered there`, () => {
        const writer = treeSurface(TREE);
        const reader = treeSurface(TREE, { canWrite: false });
        const docsWriter = treeSurface(TREE, { editFence: [`docs`] });

        expect([writer.rules.refuseIn(`src`), reader.rules.refuseIn(`src`), docsWriter.rules.refuseIn(`src`), docsWriter.rules.refuseIn(`docs/guides`)]).toEqual([
            false,
            true,
            true,
            false,
        ]);
        expect([writer.store.actionError.value, reader.store.actionError.value]).toEqual([undefined, undefined]);
    });
});

describe(`drops`, () => {
    it(`offers a row's folder to a drop, but not a private one, an archive's, or a dead link's`, () => {
        const { rules } = treeSurface(TREE);

        expect(
            [
                row(dir(`src`)),
                row(file(`src/main.ts`)),
                row(dir(`.intentic/secrets/auth`)),
                row(dir(`assets.zip/img`)),
                row({ ...file(`gone`), link: { to: `../nowhere`, state: `broken` } }),
            ].map(rules.dropTargetOf),
        ).toEqual([`src`, `src`, undefined, undefined, undefined]);
        expect([rules.noDrops(`.intentic/secrets/auth`), rules.noDrops(`assets.zip`), rules.noDrops(`.intentic`)]).toEqual([true, true, false]);
    });

    it(`offers no folder outside the member's edit fence as a place to land`, () => {
        const { rules } = treeSurface(TREE, { editFence: [`src`] });

        expect([row(dir(`src`)), row(file(`src/main.ts`)), row(dir(`docs`))].map(rules.dropTargetOf)).toEqual([`src`, `src`, undefined]);
        expect([rules.noDrops(``), rules.noDrops(`src`)]).toEqual([true, false]);
    });
});

// `.intentic` and its groups: deleting one would take the sandbox's settings, sign-ins and history with it.
describe(`a folder the sandbox keeps in place`, () => {
    const CONFIG = `${STATE_DIR}/config`;
    const KEPT = [dir(STATE_DIR, [dir(CONFIG, [file(`${CONFIG}/settings.json`)])]), dir(`src`, [file(`src/main.ts`)])];
    const said = (name: string) => ({ tone: `danger` as const, title: `"${name}" holds sandbox settings, so it stays put.` });
    const drain = async (): Promise<void> => {
        for (let tick = 0; tick < 4; tick += 1) {
            await Promise.resolve();
        }
    };

    it(`is never deleted, nor the rest of a selection it sits in, and the reader is told why`, () => {
        const { deleting, store, select } = treeSurface(KEPT);
        select(`src/main.ts`, STATE_DIR);
        deleting.requestDelete();

        expect([store.removeEntries.mock.calls, store.actionError.value]).toEqual([[], said(STATE_DIR)]);
    });

    it(`is never renamed or cut, nor carried by Move Here, though it can still be copied`, async () => {
        const { edits, inline, transfer, store, select, selecting } = treeSurface(KEPT);
        edits.beginRename(CONFIG);
        expect([inline.edit.value.kind, store.actionError.value]).toEqual([`idle`, said(`config`)]);

        select(CONFIG);
        expect([transfer.stage(`cut`, `event`), store.clipboard.value]).toEqual([[], undefined]);
        expect(transfer.stage(`copy`, `event`)).toEqual([CONFIG]);

        selecting.lead.value = `src/main.ts`;
        await transfer.moveHere();
        expect(store.moveIntoMany.mock.calls).toEqual([]);
    });

    it(`never lifts on a drag that would move it`, () => {
        const { transfer } = treeSurface(KEPT);
        transfer.onPointerDown(new PointerEvent(`pointerdown`, { button: 0, clientX: 10, clientY: 10 }), STATE_DIR);
        window.dispatchEvent(new PointerEvent(`pointermove`, { cancelable: true, clientX: 60, clientY: 60 }));

        expect(transfer.carried(STATE_DIR)).toBe(false);
        window.dispatchEvent(new PointerEvent(`pointerup`));
    });

    it(`is written inside like any folder, and what it holds is deleted like anything else`, async () => {
        const { deleting, edits, inline, store, select } = treeSurface(KEPT);
        edits.beginCreate(CONFIG, `file`);
        expect(inline.edit.value.kind).toBe(`creating`);

        select(`${CONFIG}/settings.json`);
        deleting.requestDelete();
        await drain();
        expect([store.removeEntries.mock.calls, store.actionError.value]).toEqual([[[[`${CONFIG}/settings.json`]]], undefined]);
    });
});
