import "@intentic/testing/dom";
import { STATE_DIR } from "@intentic/constants";
import type { WorkspaceTreeEntry } from "@intentic/api-contract";
import { resetSandboxScope } from "@intentic/extension-api";
import { dir, file, treeSurface } from "../../../../testing/treeSurface";
import { markFailed, noteArriving, noteLeaving } from "../../files/provisionalEntries";
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
        expect(store.refuseWrite).not.toHaveBeenCalled();
    });

    it(`pass any other folder to the member tier, whose answer is the answer`, () => {
        const writer = treeSurface(TREE);
        const reader = treeSurface(TREE, { canWrite: false });

        expect([writer.rules.refuseIn(`src`), reader.rules.refuseIn(`src`)]).toEqual([false, true]);
        expect(writer.store.actionError.value).toBeUndefined();
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
});
