import { STATE_DIR } from "@intentic/constants";
import type { WorkspaceTreeEntry } from "@intentic/api-contract";
import { resetSandboxScope } from "@intentic/extension-api";
import type { Persona } from "@intentic/sandbox-contract";
import type { NoticeModel } from "@intentic/ui/async";
import { afterEach, describe, expect, it, mock } from "bun:test";
import { effectScope, ref, shallowRef } from "vue";
import { lensPersonaId } from "../../directory-ui/personaReach";
import { markFailed, noteArriving, noteLeaving } from "../../files/provisionalEntries";
import { indexEntries, type Row } from "./treeRows";
import { useTreeRules } from "./useTreeRules";

// Pins what the tree lets a verb touch and says about a row: a locked, leaving or not-yet-listed path is left out of
// every verb, an archive's contents refuse a write in words, a folder takes a drop only where one can land, a lens dims.

const nameOf = (path: string): string => path.slice(path.lastIndexOf(`/`) + 1);
const dir = (path: string, children?: WorkspaceTreeEntry[]): WorkspaceTreeEntry => ({
    name: nameOf(path),
    path,
    type: `dir`,
    ...(children === undefined ? {} : { children }),
});
const file = (path: string): WorkspaceTreeEntry => ({ name: nameOf(path), path, type: `file` });
const row = (entry: WorkspaceTreeEntry, over: Partial<Row> = {}): Row => ({ entry, depth: 0, isExpanded: false, ...over });
// A zip the tree has been into: its members are listed under it as ordinary rows.
const TREE = [
    dir(`src`, [file(`src/main.ts`)]),
    { ...file(`assets.zip`), children: [dir(`assets.zip/img`, [file(`assets.zip/img/logo.png`)])] },
    dir(STATE_DIR, [file(`${STATE_DIR}/config/capabilities.json`)]),
    { ...file(`gone`), link: { to: `../nowhere`, state: `broken` as const } },
];

const rulesOver = (canWrite = true) => {
    const store = {
        actionError: ref<NoticeModel | undefined>(undefined),
        refuseWrite: mock(() => !canWrite),
    };
    const personas = shallowRef<readonly Persona[]>([{ id: `web`, capabilities: [], workspace: { folders: [`src`] } }]);
    const byPath = shallowRef(indexEntries(TREE, (entry) => entry.children ?? []));
    const rules = effectScope().run(() => useTreeRules({ byPath, expandable: (at) => at.entry.type === `dir`, store, personas }))!;
    return { rules, store };
};

afterEach(() => {
    resetSandboxScope();
});

describe(`what a verb may touch`, () => {
    it(`leaves out a locked path, one on its way out, and one the listing hasn't caught up with`, () => {
        noteArriving(`src/notes.md`, { kind: `upload` });
        noteLeaving(`src/main.ts`);
        const { rules } = rulesOver();

        expect(rules.unlockedOnly([`src`, `src/main.ts`, `src/notes.md`, `.intentic/config/capabilities.json`, `.intentic`])).toEqual([
            `src`,
            `.intentic`,
        ]);
    });

    it(`calls a row provisional only where the listing lacks it, and unopenable only if it cannot expand either`, () => {
        noteArriving(`photos/trip/one.jpg`, { kind: `upload` });
        noteArriving(`src/main.ts`, { kind: `write` });
        const { rules } = rulesOver();

        expect([rules.pendingRow(`photos/trip/one.jpg`)?.state, rules.pending(`photos`), rules.pending(`src/main.ts`), rules.pending(`src`)]).toEqual(
            [`arriving`, true, false, false],
        );
        expect([
            rules.notYetOpenable(row(dir(`photos`))),
            rules.notYetOpenable(row(file(`photos/trip/one.jpg`))),
            rules.notYetOpenable(row(file(`src/main.ts`))),
        ]).toEqual([false, true, false]);
        markFailed(`photos/trip/one.jpg`);
        expect(rules.pendingRow(`photos/trip/one.jpg`)?.state).toBe(`failed`);
    });
});

describe(`an archive's contents`, () => {
    it(`are read-only below the archive, which is itself ordinary workspace content`, () => {
        const { rules } = rulesOver();

        expect([rules.archiveDir(`assets.zip`), rules.archiveDir(`assets.zip/img`), rules.archiveDir(`src`)]).toEqual([true, true, false]);
        expect([rules.archived(`assets.zip/img/logo.png`), rules.archived(`assets.zip`), rules.archived(`src/main.ts`)]).toEqual([
            true,
            false,
            false,
        ]);
    });

    it(`refuse a verb aimed inside them in words, before the member tier is even asked`, () => {
        const { rules, store } = rulesOver();

        expect(rules.refuseIn(`assets.zip/img`)).toBe(true);
        expect(store.actionError.value).toEqual({ tone: `danger`, title: `An archive's contents are read-only. Extract it to change them.` });
        expect(store.refuseWrite).not.toHaveBeenCalled();
    });

    it(`pass any other folder to the member tier, whose answer is the answer`, () => {
        const writer = rulesOver(true);
        const reader = rulesOver(false);

        expect([writer.rules.refuseIn(`src`), reader.rules.refuseIn(`src`)]).toEqual([false, true]);
        expect(writer.store.actionError.value).toBeUndefined();
    });
});

describe(`drops and the lens`, () => {
    it(`offers a row's folder to a drop, but not a private one, an archive's, or a dead link's`, () => {
        const { rules } = rulesOver();

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

    it(`dims only while a persona is being read as, and only what its fence refuses`, () => {
        const { rules } = rulesOver();
        expect([rules.refused(`README.md`), rules.refused(`src/main.ts`)]).toEqual([false, false]);

        lensPersonaId.value = `web`;
        expect([rules.refused(`README.md`), rules.refused(`src/main.ts`), rules.refused(`src`)]).toEqual([true, false, false]);
    });
});
