import { beforeEach, describe, expect, it } from "vitest";

/* Both halves of "where I was in the workspace" have the same contract: whatever is on disk, what comes back is
 * something the view can actually render — folders that are just paths, tabs that each name a real surface once,
 * and a focus that names one of them. Nothing here is checked against the filesystem (see workspaceSnapshot.ts);
 * a folder that has since been deleted restores as a path that matches no row, which renders as nothing. */

// The node test environment has neither storage.
const store = (name: "localStorage" | "sessionStorage"): Map<string, string> => {
    const entries = new Map<string, string>();
    Object.defineProperty(globalThis, name, {
        configurable: true,
        value: {
            getItem: (key: string) => entries.get(key) ?? null,
            setItem: (key: string, value: string) => void entries.set(key, value),
            removeItem: (key: string) => void entries.delete(key),
            clear: () => entries.clear(),
        },
    });
    return entries;
};
const local = store(`localStorage`);
const session = store(`sessionStorage`);

const { readExpandedDirs, readTabStrip, writeExpandedDirs, writeTabStrip } = await import("./workspaceSnapshot");

const TREE_KEY = `intentic.workspaceTree.sb1`;
const TABS_KEY = `intentic.workspaceTabs.sb1`;

beforeEach(() => {
    local.clear();
    session.clear();
});

describe(`the tree's open folders`, () => {
    it(`prefers this window's own folders over the seed the last window left`, () => {
        local.set(TREE_KEY, JSON.stringify([`packages`]));
        session.set(TREE_KEY, JSON.stringify([`src`, `src/api`]));

        expect(readExpandedDirs(`sb1`)).toEqual([`src`, `src/api`]);
    });

    it(`falls back to the seed for a window that has never opened this sandbox`, () => {
        local.set(TREE_KEY, JSON.stringify([`src`]));

        expect(readExpandedDirs(`sb1`)).toEqual([`src`]);
    });

    it(`has none for an unbound sandbox, an unwritten one, or an unreadable blob`, () => {
        expect(readExpandedDirs(undefined)).toEqual([]);
        expect(readExpandedDirs(`sb1`)).toEqual([]);

        session.set(TREE_KEY, `not json`);
        expect(readExpandedDirs(`sb1`)).toEqual([]);

        session.set(TREE_KEY, JSON.stringify({ expanded: [`src`] }));
        expect(readExpandedDirs(`sb1`)).toEqual([]);
    });

    it(`drops entries that aren't paths and keeps the rest`, () => {
        session.set(TREE_KEY, JSON.stringify([`src`, ``, 42, null, `src/api`]));

        expect(readExpandedDirs(`sb1`)).toEqual([`src`, `src/api`]);
    });

    it(`round-trips through this window's store and the seed both`, () => {
        writeExpandedDirs(`sb1`, [`src`, `src/api`]);

        expect(session.get(TREE_KEY)).toBe(local.get(TREE_KEY));
        expect(readExpandedDirs(`sb1`)).toEqual([`src`, `src/api`]);
    });

    it(`keeps each sandbox's folders to itself`, () => {
        writeExpandedDirs(`sb1`, [`src`]);
        writeExpandedDirs(`sb2`, [`packages`]);

        expect(readExpandedDirs(`sb1`)).toEqual([`src`]);
        expect(readExpandedDirs(`sb2`)).toEqual([`packages`]);
    });

    // The cut keeps ancestors: a dropped leaf costs one folder, a dropped ancestor costs everything under it.
    it(`caps a runaway set at the shallowest paths`, () => {
        const deep = Array.from({ length: 600 }, (_, index) => `a/b/c/deep-${index}`);
        writeExpandedDirs(`sb1`, [...deep, `src`, `src/api`]);

        const restored = readExpandedDirs(`sb1`);
        expect(restored).toHaveLength(500);
        expect(restored.slice(0, 2)).toEqual([`src`, `src/api`]);
    });
});

describe(`the editor's open tabs`, () => {
    const strip = (active: string | null, tabs: Record<string, unknown>[]): string => JSON.stringify({ active, tabs });

    it(`restores every kind that can be reopened from what it names`, () => {
        session.set(
            TABS_KEY,
            strip(`health:web`, [
                { kind: `file`, id: `src/main.ts`, path: `src/main.ts` },
                { kind: `directory`, id: `dir:`, dir: `` },
                { kind: `health`, id: `health:web`, repo: `web` },
                { kind: `plan`, id: `plan:c1`, title: `Ship it`, text: `# Ship it` },
            ]),
        );

        const restored = readTabStrip(`sb1`);
        expect(restored?.active).toBe(`health:web`);
        expect(restored?.tabs).toEqual([
            { kind: `file`, id: `src/main.ts`, path: `src/main.ts` },
            { kind: `directory`, id: `dir:`, dir: `` },
            { kind: `health`, id: `health:web`, repo: `web` },
            { kind: `plan`, id: `plan:c1`, title: `Ship it`, text: `# Ship it` },
        ]);
    });

    // A diff carries both sides of a file as content, and shows a comparison the agent has likely moved past by
    // the next load. It is never written; a blob that somehow holds one drops it rather than restoring it.
    it(`drops a diff tab`, () => {
        session.set(
            TABS_KEY,
            strip(`diff:working:root/src/main.ts`, [
                {
                    kind: `diff`,
                    id: `diff:working:root/src/main.ts`,
                    label: `main.ts`,
                    status: `modified`,
                    path: `src/main.ts`,
                    before: `a`,
                    after: `b`,
                },
                { kind: `file`, id: `src/main.ts`, path: `src/main.ts` },
            ]),
        );

        const restored = readTabStrip(`sb1`);
        expect(restored?.tabs.map((tab) => tab.id)).toEqual([`src/main.ts`]);
        // ...and the focus it held goes with it rather than naming a tab that isn't there.
        expect(restored?.active).toBeNull();
    });

    it(`skips an entry that names nothing reopenable and keeps the rest`, () => {
        session.set(
            TABS_KEY,
            strip(`src/main.ts`, [
                { kind: `file`, id: `no-path` },
                { kind: `health`, id: `health:` },
                { kind: `nonsense`, id: `x` },
                { id: `kindless` },
                { kind: `file`, id: `src/main.ts`, path: `src/main.ts` },
            ]),
        );

        expect(readTabStrip(`sb1`)?.tabs.map((tab) => tab.id)).toEqual([`src/main.ts`]);
    });

    it(`drops an oversized plan rather than restoring half of it`, () => {
        session.set(TABS_KEY, strip(null, [{ kind: `plan`, id: `plan:c1`, title: `Big`, text: `x`.repeat(64_001) }]));

        expect(readTabStrip(`sb1`)).toBeUndefined();
    });

    it(`collapses a tab that appears twice into one`, () => {
        session.set(
            TABS_KEY,
            strip(`src/main.ts`, [
                { kind: `file`, id: `src/main.ts`, path: `src/main.ts` },
                { kind: `file`, id: `src/main.ts`, path: `src/main.ts` },
            ]),
        );

        expect(readTabStrip(`sb1`)?.tabs).toHaveLength(1);
    });

    it(`degrades an unparseable or empty strip to none — a clean workspace, not a broken one`, () => {
        session.set(TABS_KEY, `not json`);
        expect(readTabStrip(`sb1`)).toBeUndefined();

        session.set(TABS_KEY, strip(null, []));
        expect(readTabStrip(`sb1`)).toBeUndefined();

        expect(readTabStrip(undefined)).toBeUndefined();
    });

    it(`round-trips through this window's store and the seed both`, () => {
        writeTabStrip(`sb1`, strip(`src/main.ts`, [{ kind: `file`, id: `src/main.ts`, path: `src/main.ts` }]));

        expect(session.get(TABS_KEY)).toBe(local.get(TABS_KEY));
        expect(readTabStrip(`sb1`)?.active).toBe(`src/main.ts`);
    });
});
