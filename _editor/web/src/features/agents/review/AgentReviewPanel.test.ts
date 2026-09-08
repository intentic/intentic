// @vitest-environment jsdom
// jsdom because the subject is the file list: a land conflict used to be a paragraph naming a few paths above
// rows that all looked alike, forcing the reader to match strings by eye. The fix (a mark per blocked row, a
// count per heading, a narrowing filter) is entirely in what renders, so only rendering can pin it.
import type { AgentChangesResponse, AgentHistoryResponse } from "@intentic/api-contract";
import type { WorkspaceModule } from "@intentic/sandbox-contract";
import { VueQueryPlugin } from "@tanstack/vue-query";
import { afterEach, expect, it, vi } from "vitest";
import { type App, createApp, h, nextTick, ref } from "vue";
import { REASON_COPY } from "./conflictResolution";
import { useAgentChanges } from "./useAgentChanges";
import { agentHistoryKey } from "../fleet/useAgentHistory";
import { queryClient } from "../../../lib/queryPersistence";
import { AGENT_DIFF, WORKSPACE_MODULES } from "../../../lib/queryKeys";
import { router } from "../../../router";
import { IconStub } from "@intentic/ui/testing";

// The import chain pulls in app-wide singletons reading browser globals at import time; matches:false keeps the
// device desktop, where list and diff share the screen.
vi.hoisted(() => {
    // jsdom implements no scrolling; selecting a row calls scrollIntoView, so this is stubbed to a no-op.
    globalThis.Element.prototype.scrollIntoView ??= (): void => {};
});

// The only stand-ins: FileDiffPane's two inner viewers. Monaco is real but decides nothing this suite cares
// about; the list is the subject.
vi.mock("../../workspace/viewers/DiffView.vue", () => ({ default: { render: () => null } }));
vi.mock("../../workspace/viewers/BinaryDiffView.vue", () => ({ default: { render: () => null } }));

const { default: AgentReviewPanel } = await import("./AgentReviewPanel.vue");
// The comment toggle that decides which reading every badge prints, imported once globals are in place.
const { showComments, toggleShowComments } = (await import("../../../shell/window/useLayout")).useLayout();
// The other list preference: size order vs. path order.
const { largestFirst } = (await import("../../workspace/changes/changeWeight")).useChangeWeight();

const AGENT = `a1`;
// A refused land as the daemon reports it: nothing landed (atomic), two of five files blocked for two different
// causes in two repos. The third repo group holds none, proving a heading's count is per repo, not the report's total.
const changes: AgentChangesResponse = {
    // Nothing reached history yet, the state a refusal leaves; that empty state is tested separately below.
    absorbed: 0,
    repos: [
        {
            repo: `root`,
            branch: `agent/a1`,
            changes: [
                // Code-only counts ride on the row; session.ts is mostly comments, so the two readings disagree on it.
                { path: `src/auth/session.ts`, status: `modified`, additions: 12, deletions: 3, code: { additions: 1, deletions: 0 }, landed: false },
                {
                    path: `src/auth/session.test.ts`,
                    status: `modified`,
                    additions: 8,
                    deletions: 0,
                    code: { additions: 8, deletions: 0 },
                    landed: false,
                },
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

// Agent's own package layout, shipped with the diff, not looked up from /work.
const MODULES: readonly WorkspaceModule[] = [{ dir: `src/auth`, name: `@shop/auth` }];

let app: App | undefined;

// Seeded into the query cache rather than served over a stub, since the diff query is gated on daemon
// reachability nothing here drives; this is also where the real panel reads it from.
const mount = async (modules: readonly WorkspaceModule[] = [], seed?: AgentChangesResponse, history?: AgentHistoryResponse): Promise<HTMLElement> => {
    // Empty by default: no packages means every path lands in one unnamed bucket, repo headings only.
    const repos: AgentChangesResponse[`repos`] = [];
    for (const repo of changes.repos) {
        repos.push(repo.repo === `root` ? { ...repo, modules: [...modules] } : repo);
    }
    queryClient.setQueryData(AGENT_DIFF.of(AGENT), seed ?? ({ ...changes, repos } satisfies AgentChangesResponse));
    // History is lazy: the panel only enables it once absorbed work is reported, so it's seeded only for tests about
    // that state, empty otherwise to avoid a permanent loading line.
    if ((seed ?? changes).absorbed > 0) {
        queryClient.setQueryData(agentHistoryKey(AGENT), history ?? ({ repos: [], unaccounted: 0 } satisfies AgentHistoryResponse));
    }
    const el = document.createElement(`div`);
    document.body.append(el);
    // The review state is created by AgentDetail and shared with the panel in the real page; this host stands in.
    app = createApp({
        setup() {
            const review = useAgentChanges(ref(AGENT));
            return () => h(AgentReviewPanel, { agentId: AGENT, changes: review, streaming: false, writing: false });
        },
    });
    // Icon renders the glyph it's given, since which glyph a mark wears is the link this suite tests.
    app.component(`Icon`, IconStub);
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
    // Toggles are app-wide state outliving a mount; reset here so one test can't hand the next a different panel.
    if (showComments.value) {
        toggleShowComments();
    }
    largestFirst.value = false;
});

// File rows, by container class; substring-matched to sidestep escaping Tailwind's `/`.
const rows = (el: HTMLElement): HTMLElement[] => [...el.querySelectorAll<HTMLElement>(`[class*="group/file"]`)];
const rowFor = (el: HTMLElement, path: string): HTMLElement =>
    rows(el).find((row) => row.textContent?.includes(path.slice(path.lastIndexOf(`/`) + 1)))!;
// Rows on screen top to bottom, by filename, the reading a user actually sees.
const NAMES = /session\.test\.ts|session\.ts|config\.ts|logo\.png|README\.md/;
const rowNames = (el: HTMLElement): string[] => rows(el).map((row) => row.textContent?.match(NAMES)?.[0] ?? ``);
// A package heading's fold, told apart from its repo's by the module glyph and from the sweep by its name.
const packageHeading = (el: HTMLElement, name: string): HTMLElement =>
    [...el.querySelectorAll<HTMLElement>(`[class*="group/head"] > button`)].find(
        (button) => button.querySelector(`[data-icon="box"], [data-icon="folder"]`) !== null && button.textContent?.trim().startsWith(name) === true,
    )!;
// The narrowing control's options, in the order offered.
const filters = (el: HTMLElement): string[] =>
    [...el.querySelectorAll(`button`)]
        .map((button) => button.textContent?.trim() ?? ``)
        .filter((label) => /^(All|Blocked|Code|Tests|Not landed|In history) \d+$/.test(label));

// An empty list is two opposite facts, and the panel must pick the right sentence: committed-away work reads the
// same as writing nothing, except for `absorbed`.
it(`tells an agent that wrote nothing from one whose work the user has committed`, async () => {
    const wroteNothing = await mount([], { repos: [], absorbed: 0 });
    expect(wroteNothing.textContent).toContain(`hasn't changed any files`);
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
    queryClient.clear();

    // The sentence is a last resort, true only when the carrying commits can't be found; seeded empty here for
    // exactly that.
    const allCommitted = await mount([], { repos: [], absorbed: 3 }, { repos: [], unaccounted: 3 });
    expect(allCommitted.textContent).toContain(`All 3 files this agent wrote are in your workspace's history`);
    expect(allCommitted.textContent).toContain(`nothing of it differs from main`);
    expect(allCommitted.textContent).not.toContain(`hasn't changed any files`);
});

// Committing an agent's work used to empty the whole review at the exact moment a reader came to look at it; the
// panel now reads the same work out of the commit instead, same list and diff.
it(`shows work the user has committed, under the commit that carries it`, async () => {
    const el = await mount(
        [],
        { repos: [], absorbed: 2 },
        {
            repos: [
                {
                    repo: `root`,
                    commits: [
                        {
                            sha: `a3f9c21ddb3f4e0b8a1c2d3e4f5a6b7c8d9e0f1a`,
                            short: `a3f9c21`,
                            subject: `fix: tighten the land anchor`,
                            author: `Radarsu`,
                            at: Date.parse(`2026-08-30T10:00:00Z`),
                            changes: [
                                { path: `src/auth/session.ts`, status: `modified`, additions: 12, deletions: 3 },
                                { path: `src/config.ts`, status: `modified`, additions: 2, deletions: 1 },
                            ],
                        },
                    ],
                    modules: [],
                },
            ],
            unaccounted: 0,
        },
    );

    // The commit is named, replacing "somewhere in your history" with a place to actually look.
    expect(el.textContent).toContain(`a3f9c21`);
    expect(el.textContent).toContain(`fix: tighten the land anchor`);
    expect(el.textContent).toContain(`2 files`);
    // And the work itself is on screen as rows, not merely described.
    expect(rowNames(el).toSorted()).toEqual([`config.ts`, `session.ts`]);
    // Panel opens standing in the committed work; `All 0` isn't offered over nothing left to be all of, so with one
    // body of work there's no filter, just a plain count.
    expect(filters(el)).toEqual([]);
    expect(el.textContent).toContain(`2 files`);
    expect(el.textContent).not.toContain(`hasn't changed any files`);
    // The last-resort sentence is for when commits can't be found; here they were, so it's absent.
    expect(el.textContent).not.toContain(`nothing of it differs from main`);
});

// One commit is named once above the list; several must be told apart on the rows themselves, since the summary
// can't answer for a single file.
it(`stamps each row with its own commit only when the work arrived in more than one`, async () => {
    const commit = (short: string, path: string) => ({
        sha: `${short}0000000000000000000000000000000000`,
        short,
        subject: `took ${path}`,
        author: `Radarsu`,
        at: Date.parse(`2026-08-30T10:00:00Z`),
        changes: [{ path, status: `modified` as const, additions: 1, deletions: 0 }],
    });
    const one = await mount(
        [],
        { repos: [], absorbed: 1 },
        {
            repos: [{ repo: `root`, commits: [commit(`aaaaaaa`, `src/config.ts`)], modules: [] }],
            unaccounted: 0,
        },
    );
    // Named in the summary only, not repeated down the rows, which would cost width for nothing new.
    expect(one.textContent).toContain(`aaaaaaa`);
    expect(rowFor(one, `src/config.ts`).textContent).not.toContain(`aaaaaaa`);
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
    queryClient.clear();

    const two = await mount(
        [],
        { repos: [], absorbed: 2 },
        {
            repos: [{ repo: `root`, commits: [commit(`aaaaaaa`, `src/config.ts`), commit(`bbbbbbb`, `src/auth/session.ts`)], modules: [] }],
            unaccounted: 0,
        },
    );
    expect(rowFor(two, `src/config.ts`).textContent).toContain(`aaaaaaa`);
    expect(rowFor(two, `src/auth/session.ts`).textContent).toContain(`bbbbbbb`);
});

// Absorbed and unattributable at once: content reached main by a road with no commit since; said explicitly so
// the commit list doesn't read as the whole story.
it(`says how much of the work no commit here accounts for`, async () => {
    const el = await mount(
        [],
        { repos: [], absorbed: 3 },
        {
            repos: [
                {
                    repo: `root`,
                    commits: [
                        {
                            sha: `a3f9c21ddb3f4e0b8a1c2d3e4f5a6b7c8d9e0f1a`,
                            short: `a3f9c21`,
                            subject: `fix: tighten the land anchor`,
                            author: `Radarsu`,
                            at: Date.parse(`2026-08-30T10:00:00Z`),
                            changes: [{ path: `src/config.ts`, status: `modified`, additions: 2, deletions: 1 }],
                        },
                    ],
                    modules: [],
                },
            ],
            unaccounted: 2,
        },
    );
    expect(el.textContent).toContain(`2 more files are in your history without a commit here accounting for them`);
});

it(`marks each blocked row with its own cause, and leaves the rest of the review alone`, async () => {
    const el = await mount();
    // Two causes, two marks, worded from the report's own module, so a row can't say something the report doesn't.
    expect(rowFor(el, `src/config.ts`).textContent).toContain(REASON_COPY.workspace.mark);
    expect(rowFor(el, `src/config.ts`).querySelector(`[data-icon="${REASON_COPY.workspace.icon}"]`)).not.toBeNull();
    expect(rowFor(el, `assets/logo.png`).textContent).toContain(REASON_COPY.binary.mark);
    expect(rowFor(el, `assets/logo.png`).querySelector(`[data-icon="${REASON_COPY.binary.icon}"]`)).not.toBeNull();
    // Unlanded isn't blocked: an atomic refusal leaves every row unlanded either way.
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

// The regression: the control used to hide entirely unless the unlanded set was a proper subset, so the one
// state where narrowing thirty files matters most had no control at all.
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

// An agent's new package exists only in its worktree, so grouping by the workspace-wide read put its files in the
// unnamed bucket. Groups by the agent's own diff instead; the workspace read is seeded to disagree and ignored.
it(`groups by the packages of the agent's own tree, not the workspace's`, async () => {
    queryClient.setQueryData(WORKSPACE_MODULES.of(), { repos: [{ repo: `root`, modules: [] }] });
    const el = await mount(MODULES);
    const heading = packageHeading(el, `@shop/auth`);
    expect(heading.querySelector(`[data-icon="box"]`)).not.toBeNull();
    // Named above, so rows under it are bare filenames, not repeated `src/auth/` prefixes.
    expect(rowFor(el, `src/auth/session.ts`).textContent).not.toContain(`src/auth`);
});

// Folding a package: before this, the only fold available was the whole repo, which in a monorepo is the entire
// review. Pins what disappears, what must not, and that the keyboard can't walk back into a fold.
it(`folds one package's rows away and leaves the rest of the review standing`, async () => {
    const el = await mount(MODULES);
    expect(rowNames(el)).toEqual([`session.ts`, `session.test.ts`, `config.ts`, `logo.png`, `README.md`]);
    packageHeading(el, `@shop/auth`).click();
    await nextTick();
    expect(rowNames(el)).toEqual([`config.ts`, `logo.png`, `README.md`]);
    // Same control both ways: a fold with no way back is a file hidden for good.
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
    // What a folded heading's size means: the reading its rows were drawing (code-only, already counted by the
    // daemon), not a pending recount.
    expect(packageHeading(el, `@shop/auth`).textContent).toContain(`+9`);
    expect(packageHeading(el, `@shop/auth`).querySelector(`.opacity-50`)).toBeNull();

    // With comments shown the same heading totals git's own counts instead.
    toggleShowComments();
    await nextTick();
    expect(packageHeading(el, `@shop/auth`).textContent).toContain(`+20`);
    expect(packageHeading(el, `root`).textContent).toContain(`+2`);
});

it(`steps past a folded package instead of landing inside it`, async () => {
    const el = await mount(MODULES);
    packageHeading(el, `@shop/auth`).click();
    await nextTick();
    // Folding means "give back the space", not "close the open file": the diff stays on session.ts.
    expect(el.querySelector(`section > div`)?.textContent).toContain(`session.ts`);
    window.dispatchEvent(new KeyboardEvent(`keydown`, { key: `j` }));
    await nextTick();
    await nextTick();
    // The next row down the list, not the folded package's second file.
    expect(el.querySelector(`section > div`)?.textContent).toContain(`config.ts`);
});

// Every number a row shows arrives already counted with the list (git/code-counts.ts), so size order is ordering
// on something final rather than re-derived per fetch, which used to re-sort the list under a just-picked row.
it(`orders on the code-only reading the rows are showing, and holds it through a click`, async () => {
    largestFirst.value = true;
    const el = await mount();
    // Git would rank session.ts first; the reading the badges draw puts it below the files it dwarfs.
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
    // The report prints the repo-qualified path; the row it names is where the diff header must land.
    [...el.querySelectorAll(`button`)].find((button) => button.textContent?.trim() === `assets/logo.png`)!.click();
    await nextTick();
    await nextTick();
    const header = el.querySelector(`section > div`)!;
    expect(header.textContent).toContain(`logo.png`);
    expect(header.textContent).toContain(REASON_COPY.binary.mark);
});
