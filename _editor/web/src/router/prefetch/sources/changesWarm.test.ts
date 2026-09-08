// @vitest-environment jsdom
// jsdom: the wish list pulls in query builders that touch browser globals at import.
import { afterEach, describe, expect, it, vi } from "vitest";
import { ref } from "vue";

// The workspace review is invalidated wholesale whenever a turn ends (useChanges); reading ahead is
// what keeps it from opening cold to git's raw counts.

const route = ref<{ name: string }>({ name: `workspace` });
const sidebarPanel = ref(`changes`);
const sidebarCollapsed = ref(false);

vi.mock(`../../../router`, () => ({ router: { currentRoute: route } }));
vi.mock(`../../../shell/window/useLayout`, () => ({ useLayout: () => ({ sidebarPanel, sidebarCollapsed }) }));

const { queryClient } = await import(`../../../lib/queryPersistence`);
const { changesKey } = await import(`../../../features/workspace/changes/useChanges`);
const { changesWarmSource } = await import(`./changesWarm`);

const stand = (name: string, panel = `changes`, collapsed = false): void => {
    route.value = { name };
    sidebarPanel.value = panel;
    sidebarCollapsed.value = collapsed;
};

afterEach(() => {
    queryClient.clear();
    stand(`workspace`);
});

describe(`the workspace review's wish list`, () => {
    it(`asks for the change list before anything can be walked`, () => {
        const [list, ...rest] = changesWarmSource();

        expect(list?.key).toBe(`changes:list`);
        expect(rest).toHaveLength(0);
    });

    it(`reads the list and its rows in one band, so the plan cannot take the rows first`, () => {
        stand(`agents`);
        queryClient.setQueryData(changesKey(), { repos: [{ repo: `root`, conflicted: [], staged: [], unstaged: [{ path: `a.ts` }] }] });

        const [list, row] = changesWarmSource();

        expect(row?.key).toBe(`diff:root:unstaged:a.ts`);
        expect(list?.band).toBe(row?.band);
    });

    it(`is never filed below the agents board, wherever the reader is standing`, () => {
        // `work` is the board's own band; anything at or below it lands behind it.
        for (const name of [`agents`, `agent`, `sandbox`, `extension`]) {
            stand(name);

            expect(changesWarmSource().map((wish) => wish.band)).toEqual([`near`]);
        }
    });

    it(`takes the nearest band of all when the panel is the one on screen`, () => {
        stand(`workspace`, `changes`, false);

        expect(changesWarmSource()[0]?.band).toBe(`now`);
    });

    it(`steps back to one-click-away when the workspace is showing another panel`, () => {
        stand(`workspace`, `files`, false);

        expect(changesWarmSource()[0]?.band).toBe(`near`);
    });

    it(`counts a collapsed sidebar as closed, since the panel is not drawn at all`, () => {
        stand(`workspace`, `changes`, true);

        expect(changesWarmSource()[0]?.band).toBe(`near`);
    });

    it(`skips a repo git could not scan, which has no rows to read`, () => {
        queryClient.setQueryData(changesKey(), {
            repos: [
                { repo: `torn`, error: `not a git repository`, conflicted: [], staged: [], unstaged: [] },
                { repo: `root`, conflicted: [], staged: [{ path: `b.ts` }], unstaged: [] },
            ],
        });

        expect(changesWarmSource().map((wish) => wish.key)).toEqual([`changes:list`, `diff:root:staged:b.ts`]);
    });
});
