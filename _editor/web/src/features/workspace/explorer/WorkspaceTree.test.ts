// @vitest-environment jsdom
// jsdom: the subject is what the explorer renders after a reload (open folders restored, revealed
// file), not just composable state.
import type { WorkspaceTreeEntry } from "@intentic/api-contract";
import { VueQueryPlugin } from "@tanstack/vue-query";
import type { RowAction } from "./rowActions";
import type { OpenMode } from "../tabs/workspaceTabs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type App, createApp, h, nextTick, ref } from "vue";
import { IconStub } from "@intentic/ui/testing";

// jsdom implements no scrollIntoView; spied rather than stubbed so calls can be inspected.
const scrolled = vi.hoisted(() => {
    const calls: string[] = [];
    return calls;
});
globalThis.Element.prototype.scrollIntoView = function scrollIntoView(this: Element): void {
    scrolled.push(this.textContent?.trim() ?? ``);
};

// Set before the imports below: useSandbox reads storage at import time and keys open folders by it.
const SANDBOX = `sb1`;
localStorage.setItem(`intentic.activeSandboxId`, SANDBOX);

// Records calls instead of hitting the network (no sandbox is registered in tests); every call answers ok.
const daemon = vi.hoisted(() => ({ calls: [] as { path: string; init?: RequestInit }[] }));
vi.mock("../../sandbox/client/sandboxClient", async (importOriginal) => {
    const original = await importOriginal<typeof import("../../sandbox/client/sandboxClient")>();
    return {
        ...original,
        sandboxJson: async (path: string, init?: RequestInit): Promise<unknown> => {
            daemon.calls.push({ path, init });
            return { ok: true };
        },
    };
});

const { default: WorkspaceTree } = await import("./WorkspaceTree.vue");
const { resetWorkspaceTreeState } = await import("./useWorkspaceTree");
const { queryClient } = await import("../../../lib/queryPersistence");
const { useLayout } = await import("../../../shell/window/useLayout");
const { useNotifications } = await import("../../../shell/notifications/notifications");

const layout = useLayout();

const dir = (path: string, children: WorkspaceTreeEntry[]): WorkspaceTreeEntry => ({
    name: path.slice(path.lastIndexOf(`/`) + 1),
    path,
    type: `dir`,
    children,
});
const file = (path: string): WorkspaceTreeEntry => ({ name: path.slice(path.lastIndexOf(`/`) + 1), path, type: `file` });

// Deep enough that a collapsed root hides the interesting file two levels down.
const TREE: WorkspaceTreeEntry[] = [dir(`src`, [dir(`src/api`, [file(`src/api/routes.ts`)]), file(`src/main.ts`)]), file(`README.md`)];
// Adds a root junk dir (listed, never descended) and a gitignored file beside its source, both marked ignored.
const IGNORED_TREE: WorkspaceTreeEntry[] = [
    dir(`src`, [file(`src/main.ts`), { ...file(`src/main.js`), ignored: true }]),
    { name: `dist`, path: `dist`, type: `dir`, ignored: true },
    file(`README.md`),
];
// Adds a spec beside its source and a folder of specs, as a real package would have.
const TEST_TREE: WorkspaceTreeEntry[] = [
    dir(`src`, [file(`src/main.ts`), file(`src/main.test.ts`), dir(`src/__tests__`, [file(`src/__tests__/fixture.ts`)])]),
    file(`README.md`),
];

let app: App | undefined;

// Tooltip recorded, not stubbed: on a link row it's the whole affordance the test needs to read.
const recordTooltip = {
    mounted(el: HTMLElement, binding: { value?: unknown }): void {
        if (binding.value !== undefined) {
            el.setAttribute(`data-tooltip`, String(binding.value));
        }
    },
};

// Rebuilds the module-level open-folder set from storage, as a page load or sandbox switch would.
const restoreFrom = (expanded: readonly string[]): void => {
    sessionStorage.setItem(`intentic.workspaceTree.${SANDBOX}`, JSON.stringify(expanded));
    resetWorkspaceTreeState();
};

const mount = async (props: {
    tree: WorkspaceTreeEntry[];
    // Every folder holding only empty folders (daemon's `barren`); separate from tree, which has an entry budget.
    barren?: readonly string[];
    selectedPath?: string;
    rowActions?: (dir: string) => readonly RowAction[];
    onOpenFile?: (path: string, mode: OpenMode) => void;
}): Promise<HTMLElement> => {
    const el = document.createElement(`div`);
    document.body.append(el);
    app = createApp({ render: () => h(WorkspaceTree, props) });
    // Registered app-wide by installUi in the real page.
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, recordTooltip);
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
    // useLayout is a module singleton: reset both filters after each test.
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

    it(`digs out the open file and brings its row on screen`, async () => {
        const el = await mount({ tree: TREE, selectedPath: `src/api/routes.ts` });

        expect(rows(el)).toEqual([`src`, `api`, `routes.ts`, `main.ts`, `README.md`]);
        expect(scrolled).toEqual([`routes.ts`]);
    });

    it(`leaves a folder the user collapsed closed when the tree refetches`, async () => {
        const tree = ref(TREE);
        const el = document.createElement(`div`);
        document.body.append(el);
        app = createApp({ render: () => h(WorkspaceTree, { tree: tree.value, selectedPath: `src/api/routes.ts` }) });
        app.component(`Icon`, IconStub);
        app.directive(`tooltip`, recordTooltip);
        app.use(VueQueryPlugin, { queryClient });
        app.mount(el);
        await nextTick();
        await nextTick();

        expect(rows(el)).toEqual([`src`, `api`, `routes.ts`, `main.ts`, `README.md`]);
        (el.querySelector(`[role="treeitem"]`) as HTMLElement).click();
        await nextTick();
        expect(rows(el)).toEqual([`src`, `README.md`]);

        tree.value = [...TREE]; // the watcher's refetch: same content, new identity
        await nextTick();
        await nextTick();

        expect(rows(el)).toEqual([`src`, `README.md`]);
    });
});

// Ignored entries stay out by default; the toolbar's toggle shows them at every level (root junk dir
// and a gitignored file beside its source).
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

// jsdom has no pointer/hover; the subject is the resting class each icon renders with.
describe(`a row's icons at rest`, () => {
    const ACTIONS = (name: string): readonly RowAction[] =>
        name === `src`
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

    it(`shows all of them on the selected row`, async () => {
        const el = await mount({ tree: TREE, rowActions: ACTIONS });

        (el.querySelector(`[role="treeitem"]`) as HTMLElement).click();
        await nextTick();
        const row = el.querySelector(`[role="treeitem"]`) as HTMLElement;
        expect(row.querySelector(`[data-icon="question-circle"]`)?.className).toContain(`opacity-100`);
        expect(row.querySelector(`[data-icon="wave-pulse"]`)?.className).toContain(`opacity-100`);
    });
});

// Filters out tests regardless of .gitignore (a spec beside its source, and its test folder).
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

// Sandbox keeps some files private (capability sign-ins, provider homes); they're listed but reads
// are refused, so locked rows say so before being clicked.
describe(`the rows the sandbox keeps to itself`, () => {
    const LOCKED_TREE: WorkspaceTreeEntry[] = [
        dir(`.intentic`, [
            file(`.intentic/config/capabilities.json`),
            file(`.intentic/config/settings.json`),
            { name: `auth`, path: `.intentic/secrets/auth`, type: `dir` },
        ]),
        file(`README.md`),
    ];

    it(`wears a padlock, and leaves the state dir's ordinary files as themselves`, async () => {
        restoreFrom([`.intentic`]);

        const el = await mount({ tree: LOCKED_TREE });

        const iconOf = (name: string): string | undefined =>
            [...el.querySelectorAll(`[role="treeitem"]`)]
                .find((row) => row.textContent?.trim() === name)
                ?.querySelector(`[data-icon]:not([data-icon^="chevron"])`)
                ?.getAttribute(`data-icon`) ?? undefined;
        expect(iconOf(`capabilities.json`)).toBe(`lock`);
        expect(iconOf(`auth`)).toBe(`lock`);
        expect(iconOf(`settings.json`)).not.toBe(`lock`);
    });

    it(`opens a locked folder's explanation rather than expanding into nothing`, async () => {
        restoreFrom([`.intentic`]);
        const opened: string[] = [];

        const el = await mount({ tree: LOCKED_TREE, onOpenFile: (path: string) => opened.push(path) });
        const authRow = [...el.querySelectorAll(`[role="treeitem"]`)].find((row) => row.textContent?.trim() === `auth`) as HTMLElement;
        authRow.click();
        await nextTick();

        expect(opened).toEqual([`.intentic/secrets/auth`]);
        expect(rows(el)).toEqual([`.intentic`, `capabilities.json`, `settings.json`, `auth`, `README.md`]);
    });
});

// Click reports as a peek (the strip's one transient slot, replaced by the next peek); double-click
// reports as keep.
describe(`peeking at a file versus keeping it`, () => {
    const openedBy = async (act: (row: HTMLElement) => void): Promise<[string, OpenMode][]> => {
        const opened: [string, OpenMode][] = [];
        restoreFrom([`src`]);
        const el = await mount({ tree: TREE, onOpenFile: (path: string, mode: OpenMode) => opened.push([path, mode]) });
        act([...el.querySelectorAll(`[role="treeitem"]`)].find((row) => row.textContent?.trim() === `main.ts`) as HTMLElement);
        await nextTick();
        return opened;
    };

    it(`opens a clicked file as a peek`, async () => {
        expect(await openedBy((row) => row.click())).toEqual([[`src/main.ts`, `preview`]]);
    });

    // Browser fires click before dblclick; both arrive, the second is what keeps the tab.
    it(`keeps a double-clicked file`, async () => {
        const opened = await openedBy((row) => {
            row.click();
            row.dispatchEvent(new MouseEvent(`dblclick`, { bubbles: true }));
        });

        expect(opened).toEqual([
            [`src/main.ts`, `preview`],
            [`src/main.ts`, `keep`],
        ]);
    });

    // Click simulates focus; Enter then opens the focused row, as arrow-key navigation would.
    it(`opens the focused file as a peek on Enter`, async () => {
        const opened = await openedBy((row) => {
            row.click();
            row.dispatchEvent(new KeyboardEvent(`keydown`, { key: `Enter`, bubbles: true }));
        });

        expect(opened).toEqual([
            [`src/main.ts`, `preview`],
            [`src/main.ts`, `preview`],
        ]);
    });
});

// Nothing shows until the settle window passes; a barren chain then reads as one dimmed, named row
// that deletes without confirming and undoes cleanly. Timers are faked: the window is the behavior under test.
describe(`empty folders (barren branches)`, () => {
    // web/demo/assets nested three deep: one piece of junk, not three separate ones.
    const BARREN_TREE: WorkspaceTreeEntry[] = [
        dir(`web`, [dir(`web/demo`, [dir(`web/demo/assets`, [])])]),
        dir(`src`, [file(`src/main.ts`)]),
        file(`README.md`),
    ];
    // Daemon's barren list for BARREN_TREE: the full chain, in tree order.
    const BARREN = [`web`, `web/demo`, `web/demo/assets`];
    // Second barren branch sits under a folder with real content, unlike the root-level first one.
    const TWO_BARREN_TREE: WorkspaceTreeEntry[] = [
        dir(`web`, [dir(`web/demo`, [dir(`web/demo/assets`, [])])]),
        dir(`src`, [file(`src/main.ts`), dir(`src/old`, [])]),
        file(`README.md`),
    ];
    const TWO_BARREN = [...BARREN, `src/old`];

    // The sweep line's controls, by the words on them.
    const button = (el: HTMLElement, label: string): HTMLElement =>
        [...el.querySelectorAll(`button`)].find((candidate) => candidate.textContent?.trim() === label) as HTMLElement;
    // Each entry as its two lines (branch, then location): a 16rem column truncates from the right,
    // exactly where the folder name would sit.
    const entries = (el: HTMLElement): { name: string; where: string }[] =>
        [...el.querySelectorAll(`li`)].map((row) => {
            const [name, where] = [...row.querySelectorAll(`span`)].map((span) => span.textContent?.trim() ?? ``);
            return { name: name ?? ``, where: where ?? `` };
        });
    // Button that reveals a named branch: the entry's first button whose name matches.
    const entryNamed = (el: HTMLElement, name: string): HTMLElement =>
        [...el.querySelectorAll(`li`)].find((row) => row.querySelector(`span`)?.textContent?.trim() === name)?.querySelector(`button`) as HTMLElement;
    const settle = async (): Promise<void> => {
        await vi.advanceTimersByTimeAsync(10_100);
        await nextTick();
    };

    beforeEach(() => {
        vi.useFakeTimers();
        daemon.calls.length = 0;
    });
    afterEach(() => {
        vi.useRealTimers();
        useNotifications().dismissReceipt();
    });

    it(`stays quiet through the settle window, then collapses the chain into one dimmed row and names it`, async () => {
        const el = await mount({ tree: BARREN_TREE, barren: BARREN });

        expect(rows(el)).toEqual([`web`, `src`, `README.md`]);
        expect(el.textContent).not.toContain(`is empty`);

        await settle();

        expect(rows(el)).toEqual([`web / demo / assets`, `src`, `README.md`]);
        const label = [...el.querySelectorAll(`[role="treeitem"] span`)].find((span) => span.textContent?.includes(`web / demo`));
        expect(label?.className).toContain(`text-subtle`);
        expect(el.textContent).toContain(`web / demo / assets`);
        expect(el.textContent).toMatch(/empty/i);
        const chainRow = [...el.querySelectorAll(`[role="treeitem"]`)].find((row) => row.textContent?.includes(`web / demo`));
        expect(chainRow?.querySelector(`[data-icon^="chevron"]`)).toBeNull();
    });

    it(`folds several branches into a count that opens into their names`, async () => {
        const el = await mount({ tree: TWO_BARREN_TREE, barren: TWO_BARREN });
        await settle();

        expect(el.textContent).toContain(`2 empty folders`);
        expect(entries(el)).toEqual([]);

        button(el, `2 empty folders`).click();
        await nextTick();

        // Entries carry location because the list has no indentation to imply it; a root-level branch has none.
        expect(entries(el)).toEqual([
            { name: `web / demo / assets`, where: `` },
            { name: `old`, where: `src` },
        ]);
    });

    it(`opens the way down to a named folder and selects it`, async () => {
        const el = await mount({ tree: TWO_BARREN_TREE, barren: TWO_BARREN });
        await settle();
        button(el, `2 empty folders`).click();
        await nextTick();
        scrolled.length = 0;

        entryNamed(el, `old`).click();
        await nextTick();
        await nextTick();

        expect(rows(el)).toEqual([`web / demo / assets`, `src`, `main.ts`, `old`, `README.md`]);
        const revealed = [...el.querySelectorAll(`[role="treeitem"]`)].find((row) => row.textContent?.trim() === `old`);
        expect(revealed?.getAttribute(`aria-selected`)).toBe(`true`);
        expect(scrolled).toContain(`old`);
    });

    it(`keeps one named folder instead of sweeping them all`, async () => {
        const el = await mount({ tree: TWO_BARREN_TREE, barren: TWO_BARREN });
        await settle();
        button(el, `2 empty folders`).click();
        await nextTick();

        // Keep button targets the chain's deepest folder.
        const keep = [...el.querySelectorAll(`li`)]
            .find((row) => row.querySelector(`span`)?.textContent?.trim() === `web / demo / assets`)
            ?.querySelector(`button:last-of-type`) as HTMLElement;
        keep.click();
        await vi.advanceTimersByTimeAsync(1);

        const uploads = daemon.calls.filter((call) => call.path.startsWith(`/workspace/upload`));
        expect(uploads.length).toBe(1);
        expect(decodeURIComponent(uploads[0]?.path ?? ``)).toContain(`web/demo/assets/.gitkeep`);
        expect(daemon.calls.some((call) => call.init?.method === `DELETE`)).toBe(false);
    });

    it(`sweeps from the line without a dialog, and the receipt names what went`, async () => {
        const el = await mount({ tree: BARREN_TREE, barren: BARREN });
        await settle();

        button(el, `Clean up`).click();
        await vi.advanceTimersByTimeAsync(1);

        expect(document.body.textContent).not.toContain(`Delete folder?`);
        const deletes = daemon.calls.filter((call) => call.init?.method === `DELETE`);
        expect(deletes.length).toBe(1);
        expect(String(deletes[0]?.init?.body)).toContain(`"web"`);
        const { receipt } = useNotifications();
        expect(receipt.value?.title).toContain(`web / demo / assets`);
        expect(receipt.value?.title).toMatch(/removed/i);

        // Undo recreates the deepest folder via a recursive create.
        await receipt.value?.actions?.[0]?.run();
        const creates = daemon.calls.filter((call) => call.path === `/workspace/dir`);
        expect(creates.length).toBe(1);
        expect(String(creates[0]?.init?.body)).toContain(`web/demo/assets`);
    });

    it(`says where a buried folder is, on the line and on the receipt`, async () => {
        const el = await mount({ tree: [dir(`src`, [file(`src/main.ts`), dir(`src/old`, [])]), file(`README.md`)], barren: [`src/old`] });
        await settle();

        const sole = [...el.querySelectorAll(`span`)].filter((span) => span.className.includes(`block truncate`));
        expect(sole.map((span) => span.textContent?.trim())).toEqual([`old is empty`, `src`]);

        button(el, `Clean up`).click();
        await vi.advanceTimersByTimeAsync(1);

        // Receipt has no room to shade name and location separately, so it spells the whole path.
        expect(useNotifications().receipt.value?.title).toBe(`src / old removed`);
    });

    it(`keeps the count in the receipt when several branches go at once`, async () => {
        const el = await mount({ tree: TWO_BARREN_TREE, barren: TWO_BARREN });
        await settle();

        button(el, `Clean up`).click();
        await vi.advanceTimersByTimeAsync(1);

        // Receipt only counts; naming happens on the sweep line before the click.
        expect(useNotifications().receipt.value?.title).toContain(`2`);
        expect(useNotifications().receipt.value?.title).toMatch(/removed/i);
        expect(daemon.calls.filter((call) => call.init?.method === `DELETE`).length).toBe(2);
    });

    it(`skips the confirm dialog when the Delete key lands on a barren-only selection`, async () => {
        const el = await mount({ tree: BARREN_TREE, barren: BARREN });
        await settle();

        const chainRow = [...el.querySelectorAll(`[role="treeitem"]`)].find((row) => row.textContent?.includes(`web / demo`)) as HTMLElement;
        chainRow.click();
        await nextTick();
        chainRow.dispatchEvent(new KeyboardEvent(`keydown`, { key: `Delete`, bubbles: true }));
        await vi.advanceTimersByTimeAsync(1);

        expect(document.body.textContent).not.toContain(`Delete folder?`);
        expect(useNotifications().receipt.value?.title).toContain(`web / demo / assets`);
    });
});

// A symlink lists as what it points at: the target's icon, expands if the target is a folder, with
// a marker showing where it points.
describe(`symlink rows`, () => {
    const link = (path: string, to: string, state?: `broken` | `outside`): WorkspaceTreeEntry => ({
        ...(state === `broken` ? file(path) : dir(path, [file(`${path}/SKILL.md`)])),
        link: { to, ...(state !== undefined ? { state } : {}) },
    });
    const LINK_TREE: WorkspaceTreeEntry[] = [
        dir(`.claude`, [
            dir(`.claude/skills`, [
                link(`.claude/skills/github`, `../../.agents/skills/github`),
                link(`.claude/skills/gone`, `../../.agents/skills/gone`, `broken`),
                link(`.claude/skills/away`, `/etc`, `outside`),
            ]),
        ]),
        file(`README.md`),
    ];
    const markerOf = (el: HTMLElement, name: string): Element | undefined =>
        [...el.querySelectorAll(`[role="treeitem"]`)]
            .find((row) => row.textContent?.trim().startsWith(name))
            ?.querySelector(`[data-icon="link"], [data-icon="link-broken"]`) ?? undefined;

    it(`marks a link and says where it points`, async () => {
        // Link folder starts open so a followed link's contents are on screen.
        restoreFrom([`.claude`, `.claude/skills`, `.claude/skills/github`]);
        const el = await mount({ tree: LINK_TREE });

        expect(markerOf(el, `github`)?.getAttribute(`data-icon`)).toBe(`link`);
        expect(markerOf(el, `github`)?.getAttribute(`data-tooltip`)).toBe(`Link to ../../.agents/skills/github`);
        // Otherwise a working link behaves like an ordinary row: it expands and lists its contents.
        expect(rows(el)).toContain(`SKILL.md`);
        expect(markerOf(el, `README.md`)).toBeUndefined();
    });

    it(`names the two refusals rather than just doing nothing`, async () => {
        restoreFrom([`.claude`, `.claude/skills`]);
        const el = await mount({ tree: LINK_TREE });

        expect(markerOf(el, `gone`)?.getAttribute(`data-icon`)).toBe(`link-broken`);
        expect(markerOf(el, `gone`)?.getAttribute(`data-tooltip`)).toBe(`Link to ../../.agents/skills/gone: there is nothing there`);
        expect(markerOf(el, `away`)?.getAttribute(`data-tooltip`)).toBe(`Link to /etc: outside the workspace, so the sandbox won't open it`);
    });

    it(`offers no chevron on a link with nothing reachable behind it`, async () => {
        restoreFrom([`.claude`, `.claude/skills`]);
        const el = await mount({ tree: LINK_TREE });

        const chevronOf = (name: string): boolean =>
            [...el.querySelectorAll(`[role="treeitem"]`)]
                .find((row) => row.textContent?.trim().startsWith(name))
                ?.querySelector(`[data-icon^="chevron"]`) !== null;
        expect(chevronOf(`github`)).toBe(true);
        // An outside-workspace link resolves to a directory the daemon refuses to list, so it gets no chevron.
        expect(chevronOf(`away`)).toBe(false);
    });
});

// Dropping onto a file targets the folder that holds it (same rule as New File, paste, the keyboard
// axis); onto a folder means inside it.
describe(`where a drop on a row lands`, () => {
    const DROP_TREE: WorkspaceTreeEntry[] = [
        dir(`src`, [dir(`src/api`, [file(`src/api/routes.ts`)]), file(`src/main.ts`), file(`src/util.ts`)]),
        file(`README.md`),
    ];
    const rowNamed = (el: HTMLElement, name: string): HTMLElement =>
        [...el.querySelectorAll(`[role="treeitem"]`)].find((row) => row.textContent?.trim() === name) as HTMLElement;
    // jsdom has neither DragEvent nor DataTransfer; the stub carries just types and getData. Tests an
    // internal row move since it lands as a readable daemon call.
    const dropOn = async (row: HTMLElement, dragged: string, types: string[] = [`application/x-intentic-path`]): Promise<void> => {
        const event = new Event(`drop`, { bubbles: true, cancelable: true });
        Object.defineProperty(event, `dataTransfer`, {
            value: { types, getData: (type: string): string => (type === `application/x-intentic-path` ? dragged : ``) },
        });
        row.dispatchEvent(event);
        // Drains two microtask ticks to settle both a move and a no-op silently, not as a slow call.
        for (let tick = 0; tick < 2; tick += 1) {
            await new Promise((resolve) => setTimeout(resolve, 0));
            await nextTick();
        }
    };
    const moves = (): unknown[] => daemon.calls.filter((call) => call.path === `/workspace/move`).map((call) => JSON.parse(String(call.init?.body)));

    beforeEach(() => {
        daemon.calls.length = 0;
    });

    it(`puts what was dropped on a file into the folder that holds that file`, async () => {
        restoreFrom([`src`, `src/api`]);
        const el = await mount({ tree: DROP_TREE });

        await dropOn(rowNamed(el, `routes.ts`), `README.md`);

        expect(moves()).toEqual([{ from: `README.md`, to: `src/api/README.md` }]);
    });

    it(`still puts what was dropped on a folder inside that folder`, async () => {
        restoreFrom([`src`]);
        const el = await mount({ tree: DROP_TREE });

        await dropOn(rowNamed(el, `api`), `README.md`);

        expect(moves()).toEqual([{ from: `README.md`, to: `src/api/README.md` }]);
    });

    it(`asks the daemon for nothing when the file aimed at is already a neighbour`, async () => {
        restoreFrom([`src`]);
        const el = await mount({ tree: DROP_TREE });

        await dropOn(rowNamed(el, `util.ts`), `src/main.ts`);

        expect(moves()).toEqual([]);
    });

    // Browsers make images and links drag sources too; rows must refuse types other than the internal one.
    it(`refuses a drag carrying neither files nor rows`, async () => {
        restoreFrom([`src`]);
        const el = await mount({ tree: DROP_TREE });

        await dropOn(rowNamed(el, `util.ts`), ``, [`text/uri-list`]);

        expect(daemon.calls).toEqual([]);
    });
});
