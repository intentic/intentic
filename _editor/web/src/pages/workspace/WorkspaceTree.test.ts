// @vitest-environment jsdom
//
// jsdom because the subject is what the explorer SHOWS after a reload. Both behaviours here are invisible to a
// test on the composable: that the folders the last visit left open come back open, and that the file the
// workspace restores is dug out from under whatever folders happen to contain it. Before this, a refresh landed
// on a fully collapsed tree with the open file nowhere in it — every step of navigation the user had made,
// gone, on a view whose whole job is telling them where they are.
import type { WorkspaceTreeEntry } from "@intentic-app/api-contract";
import { VueQueryPlugin } from "@tanstack/vue-query";
import type { RowAction } from "./rowActions";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type App, createApp, defineComponent, h, nextTick, ref } from "vue";

// The component's import chain pulls in app-wide singletons that read browser globals at import time, and
// jsdom implements no scrolling at all — which is the reveal's other half, so it is a spy rather than a stub.
const scrolled = vi.hoisted(() => {
    const calls: string[] = [];
    globalThis.ResizeObserver ??= class {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
    };
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
    };
    return calls;
});
globalThis.Element.prototype.scrollIntoView = function scrollIntoView(this: Element): void {
    scrolled.push(this.textContent?.trim() ?? ``);
};

// Which sandbox is active is read from storage when useSandbox loads, so it is set BEFORE the imports below —
// the tree's open folders are keyed by it.
const SANDBOX = `sb1`;
localStorage.setItem(`intentic.activeSandboxId`, SANDBOX);

const { default: WorkspaceTree } = await import("./WorkspaceTree.vue");
const { resetWorkspaceTreeState } = await import("../../composables/workspace/useWorkspaceTree");
const { queryClient } = await import("../../composables/queryPersistence");
const { useLayout } = await import("../../composables/useLayout");

const layout = useLayout();

const dir = (path: string, children: WorkspaceTreeEntry[]): WorkspaceTreeEntry => ({
    name: path.slice(path.lastIndexOf(`/`) + 1),
    path,
    type: `dir`,
    children,
});
const file = (path: string): WorkspaceTreeEntry => ({ name: path.slice(path.lastIndexOf(`/`) + 1), path, type: `file` });

// A tree deep enough that a collapsed root hides the interesting file two levels down.
const TREE: WorkspaceTreeEntry[] = [dir(`src`, [dir(`src/api`, [file(`src/api/routes.ts`)]), file(`src/main.ts`)]), file(`README.md`)];
// The same shape with what the daemon marks `ignored` in it — a junk dir at the root (listed, never descended)
// and a .gitignore'd build artifact sitting next to its source.
const IGNORED_TREE: WorkspaceTreeEntry[] = [
    dir(`src`, [file(`src/main.ts`), { ...file(`src/main.js`), ignored: true }]),
    { name: `dist`, path: `dist`, type: `dir`, ignored: true },
    file(`README.md`),
];
// The same shape as the tests a package actually carries: a spec beside its source, and a folder of them.
const TEST_TREE: WorkspaceTreeEntry[] = [
    dir(`src`, [file(`src/main.ts`), file(`src/main.test.ts`), dir(`src/__tests__`, [file(`src/__tests__/fixture.ts`)])]),
    file(`README.md`),
];

let app: App | undefined;

// Rebuild the module-level open-folder set from storage — what a page load does, and what a sandbox switch does.
const restoreFrom = (expanded: readonly string[]): void => {
    sessionStorage.setItem(`intentic.workspaceTree.${SANDBOX}`, JSON.stringify(expanded));
    resetWorkspaceTreeState();
};

const mount = async (props: {
    tree: WorkspaceTreeEntry[];
    selectedPath?: string;
    rowActions?: (dir: string) => readonly RowAction[];
}): Promise<HTMLElement> => {
    const el = document.createElement(`div`);
    document.body.append(el);
    app = createApp({ render: () => h(WorkspaceTree, props) });
    // Registered app-wide by installUi in the real page.
    app.component(
        `Icon`,
        defineComponent({
            props: { name: String, spin: Boolean },
            render() {
                return h(`i`, { "data-icon": this.name });
            },
        }),
    );
    app.directive(`tooltip`, {});
    app.use(VueQueryPlugin, { queryClient });
    app.mount(el);
    await nextTick();
    await nextTick();
    return el;
};

// The rows, by the path each one names.
const rows = (el: HTMLElement): string[] => [...el.querySelectorAll(`[role="treeitem"]`)].map((row) => row.textContent?.trim() ?? ``);

beforeEach(() => {
    scrolled.length = 0;
    sessionStorage.clear();
    restoreFrom([]);
});

afterEach(() => {
    app?.unmount();
    app = undefined;
    // useLayout is a module-level singleton — put both filter switches back to their defaults for the next test.
    if (layout.showIgnored.value) {
        layout.toggleShowIgnored();
    }
    if (layout.hideTests.value) {
        layout.toggleHideTests();
    }
});

describe(`the explorer after a reload`, () => {
    it(`opens the folders the last visit left open`, async () => {
        restoreFrom([`src`]);

        const el = await mount({ tree: TREE });

        expect(rows(el)).toEqual([`src`, `api`, `main.ts`, `README.md`]);
    });

    it(`starts collapsed when the window has never opened this sandbox`, async () => {
        const el = await mount({ tree: TREE });

        expect(rows(el)).toEqual([`src`, `README.md`]);
    });

    // The restored tab points at a file, and nothing about the URL that carried it says which folders hold it.
    it(`digs out the open file and brings its row on screen`, async () => {
        const el = await mount({ tree: TREE, selectedPath: `src/api/routes.ts` });

        expect(rows(el)).toEqual([`src`, `api`, `routes.ts`, `main.ts`, `README.md`]);
        expect(scrolled).toEqual([`routes.ts`]);
    });

    // The daemon's file watcher refetches the tree on every agent write. A reveal that re-ran there would keep
    // re-opening a folder the user had just closed, under their cursor.
    it(`leaves a folder the user collapsed closed when the tree refetches`, async () => {
        const tree = ref(TREE);
        const el = document.createElement(`div`);
        document.body.append(el);
        app = createApp({ render: () => h(WorkspaceTree, { tree: tree.value, selectedPath: `src/api/routes.ts` }) });
        app.component(`Icon`, defineComponent({ props: { name: String, spin: Boolean }, render: () => h(`i`) }));
        app.directive(`tooltip`, {});
        app.use(VueQueryPlugin, { queryClient });
        app.mount(el);
        await nextTick();
        await nextTick();

        expect(rows(el)).toEqual([`src`, `api`, `routes.ts`, `main.ts`, `README.md`]); // revealed on mount
        (el.querySelector(`[role="treeitem"]`) as HTMLElement).click(); // collapse src
        await nextTick();
        expect(rows(el)).toEqual([`src`, `README.md`]);

        tree.value = [...TREE]; // the watcher's refetch: same content, new identity
        await nextTick();
        await nextTick();

        expect(rows(el)).toEqual([`src`, `README.md`]);
    });
});

// The explorer is the project by default, so ignored entries stay out of it; the toolbar's Ignored toggle is the
// way in for someone who wants to see what the agent also sees. Both directions have to reach every level — a
// root junk dir and a .gitignore'd artifact buried beside its source are both what makes the tree noisy.
describe(`the ignored-entry toggle`, () => {
    it(`leaves ignored entries out at every level by default`, async () => {
        restoreFrom([`src`]);

        const el = await mount({ tree: IGNORED_TREE });

        expect(rows(el)).toEqual([`src`, `main.ts`, `README.md`]);
    });

    it(`lists them once it is on`, async () => {
        restoreFrom([`src`]);
        layout.toggleShowIgnored();

        const el = await mount({ tree: IGNORED_TREE });

        expect(rows(el)).toEqual([`src`, `main.ts`, `main.js`, `dist`, `README.md`]);
    });
});

/* WHAT A ROW SHOWS WHILE THE POINTER IS SOMEWHERE ELSE. jsdom has no pointer, and hover is a CSS variant, so the
 * subject is the resting class each icon is rendered with — which is the whole of the behaviour anyway: a
 * documented directory that only reveals its page under the mouse is indistinguishable from an undocumented one,
 * and that is exactly what made per-package documentation invisible in a fifty-five package monorepo. */
describe(`a row's icons at rest`, () => {
    const ACTIONS = (dir: string): readonly RowAction[] =>
        dir === `src`
            ? [
                  { id: `document:acme.docs:architecture`, icon: `question-circle`, tooltip: `What src is`, standing: true, run: () => {} },
                  { id: `health`, icon: `wave-pulse`, tooltip: `Open codebase health`, standing: false, run: () => {} },
              ]
            : [];

    it(`keeps a document on screen and leaves the repo's affordances for the hover`, async () => {
        const el = await mount({ tree: TREE, rowActions: ACTIONS });

        const row = el.querySelector(`[role="treeitem"]`) as HTMLElement;
        expect(row.querySelector(`[data-icon="question-circle"]`)?.className).toContain(`opacity-40`);
        expect(row.querySelector(`[data-icon="wave-pulse"]`)?.className).toContain(`pointer-events-none opacity-0`);
    });

    // Every icon comes up to full on the row the user is on, standing or not — the same rule the hover follows.
    it(`shows all of them on the selected row`, async () => {
        const el = await mount({ tree: TREE, rowActions: ACTIONS });

        (el.querySelector(`[role="treeitem"]`) as HTMLElement).click(); // selects src
        await nextTick();
        const row = el.querySelector(`[role="treeitem"]`) as HTMLElement;
        expect(row.querySelector(`[data-icon="question-circle"]`)?.className).toContain(`opacity-100`);
        expect(row.querySelector(`[data-icon="wave-pulse"]`)?.className).toContain(`opacity-100`);
    });
});

// The toolbar's other filter, and the one that takes out files nothing ignores: a spec beside its source and the
// folder of them next door are both what makes a package read as twice the code it is.
describe(`the hide-tests toggle`, () => {
    it(`lists tests by default`, async () => {
        restoreFrom([`src`]);

        const el = await mount({ tree: TEST_TREE });

        expect(rows(el)).toEqual([`src`, `main.ts`, `main.test.ts`, `__tests__`, `README.md`]);
    });

    it(`takes the spec and its folder out once it is on`, async () => {
        restoreFrom([`src`]);
        layout.toggleHideTests();

        const el = await mount({ tree: TEST_TREE });

        expect(rows(el)).toEqual([`src`, `main.ts`, `README.md`]);
    });
});
