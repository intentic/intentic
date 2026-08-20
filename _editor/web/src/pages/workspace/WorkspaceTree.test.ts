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
import type { OpenMode } from "./workspaceTabs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type App, createApp, defineComponent, h, nextTick, ref } from "vue";

// The component's import chain pulls in app-wide singletons that read browser globals at import time, and
// jsdom implements no scrolling at all — which is the reveal's other half, so it is a spy rather than a stub.
const scrolled = vi.hoisted(() => {
    const calls: string[] = [];
    return calls;
});
globalThis.Element.prototype.scrollIntoView = function scrollIntoView(this: Element): void {
    scrolled.push(this.textContent?.trim() ?? ``);
};

// Which sandbox is active is read from storage when useSandbox loads, so it is set BEFORE the imports below —
// the tree's open folders are keyed by it.
const SANDBOX = `sb1`;
localStorage.setItem(`intentic.activeSandboxId`, SANDBOX);

// The daemon, recorded rather than reached: no sandbox is registered in a test, so a real call would die on
// "sandbox isn't reachable" before it ever hit the network. Every op answers ok — the barren-branch tests
// assert WHAT the explorer asked for (the delete, the undo's re-create) and what it showed after.
const daemon = vi.hoisted(() => ({ calls: [] as { path: string; init?: RequestInit }[] }));
vi.mock("../../composables/sandbox/sandboxClient", async (importOriginal) => {
    const original = await importOriginal<typeof import("../../composables/sandbox/sandboxClient")>();
    return {
        ...original,
        sandboxJson: async (path: string, init?: RequestInit): Promise<unknown> => {
            daemon.calls.push({ path, init });
            return { ok: true };
        },
    };
});

const { default: WorkspaceTree } = await import("./WorkspaceTree.vue");
const { resetWorkspaceTreeState } = await import("../../composables/workspace/useWorkspaceTree");
const { queryClient } = await import("../../composables/queryPersistence");
const { useLayout } = await import("../../composables/useLayout");
const { useReceipts } = await import("../../composables/receipts");

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

// The tooltip directive, recorded rather than stubbed away: on a link row the tooltip IS the affordance —
// where it points is the whole reason to look at one — so a test that could not read it would be asserting
// the icon and not the row.
const recordTooltip = {
    mounted(el: HTMLElement, binding: { value?: unknown }): void {
        if (binding.value !== undefined) {
            el.setAttribute(`data-tooltip`, String(binding.value));
        }
    },
};

// Rebuild the module-level open-folder set from storage — what a page load does, and what a sandbox switch does.
const restoreFrom = (expanded: readonly string[]): void => {
    sessionStorage.setItem(`intentic.workspaceTree.${SANDBOX}`, JSON.stringify(expanded));
    resetWorkspaceTreeState();
};

const mount = async (props: {
    tree: WorkspaceTreeEntry[];
    selectedPath?: string;
    rowActions?: (dir: string) => readonly RowAction[];
    onOpenFile?: (path: string, mode: OpenMode) => void;
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
        app.directive(`tooltip`, recordTooltip);
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

/* The sandbox keeps a few of its own files private — its capability sign-ins, the agents' provider homes. They
 * are listed, because they are there and a tree that dropped them would read as files having gone missing, but
 * clicking one used to flash a tab open and shut: the read is refused, and the viewer treated that as "deleted
 * on disk". The row now says so before it is clicked, and the click lands on an explanation. */
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

    // A locked folder has nothing behind it — the daemon's walk stops there — so the gesture that would open an
    // empty folder opens the explanation instead.
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

/* Looking at a file and choosing one are different gestures, and the strip used to hear only the second: every
 * row glanced at on the way to the right one left a tab behind it. The click now reports itself as a peek (the
 * strip's one transient slot, which the next peek takes over) and the double-click as the choice. */
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

    // The browser fires the click first, so both arrive — and the second one is what keeps the tab.
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

    // Enter is the keyboard's single click: walking a folder with the arrows leaves the same one tab behind.
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

/* BARREN BRANCHES — folders holding nothing but empty folders, the debris agent file moves leave behind. The
 * subject is what the explorer SHOWS: nothing at all until the emptiness has settled (an agent mid-scaffold
 * must not strobe the tree), then ONE dimmed row for the whole chain, a sweep line that NAMES what it is
 * offering to delete, and a delete that skips the confirm dialog — no content is lost, and the receipt's Undo
 * puts an empty folder back exactly. Timers are faked: the settle window is the behaviour, not incidental
 * delay.
 *
 * The naming is the half that was missing: a bare count asked the user to authorise deleting things it never
 * named, and the receipt afterwards named them no better — so what went was unknowable either side of the
 * click. What is asserted here is that the names are THERE, that each one leads back to its row, and that a
 * named folder can be kept instead of swept. */
describe(`empty folders (barren branches)`, () => {
    // `web › demo › assets` where every link holds only the next — one piece of junk, not three.
    const BARREN_TREE: WorkspaceTreeEntry[] = [
        dir(`web`, [dir(`web/demo`, [dir(`web/demo/assets`, [])])]),
        dir(`src`, [file(`src/main.ts`)]),
        file(`README.md`),
    ];
    // Two branches, the second buried under a folder holding real content — so revealing it has something to
    // open, which a root-level branch would never exercise.
    const TWO_BARREN_TREE: WorkspaceTreeEntry[] = [
        dir(`web`, [dir(`web/demo`, [dir(`web/demo/assets`, [])])]),
        dir(`src`, [file(`src/main.ts`), dir(`src/old`, [])]),
        file(`README.md`),
    ];

    // The sweep line's controls, by the words on them.
    const button = (el: HTMLElement, label: string): HTMLElement =>
        [...el.querySelectorAll(`button`)].find((candidate) => candidate.textContent?.trim() === label) as HTMLElement;
    /* Each disclosed entry as its two lines: the branch being deleted, then where it lives. Two lines rather
     * than one path because a 16rem column truncates from the right, which is exactly where the folder being
     * deleted sits — so the halves are read separately here too. */
    const entries = (el: HTMLElement): { name: string; where: string }[] =>
        [...el.querySelectorAll(`li`)].map((row) => {
            const [name, where] = [...row.querySelectorAll(`span`)].map((span) => span.textContent?.trim() ?? ``);
            return { name: name ?? ``, where: where ?? `` };
        });
    // The control that reveals a named branch — the first button of the entry whose name line matches.
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
        useReceipts().dismissReceipt();
    });

    it(`stays quiet through the settle window, then collapses the chain into one dimmed row and names it`, async () => {
        const el = await mount({ tree: BARREN_TREE });

        // Before the window passes: an ordinary row, no marker, no sweep line.
        expect(rows(el)).toEqual([`web`, `src`, `README.md`]);
        expect(el.textContent).not.toContain(`is empty`);

        await settle();

        expect(rows(el)).toEqual([`web / demo / assets`, `src`, `README.md`]);
        const label = [...el.querySelectorAll(`[role="treeitem"] span`)].find((span) => span.textContent?.includes(`web / demo`));
        expect(label?.className).toContain(`text-subtle`);
        // One branch needs no disclosure — the line says which folder, in the same words the row wears.
        expect(el.textContent).toContain(`web / demo / assets is empty`);
        // The chain's tail is the empty leaf: nothing to expand into, so no chevron.
        const chainRow = [...el.querySelectorAll(`[role="treeitem"]`)].find((row) => row.textContent?.includes(`web / demo`));
        expect(chainRow?.querySelector(`[data-icon^="chevron"]`)).toBeNull();
    });

    it(`folds several branches into a count that opens into their names`, async () => {
        const el = await mount({ tree: TWO_BARREN_TREE });
        await settle();

        // Closed: the count only. `src/old` is under a collapsed folder, so the tree itself shows nothing of it.
        expect(el.textContent).toContain(`2 empty folders`);
        expect(entries(el)).toEqual([]);

        button(el, `2 empty folders`).click();
        await nextTick();

        // A list standing away from the tree has no indentation to say where a folder lives, so every entry
        // carries its location — `old` alone names nothing anyone could act on. A root-level branch has none.
        expect(entries(el)).toEqual([
            { name: `web / demo / assets`, where: `` },
            { name: `old`, where: `src` },
        ]);
    });

    it(`opens the way down to a named folder and selects it`, async () => {
        const el = await mount({ tree: TWO_BARREN_TREE });
        await settle();
        button(el, `2 empty folders`).click();
        await nextTick();
        scrolled.length = 0;

        entryNamed(el, `old`).click();
        await nextTick();
        await nextTick();

        // `src` opened to make room for the row, which is then selected and scrolled to.
        expect(rows(el)).toEqual([`web / demo / assets`, `src`, `main.ts`, `old`, `README.md`]);
        const revealed = [...el.querySelectorAll(`[role="treeitem"]`)].find((row) => row.textContent?.trim() === `old`);
        expect(revealed?.getAttribute(`aria-selected`)).toBe(`true`);
        expect(scrolled).toContain(`old`);
    });

    it(`keeps one named folder instead of sweeping them all`, async () => {
        const el = await mount({ tree: TWO_BARREN_TREE });
        await settle();
        button(el, `2 empty folders`).click();
        await nextTick();

        // The Keep beside `web / demo / assets` — the chain's DEEPEST folder is what gets the placeholder.
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
        const el = await mount({ tree: BARREN_TREE });
        await settle();

        button(el, `Clean up`).click();
        await vi.advanceTimersByTimeAsync(1);

        expect(document.body.textContent).not.toContain(`Delete folder?`);
        const deletes = daemon.calls.filter((call) => call.init?.method === `DELETE`);
        expect(deletes.length).toBe(1);
        expect(String(deletes[0]?.init?.body)).toContain(`"web"`);
        // One branch fits a receipt and is the whole story.
        const { receipt } = useReceipts();
        expect(receipt.value?.message).toBe(`web / demo / assets removed`);

        // Undo recreates the chain's deepest folder — recursive create rebuilds the exact shape.
        await receipt.value?.undo?.();
        const creates = daemon.calls.filter((call) => call.path === `/workspace/dir`);
        expect(creates.length).toBe(1);
        expect(String(creates[0]?.init?.body)).toContain(`web/demo/assets`);
    });

    it(`says where a buried folder is, on the line and on the receipt`, async () => {
        const el = await mount({ tree: [dir(`src`, [file(`src/main.ts`), dir(`src/old`, [])]), file(`README.md`)] });
        await settle();

        // The line names it the same way the disclosed list would: what is going, then where it lives.
        const sole = [...el.querySelectorAll(`span`)].filter((span) => span.className.includes(`block truncate`));
        expect(sole.map((span) => span.textContent?.trim())).toEqual([`old is empty`, `src`]);

        button(el, `Clean up`).click();
        await vi.advanceTimersByTimeAsync(1);

        // A receipt has no room to shade the halves differently, so it spells the whole path.
        expect(useReceipts().receipt.value?.message).toBe(`src / old removed`);
    });

    it(`keeps the count in the receipt when several branches go at once`, async () => {
        const el = await mount({ tree: TWO_BARREN_TREE });
        await settle();

        button(el, `Clean up`).click();
        await vi.advanceTimersByTimeAsync(1);

        // A self-retiring pill is the wrong place for a list — naming them was the line's job, before the click.
        expect(useReceipts().receipt.value?.message).toBe(`2 empty folders removed`);
        expect(daemon.calls.filter((call) => call.init?.method === `DELETE`).length).toBe(2);
    });

    it(`skips the confirm dialog when the Delete key lands on a barren-only selection`, async () => {
        const el = await mount({ tree: BARREN_TREE });
        await settle();

        const chainRow = [...el.querySelectorAll(`[role="treeitem"]`)].find((row) => row.textContent?.includes(`web / demo`)) as HTMLElement;
        chainRow.click();
        await nextTick();
        chainRow.dispatchEvent(new KeyboardEvent(`keydown`, { key: `Delete`, bubbles: true }));
        await vi.advanceTimersByTimeAsync(1);

        expect(document.body.textContent).not.toContain(`Delete folder?`);
        expect(useReceipts().receipt.value?.message).toBe(`web / demo / assets removed`);
    });
});

/* SYMLINK ROWS. A link used to be filtered out of the daemon's listing entirely, so a folder holding only
 * links — `.claude/skills`, one per skill the sandbox loaded — drew as an empty folder. Now it is listed as
 * what it POINTS AT: the row wears the target's icon, expands if the target is a folder, and carries a small
 * marker saying the name is a pointer. Where it points is on the marker, which is the part VSCode's explorer
 * leaves out and the part that answers the only question a link raises. */
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
        // The link folder itself is left open, so what a walked-through link holds is on screen.
        restoreFrom([`.claude`, `.claude/skills`, `.claude/skills/github`]);
        const el = await mount({ tree: LINK_TREE });

        expect(markerOf(el, `github`)?.getAttribute(`data-icon`)).toBe(`link`);
        expect(markerOf(el, `github`)?.getAttribute(`data-tooltip`)).toBe(`Link to ../../.agents/skills/github`);
        // A working link is an ordinary row otherwise — it expands, and its contents are there.
        expect(rows(el)).toContain(`SKILL.md`);
        // A plain row wears no marker at all.
        expect(markerOf(el, `README.md`)).toBeUndefined();
    });

    it(`names the two refusals rather than just doing nothing`, async () => {
        restoreFrom([`.claude`, `.claude/skills`]);
        const el = await mount({ tree: LINK_TREE });

        expect(markerOf(el, `gone`)?.getAttribute(`data-icon`)).toBe(`link-broken`);
        expect(markerOf(el, `gone`)?.getAttribute(`data-tooltip`)).toBe(`Link to ../../.agents/skills/gone — there is nothing there`);
        expect(markerOf(el, `away`)?.getAttribute(`data-tooltip`)).toBe(`Link to /etc — outside the workspace, so the sandbox won't open it`);
    });

    it(`offers no chevron on a link with nothing reachable behind it`, async () => {
        restoreFrom([`.claude`, `.claude/skills`]);
        const el = await mount({ tree: LINK_TREE });

        const chevronOf = (name: string): boolean =>
            [...el.querySelectorAll(`[role="treeitem"]`)]
                .find((row) => row.textContent?.trim().startsWith(name))
                ?.querySelector(`[data-icon^="chevron"]`) !== null;
        expect(chevronOf(`github`)).toBe(true);
        // A link out of the workspace resolves to a DIRECTORY, so without this it would offer to expand into
        // a listing the daemon refuses to produce.
        expect(chevronOf(`away`)).toBe(false);
    });
});

/* WHERE A DROP LANDS. Aiming at a FILE used to be the one gesture in the explorer that ignored what was under
 * the pointer: the row declined the drop, it bubbled to the explorer background, and whatever was dragged
 * landed at the workspace root — nowhere near the folder being pointed into, and, for an upload of a folder,
 * a mess to undo. A file stands in for the folder holding it everywhere else here (New File, paste, the
 * keyboard axis), and now it does for a drop too: onto something means beside it. */
describe(`where a drop on a row lands`, () => {
    const DROP_TREE: WorkspaceTreeEntry[] = [
        dir(`src`, [dir(`src/api`, [file(`src/api/routes.ts`)]), file(`src/main.ts`), file(`src/util.ts`)]),
        file(`README.md`),
    ];
    const rowNamed = (el: HTMLElement, name: string): HTMLElement =>
        [...el.querySelectorAll(`[role="treeitem"]`)].find((row) => row.textContent?.trim() === name) as HTMLElement;
    // jsdom implements neither DragEvent nor DataTransfer, so the drag store is the two things the handler
    // reads: what the drag is offering, and what it holds. An internal row move is the payload under test
    // because it lands as a daemon call this can read.
    const dropOn = async (row: HTMLElement, dragged: string, types: string[] = [`application/x-intentic-path`]): Promise<void> => {
        const event = new Event(`drop`, { bubbles: true, cancelable: true });
        Object.defineProperty(event, `dataTransfer`, {
            value: { types, getData: (type: string): string => (type === `application/x-intentic-path` ? dragged : ``) },
        });
        row.dispatchEvent(event);
        // The handler's work is a promise chain with no timer in it, so draining the queue twice settles both
        // the move and the "nothing to move" case — which has to be readable as SILENCE, not as a slow call.
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

    // Dropping a row onto its own neighbour asks for the folder it is already in: nothing to do, and nothing
    // asked of the daemon — least of all a move to the root, which is where it used to end up.
    it(`asks the daemon for nothing when the file aimed at is already a neighbour`, async () => {
        restoreFrom([`src`]);
        const el = await mount({ tree: DROP_TREE });

        await dropOn(rowNamed(el, `util.ts`), `src/main.ts`);

        expect(moves()).toEqual([]);
    });

    /* Now that every row takes drops, every row also has to REFUSE the drags that aren't ours. A browser makes
     * each image and link a drag source, so dragging the previewed image across the explorer used to sail over
     * folder rows harmlessly and would now sail over file rows too — landing a copy of the file being looked at
     * back in the workspace if a row accepted it. */
    it(`refuses a drag carrying neither files nor rows`, async () => {
        restoreFrom([`src`]);
        const el = await mount({ tree: DROP_TREE });

        await dropOn(rowNamed(el, `util.ts`), ``, [`text/uri-list`]);

        expect(daemon.calls).toEqual([]);
    });
});
