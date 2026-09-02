// @vitest-environment jsdom
//
// jsdom because the whole subject here is the LEFT-HAND LIST. A land conflict used to be a paragraph above the
// review naming a few paths, over a list of rows that all looked alike, so "which of these thirty files is the
// problem, and whose problem is it?" was a question the user answered by matching strings with their eyes. The
// fix is entirely in what renders: a mark per blocked row, a count per repo heading, a filter that narrows to
// them. None of that can be pinned by a unit test on the composable, only by looking at the rows.
import type { AgentChangesResponse } from "@intentic-app/api-contract";
import type { WorkspaceModule } from "@intentic/sandbox-contract";
import { VueQueryPlugin } from "@tanstack/vue-query";
import { afterEach, expect, it, vi } from "vitest";
import { type App, createApp, defineComponent, h, nextTick, ref } from "vue";
import { REASON_COPY } from "../composables/agents/conflictResolution";
import { useAgentChanges } from "../composables/agents/useAgentChanges";
import { queryClient } from "../composables/queryPersistence";
import { AGENTS, WORKSPACE_MODULES } from "../composables/queryKeys";
import { router } from "../router";

// The panel's import chain pulls in app-wide singletons that read browser globals at import time
// (@intentic/ui's useDevice reads window.matchMedia; environment.ts reads window.env). matches:false keeps
// the device DESKTOP: the form factor where the list and the diff are on screen together.
vi.hoisted(() => {
    // jsdom implements no scrolling at all, and selecting a row keeps it on screen.
    globalThis.Element.prototype.scrollIntoView ??= (): void => {};
});

// The only stand-ins: the two viewers FileDiffPane picks between for whichever file is selected (the pane
// itself is real, it is cheap and decides nothing this suite cares about). Monaco is a real editor with real
// workers and nothing about it is under test here: the list is.
vi.mock("../pages/workspace/viewers/DiffView.vue", () => ({ default: { render: () => null } }));
vi.mock("../pages/workspace/viewers/BinaryDiffView.vue", () => ({ default: { render: () => null } }));

const { default: AgentReviewPanel } = await import("./AgentReviewPanel.vue");
// The reader's comment toggle, which decides WHICH reading every badge in the panel prints. Imported the same way
// as the panel, after the globals its module chain reads at import time are in place.
const { showComments, toggleShowComments } = (await import("../composables/useLayout")).useLayout();
// The other preference the list reads: whether it is ordered by size or by path.
const { largestFirst } = (await import("../composables/workspace/changeWeight")).useChangeWeight();

const AGENT = `a1`;
/* A refused land as the daemon reports it: nothing landed (a check land is atomic), two of the five files
 * blocked, for two different causes, in two different repos. The third repo group holds none: the case that
 * proves a heading's count is per repo and not the report's total. */
const changes: AgentChangesResponse = {
    repos: [
        {
            repo: `root`,
            branch: `agent/a1`,
            changes: [
                // The code-only pair the daemon counted rides on the row (GitChange.code). session.ts is the
                // interesting one: git calls it the biggest file here, and eleven of its twelve added lines are
                // comment, so the two readings disagree about where it belongs.
                { path: `src/auth/session.ts`, status: `modified`, additions: 12, deletions: 3, code: { additions: 1, deletions: 0 }, landed: false },
                { path: `src/auth/session.test.ts`, status: `modified`, additions: 8, deletions: 0, code: { additions: 8, deletions: 0 }, landed: false },
                { path: `src/config.ts`, status: `modified`, additions: 2, deletions: 1, code: { additions: 2, deletions: 1 }, landed: false },
                { path: `assets/logo.png`, status: `modified`, landed: false },
            ],
            modules: [],
        },
        {
            repo: `docs`,
            branch: `agent/a1`,
            changes: [{ path: `README.md`, status: `modified`, additions: 1, deletions: 1, code: { additions: 1, deletions: 1 }, landed: false }],
            modules: [],
        },
    ],
    conflicts: [
        {
            repo: `root`,
            clean: 2,
            paths: [
                { path: `src/config.ts`, reason: `workspace` },
                { path: `assets/logo.png`, reason: `binary` },
            ],
        },
    ],
};

/* The root repo's package layout AS THE AGENT'S OWN TREE HAS IT: shipped with the diff, not looked up from the
 * workspace-wide read, because an agent works in a worktree and /work cannot see a package that so far exists
 * only there. One package over the two auth files, and the two loose files nothing claims, which are also,
 * deliberately, the two blocked ones: folding the bucket that holds a refusal is the case where a fold must not
 * be able to hide anything. */
const MODULES: readonly WorkspaceModule[] = [{ dir: `src/auth`, name: `@shop/auth` }];

let app: App | undefined;

/* Seeded into the query cache rather than served over a stubbed fetch: the diff query is gated on the daemon
 * being reachable (useSandboxQuery), which no test drives, and the cache is where the real panel reads it from
 * anyway: this is the state a browser is in when it opens the review on a conflict it learned about from the
 * board. */
const mount = async (modules: readonly WorkspaceModule[] = []): Promise<HTMLElement> => {
    // Empty by default: with no packages to group by, every path lands in one unnamed bucket and the list draws
    // repo headings only, which is what the tests that aren't about packages want.
    const repos: AgentChangesResponse[`repos`] = [];
    for (const repo of changes.repos) {
        repos.push(repo.repo === `root` ? { ...repo, modules: [...modules] } : repo);
    }
    queryClient.setQueryData(AGENTS.of(AGENT, `diff`), { ...changes, repos } satisfies AgentChangesResponse);
    const el = document.createElement(`div`);
    document.body.append(el);
    // The review's state is created by AgentDetail in the real page and handed down, so one instance serves
    // both the header's actions and this panel's: the host here stands in for exactly that.
    app = createApp({
        setup() {
            const review = useAgentChanges(ref(AGENT));
            return () => h(AgentReviewPanel, { agentId: AGENT, changes: review, streaming: false, writing: false });
        },
    });
    // Registered app-wide by installUi in the real page. Icon prints the glyph it was handed, because WHICH
    // glyph a mark wears is the link between the report's group heading and the rows it is talking about.
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
    app.use(router);
    app.use(VueQueryPlugin, { queryClient });
    app.mount(el);
    await nextTick();
    await nextTick();
    return el;
};

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
    queryClient.clear();
    // The toggles are app-wide state that outlives a mount, so a test that flips one hands the next one a
    // different panel than it asked for.
    if (showComments.value) {
        toggleShowComments();
    }
    largestFirst.value = false;
});

// The file rows, by the class the row container carries. Substring-matched to sidestep escaping Tailwind's `/`.
const rows = (el: HTMLElement): HTMLElement[] => [...el.querySelectorAll<HTMLElement>(`[class*="group/file"]`)];
const rowFor = (el: HTMLElement, path: string): HTMLElement =>
    rows(el).find((row) => row.textContent?.includes(path.slice(path.lastIndexOf(`/`) + 1)))!;
// The rows on screen, top to bottom, by the file each one names: the reading the list gives a user.
const NAMES = /session\.test\.ts|session\.ts|config\.ts|logo\.png|README\.md/;
const rowNames = (el: HTMLElement): string[] => rows(el).map((row) => row.textContent?.match(NAMES)?.[0] ?? ``);
// A PACKAGE heading's own control (the fold), told apart from its repo's by the module glyph it carries and
// from the sweep beside it by the fact that it is the half with the name on it.
const packageHeading = (el: HTMLElement, name: string): HTMLElement =>
    [...el.querySelectorAll<HTMLElement>(`[class*="group/head"] > button`)].find(
        (button) => button.querySelector(`[data-icon="box"], [data-icon="folder"]`) !== null && button.textContent?.trim().startsWith(name) === true,
    )!;
// The narrowing control's options, in the order it offers them.
const filters = (el: HTMLElement): string[] =>
    [...el.querySelectorAll(`button`)]
        .map((button) => button.textContent?.trim() ?? ``)
        .filter((label) => /^(All|Blocked|Code|Tests|Not landed) \d+$/.test(label));

it(`marks each blocked row with its own cause, and leaves the rest of the review alone`, async () => {
    const el = await mount();
    // The user's own uncommitted edits, and a file git cannot merge at all: two causes, two marks, and the
    // words are the module's, so the row cannot come to say something the report above it doesn't.
    expect(rowFor(el, `src/config.ts`).textContent).toContain(REASON_COPY.workspace.mark);
    expect(rowFor(el, `src/config.ts`).querySelector(`[data-icon="${REASON_COPY.workspace.icon}"]`)).not.toBeNull();
    expect(rowFor(el, `assets/logo.png`).textContent).toContain(REASON_COPY.binary.mark);
    expect(rowFor(el, `assets/logo.png`).querySelector(`[data-icon="${REASON_COPY.binary.icon}"]`)).not.toBeNull();
    // A file that landed nowhere is not a file that BLOCKED anything: an atomic refusal leaves every row
    // unlanded, so marking on `landed` alone would have called all five of these the conflict.
    expect(rowFor(el, `src/auth/session.ts`).textContent).not.toContain(REASON_COPY.workspace.mark);
    expect(rowFor(el, `src/auth/session.ts`).textContent).not.toContain(REASON_COPY.binary.mark);
    expect(rowFor(el, `src/auth/session.ts`).textContent).not.toContain(REASON_COPY.diverged.mark);
});

it(`counts the blockers on the repo heading, so a collapsed group cannot hide one`, async () => {
    const el = await mount();
    const heading = (repo: string): HTMLElement =>
        [...el.querySelectorAll(`button`)].find((button) => button.textContent?.trim().toLowerCase().startsWith(repo))!;
    const root = heading(`root`);
    const docs = heading(`docs`);
    expect(root.querySelector(`[data-icon="exclamation-triangle"]`)).not.toBeNull();
    expect(docs.querySelector(`[data-icon="exclamation-triangle"]`)).toBeNull();
});

/* THE REGRESSION THIS FILTER CARRIES. The control used to be hidden whole whenever the unlanded set was not a
 * proper subset of the review, and a refused land leaves EVERY row unlanded, so the one state where narrowing
 * a thirty-file list matters most was the one state with no control to do it. */
it(`offers Blocked first and keeps the control alive when a refusal left nothing landed`, async () => {
    const el = await mount();
    expect(filters(el)).toEqual([`All 5`, `Blocked 2`, `Code 4`, `Tests 1`]);
});

it(`narrows to exactly the blocked files`, async () => {
    const el = await mount();
    [...el.querySelectorAll(`button`)].find((button) => button.textContent?.trim() === `Blocked 2`)!.click();
    await nextTick();
    expect(rows(el).map((row) => row.textContent?.match(/config\.ts|logo\.png|session\.ts|README\.md/)?.[0])).toEqual([`config.ts`, `logo.png`]);
});

/* THE PACKAGE /work HAS NEVER HEARD OF. An agent writes in a worktree, so a package it has just created has
 * its manifest only there, and that is exactly when grouping matters most, because every file of a new package
 * is a change. This list used to group by the workspace-wide read, which walks /work, so all of them fell into
 * the unnamed "loose in this repo" bucket and were drawn as bare paths under no package at all. It groups by
 * the layout its own diff shipped with; the workspace read below is seeded to disagree, and is not consulted. */
it(`groups by the packages of the agent's own tree, not the workspace's`, async () => {
    queryClient.setQueryData(WORKSPACE_MODULES.of(), { repos: [{ repo: `root`, modules: [] }] });
    const el = await mount(MODULES);
    const heading = packageHeading(el, `@shop/auth`);
    expect(heading.querySelector(`[data-icon="box"]`)).not.toBeNull();
    // Named above, so the rows under it are the files alone rather than repeated `src/auth/` prefixes.
    expect(rowFor(el, `src/auth/session.ts`).textContent).not.toContain(`src/auth`);
});

/* FOLDING A PACKAGE. A landing that spans four packages is one the reviewer cares about and three that are
 * noise to them, and before this the only fold on offer was the whole repo, which in a monorepo is the entire
 * review. These three pin the parts that are easy to get wrong: what disappears, what must not, and that the
 * keyboard can't walk back into what you just folded. */
it(`folds one package's rows away and leaves the rest of the review standing`, async () => {
    const el = await mount(MODULES);
    expect(rowNames(el)).toEqual([`session.ts`, `session.test.ts`, `config.ts`, `logo.png`, `README.md`]);
    packageHeading(el, `@shop/auth`).click();
    await nextTick();
    expect(rowNames(el)).toEqual([`config.ts`, `logo.png`, `README.md`]);
    // The same control both ways: a fold with no way back is a file hidden for good.
    packageHeading(el, `@shop/auth`).click();
    await nextTick();
    expect(rowNames(el)).toEqual([`session.ts`, `session.test.ts`, `config.ts`, `logo.png`, `README.md`]);
});

it(`keeps a folded package saying how big it is and how much of it refused`, async () => {
    const el = await mount(MODULES);
    // The bucket of files no package claims: here, both blocked ones.
    const loose = packageHeading(el, `root`);
    loose.click();
    await nextTick();
    expect(rowNames(el)).toEqual([`session.ts`, `session.test.ts`, `README.md`]);
    expect(packageHeading(el, `root`).querySelector(`[data-icon="exclamation-triangle"]`)).not.toBeNull();
    expect(packageHeading(el, `root`).textContent).toContain(`2`);
    /* WHAT A FOLDED HEADING SAYS ABOUT ITS SIZE, and it says it in the reading its rows were drawing: the code
     * their two rows added, +1 and +8, and nothing pending about it — the daemon counted them before the list
     * was sent. A folded package whose size was a pending mark was a fold that hid the one fact it exists to
     * keep. */
    expect(packageHeading(el, `@shop/auth`).textContent).toContain(`+9`);
    expect(packageHeading(el, `@shop/auth`).querySelector(`.opacity-50`)).toBeNull();

    // With the comments shown the same heading totals git's own instead: +20 −3 for the package, and +2 −1
    // (config.ts) for the loose bucket, whose logo.png carries no line counts at all.
    toggleShowComments();
    await nextTick();
    expect(packageHeading(el, `@shop/auth`).textContent).toContain(`+20`);
    expect(packageHeading(el, `root`).textContent).toContain(`+2`);
});

it(`steps past a folded package instead of landing inside it`, async () => {
    const el = await mount(MODULES);
    packageHeading(el, `@shop/auth`).click();
    await nextTick();
    // Folding is "give me back the space", not "close the file I'm reading": the diff stays on session.ts.
    expect(el.querySelector(`section > div`)?.textContent).toContain(`session.ts`);
    window.dispatchEvent(new KeyboardEvent(`keydown`, { key: `j` }));
    await nextTick();
    await nextTick();
    // The next row DOWN the list, not the folded package's second file.
    expect(el.querySelector(`section > div`)?.textContent).toContain(`config.ts`);
});

/* THE LIST IS DRAWN ONCE AND STAYS THAT WAY. Every number a row shows — git's pair and the code-only pair
 * beside it — arrives with the list, counted by the daemon (git/code-counts.ts), so ordering by size is ordering
 * on something final. The panel used to work the code-only reading out itself, from the diffs as they happened
 * to be fetched, which is why a click could re-sort the list under the pointer that had just picked a row: the
 * fixture's session.ts is the case that did it, eleven-twelfths comment, so the two readings rank it oppositely.
 */
it(`orders on the code-only reading the rows are showing, and holds it through a click`, async () => {
    largestFirst.value = true;
    const el = await mount();
    // Git would rank session.ts (+12) first; the reading the badges draw puts it below the two files it dwarfs.
    const order = [`session.test.ts`, `config.ts`, `session.ts`, `logo.png`, `README.md`];
    expect(rowNames(el)).toEqual(order);
    expect(rowFor(el, `src/auth/session.ts`).textContent).toContain(`+1`);

    rowFor(el, `src/config.ts`).querySelector(`button`)!.click();
    await nextTick();
    expect(rowNames(el)).toEqual(order);
    expect(rowFor(el, `src/auth/session.ts`).textContent).toContain(`+1`);
});

it(`lands a path clicked in the report on its row, and says so in the diff header`, async () => {
    const el = await mount();
    // The report prints the repo-qualified path; the row it names is the one the diff header must end up on.
    [...el.querySelectorAll(`button`)].find((button) => button.textContent?.trim() === `assets/logo.png`)!.click();
    await nextTick();
    await nextTick();
    const header = el.querySelector(`section > div`)!;
    expect(header.textContent).toContain(`logo.png`);
    expect(header.textContent).toContain(REASON_COPY.binary.mark);
});
