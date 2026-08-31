import { beforeEach, describe, expect, it, vi } from "vitest";
import { ref } from "vue";
import type { RepoChanges } from "@intentic-app/api-contract";

/* THE LEDGER'S READING of another box's repos. What is worth pinning here is which rows it shows and what each
 * one says, because a row appearing at all IS the news: a clean repo on another machine is not information,
 * and a repo git could not read must never be drawn as clean.
 *
 * The polling is fleetAcross's pattern and is tested there; the network is cut out entirely below. */

const sandboxes = ref<{ id: string; name: string; lastSeenAt: string | null }[]>([]);
const activeSandboxId = ref<string | undefined>(`sbx-here`);
vi.mock("../sandbox/useSandbox", () => ({ useSandbox: () => ({ sandboxes, activeSandboxId }) }));
vi.mock("../sandbox/sandboxClient", () => ({ sandboxJsonAt: vi.fn() }));
vi.mock("../sandbox/sandboxScreen", () => ({ landOnAfterSwitch: vi.fn() }));
vi.mock("../queryPersistence", () => ({ queryClient: { setQueryData: vi.fn() } }));

const { hasOtherSandboxes, rowsOf, worthShowing } = await import("./changesAcross");
const { outgoingWork } = await import("./outgoingWork");

const repo = (over: Partial<RepoChanges>): RepoChanges =>
    ({ repo: `root`, branch: `main`, conflicted: [], staged: [], unstaged: [], ...over }) as RepoChanges;

const remote = (over: { ahead?: number; upstream?: string }) =>
    ({ remote: `origin`, ahead: over.ahead ?? 0, behind: 0, ...(over.upstream === undefined ? {} : { upstream: over.upstream }) }) as never;

const box = (repos: RepoChanges[]) => ({
    sandbox: { id: `sbx-laptop`, name: `Laptop` } as never,
    repos,
    readAt: 1,
    unreachable: false,
});

beforeEach(() => {
    sandboxes.value = [
        { id: `sbx-here`, name: `Desk`, lastSeenAt: `2026-01-01T00:00:00Z` },
        { id: `sbx-laptop`, name: `Laptop`, lastSeenAt: `2026-01-01T00:00:00Z` },
    ];
});

describe("whether the ledger draws at all", () => {
    it("has nowhere to look on an account with one sandbox", () => {
        sandboxes.value = [{ id: `sbx-here`, name: `Desk`, lastSeenAt: `2026-01-01T00:00:00Z` }];
        expect(hasOtherSandboxes.value).toBe(false);
    });

    it("has somewhere to look once a second sandbox has checked in", () => {
        expect(hasOtherSandboxes.value).toBe(true);
    });

    // A sandbox that never announced an address is not a machine holding work: there is nothing to ask.
    it("does not count an unfinished setup", () => {
        sandboxes.value = [
            { id: `sbx-here`, name: `Desk`, lastSeenAt: `2026-01-01T00:00:00Z` },
            { id: `sbx-half`, name: `Half`, lastSeenAt: null },
        ];
        expect(hasOtherSandboxes.value).toBe(false);
    });
});

describe("what one repo's row says", () => {
    // Uncommitted counts BOTH sides git models plus whatever the daemon cut past its budget: a six-figure
    // change list is exactly the case where the number matters and exactly the one where the rows were cut.
    it("counts what a truncated scan dropped, not only what it shipped", () => {
        const [row] = rowsOf(box([repo({ staged: [{ path: `a` }] as never, unstaged: [{ path: `b` }] as never, truncated: 900 })]));
        expect(row?.uncommitted).toBe(902);
    });

    // A halted merge is not work being held. Folding conflicts into this count would report a stuck rebase as
    // unsaved work, which is a different problem with a different fix.
    it("does not fold a halted merge's conflicts into the uncommitted count", () => {
        const [row] = rowsOf(box([repo({ conflicted: [{ path: `a` }, { path: `b` }] as never })]));
        expect(row?.uncommitted).toBe(0);
    });

    // A repo git could not scan reports nothing rather than zero, and says so: `unreadable` is what stops the
    // row claiming the repo is clean on the strength of a scan that failed.
    it("reports an unreadable repo as unknown rather than clean", () => {
        const [row] = rowsOf(box([repo({ repo: `broken`, error: `not a git repository`, staged: [{ path: `a` }] as never })]));
        expect(row).toMatchObject({ unreadable: true, uncommitted: 0 });
    });

    it("carries the box's name, so a row can be read without its heading", () => {
        const [row] = rowsOf(box([repo({ remote: remote({ ahead: 2, upstream: `origin/main` }) })]));
        expect(row).toMatchObject({ sandboxName: `Laptop`, sandboxId: `sbx-laptop`, ahead: 2, publish: false });
    });

    // A branch with a remote configured but nothing tracked on it has never been pushed: git reports no count
    // for it, so the amount is unsayable and the verb is Publish.
    it("marks a branch that has never been published", () => {
        const [row] = rowsOf(box([repo({ remote: remote({}) })]));
        expect(row).toMatchObject({ ahead: 0, publish: true });
    });
});

describe("which rows are worth showing", () => {
    const rowFor = (over: Partial<RepoChanges>) => rowsOf(box([repo(over)]))[0]!;

    // The whole claim of the surface: a row appearing IS the news, so a clean repo on another machine has
    // nothing to say and listing it would bury the ones that do.
    it("drops a clean repo", () => {
        expect(worthShowing(rowFor({ remote: remote({ upstream: `origin/main` }) }))).toBe(false);
    });

    it("keeps a repo with commits that exist on that disk alone", () => {
        expect(worthShowing(rowFor({ remote: remote({ ahead: 1, upstream: `origin/main` }) }))).toBe(true);
    });

    it("keeps a repo with uncommitted work", () => {
        expect(worthShowing(rowFor({ unstaged: [{ path: `a` }] as never, remote: remote({ upstream: `origin/main` }) }))).toBe(true);
    });

    it("keeps a branch nobody has published", () => {
        expect(worthShowing(rowFor({ remote: remote({}) }))).toBe(true);
    });

    // The one row that is kept for saying nothing: a repo that could not be read is exactly the case a silent
    // drop would hide, and the surface's rule is that unknown is never rendered as fine.
    it("keeps a repo git refused to scan", () => {
        expect(worthShowing(rowFor({ error: `not a git repository` }))).toBe(true);
    });

    // A repo with no remote at all cannot be pushed anywhere, so its exposure is whatever is uncommitted in it
    // and nothing more: with a clean tree it has nothing to report.
    it("drops a clean repo that has no remote configured", () => {
        expect(worthShowing(rowFor({ remote: undefined }))).toBe(false);
    });
});

describe("the headline, which is the shared derivation", () => {
    // The ledger asks `outgoingWork` the same question the local panel asks, rather than a second reading of
    // the same fields: the sentence a reader has learned about one box means the same across all of them.
    it("sums commits ahead across repos", () => {
        expect(
            outgoingWork([
                repo({ repo: `root`, remote: remote({ ahead: 3, upstream: `origin/main` }) }),
                repo({ repo: `site`, remote: remote({ ahead: 4, upstream: `origin/main` }) }),
            ]),
        ).toEqual({ commits: 7, repos: 2, publish: false });
    });

    it("leaves an unreadable repo out rather than counting it as clean", () => {
        expect(outgoingWork([repo({ repo: `broken`, error: `not a git repository` })])).toBeUndefined();
    });
});
