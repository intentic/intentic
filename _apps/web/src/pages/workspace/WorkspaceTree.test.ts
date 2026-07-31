// @vitest-environment jsdom
//
// jsdom because the subject is what the explorer SHOWS after a reload. Both behaviours here are invisible to a
// test on the composable: that the folders the last visit left open come back open, and that the file the
// workspace restores is dug out from under whatever folders happen to contain it. Before this, a refresh landed
// on a fully collapsed tree with the open file nowhere in it — every step of navigation the user had made,
// gone, on a view whose whole job is telling them where they are.
import type { WorkspaceTreeEntry } from "@intentic-app/api-contract";
import { VueQueryPlugin } from "@tanstack/vue-query";
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

let app: App | undefined;

// Rebuild the module-level open-folder set from storage — what a page load does, and what a sandbox switch does.
const restoreFrom = (expanded: readonly string[]): void => {
    sessionStorage.setItem(`intentic.workspaceTree.${SANDBOX}`, JSON.stringify(expanded));
    resetWorkspaceTreeState();
};

const mount = async (props: { tree: WorkspaceTreeEntry[]; selectedPath?: string }): Promise<HTMLElement> => {
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
    // useLayout is a module-level singleton — put the ignored-entry switch back to its default for the next test.
    if (layout.hideIgnored.value) {
        layout.toggleHideIgnored();
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

// The explorer shows "what the LLM sees", so ignored entries are listed (grayed) by default; the toolbar's
// Ignored toggle is the way out for someone reading the project itself. It has to reach every level — a root
// junk dir and a .gitignore'd artifact buried beside its source are both what makes the tree noisy.
describe(`the ignored-entry toggle`, () => {
    it(`lists ignored entries by default`, async () => {
        restoreFrom([`src`]);

        const el = await mount({ tree: IGNORED_TREE });

        expect(rows(el)).toEqual([`src`, `main.ts`, `main.js`, `dist`, `README.md`]);
    });

    it(`drops them at every level once it is on`, async () => {
        restoreFrom([`src`]);
        layout.toggleHideIgnored();

        const el = await mount({ tree: IGNORED_TREE });

        expect(rows(el)).toEqual([`src`, `main.ts`, `README.md`]);
    });
});
