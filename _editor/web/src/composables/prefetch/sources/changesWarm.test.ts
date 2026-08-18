// @vitest-environment jsdom
//
// jsdom because the subject is the real wish list, and reaching it pulls the review's own query builders in —
// which pull the app-wide singletons that read browser globals at import time (storageRule.test.ts says the same).
import { afterEach, describe, expect, it, vi } from "vitest";
import { ref } from "vue";

/* WHERE THE WORKSPACE REVIEW SITS IN THE PLAN — pinned because getting it wrong is invisible until the one moment
 * it matters, and then it is the whole product's slowest screen.
 *
 * This review is emptied on a schedule the user does not control: a turn ending invalidates the change list and
 * every diff filed under it at once (useChanges). So "how soon is it read back" is decided entirely by its band,
 * and the failure it guards against is silent — the panel still works, it just opens cold with git's counts, which
 * is exactly what the reading-ahead exists to prevent. It sat in `work` once, behind the whole agents board, which
 * meant a turn ending on the board emptied this and then re-read it last. */

vi.hoisted(() => {
    globalThis.matchMedia ??= ((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
    })) as unknown as typeof globalThis.matchMedia;
    globalThis.window.env ??= {
        production: false,
        api: { url: `http://localhost` },
        auth: { googleClientId: `` },
        analytics: { posthogKey: ``, posthogHost: `` },
        afterSignOut: ``,
    };
});

const route = ref<{ name: string }>({ name: `workspace` });
const sidebarPanel = ref(`changes`);
const sidebarCollapsed = ref(false);

vi.mock(`../../../router`, () => ({ router: { currentRoute: route } }));
vi.mock(`../../useLayout`, () => ({ useLayout: () => ({ sidebarPanel, sidebarCollapsed }) }));

const { queryClient } = await import(`../../queryPersistence`);
const { changesKey } = await import(`../../workspace/useChanges`);
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
        // Nothing else yet: the rows are read from the list, and it has not landed.
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
        // `work` is the band the board's own likely-next reviews sit in, so anything here at `work` or lower is
        // behind them — which is the ordering that had this panel cold every time a turn ended.
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
