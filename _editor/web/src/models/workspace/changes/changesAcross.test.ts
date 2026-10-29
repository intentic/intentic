import { ref } from "vue";
import type { RepoChanges } from "@intentic/sandbox-contract/schemas/git/git";
import { fakeSandboxRpc } from "../../../testing/sandboxRpcFake";

// Reading of another sandbox's repos: which rows show, and what each says.
// Polling is fleetAcross's pattern, tested there; the network is mocked out here.

const sandboxes = ref<{ id: string; name: string; lastSeenAt: string | null }[]>([]);
const activeSandboxId = ref<string | undefined>(`sbx-here`);
jest.mock("../../../client/sandbox/useSandbox", () => ({ useSandbox: () => ({ sandboxes, activeSandboxId }) }));
jest.mock("../../../client/sandbox/sandboxRpc", () => ({ sandboxRpc: fakeSandboxRpc() }));
jest.mock("../../sandbox/sandboxScreen", () => ({ landOnAfterSwitch: jest.fn() }));
jest.mock("../../../lib/queryPersistence", () => ({ queryClient: { setQueryData: jest.fn() } }));

const { changeBoxes, hasOtherSandboxes, keptRepo, quietOf, rowsOf, worthShowing } = await import("./changesAcross");
const { changesAcrossKey } = await import("../../../app/storage/browserStorage");
const { outgoingWork } = await import("../push/outgoingWork");

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
        { id: `sbx-here`, name: `Home`, lastSeenAt: `2026-01-01T00:00:00Z` },
        { id: `sbx-laptop`, name: `Laptop`, lastSeenAt: `2026-01-01T00:00:00Z` },
    ];
});

describe("whether the ledger draws at all", () => {
    it("has nowhere to look on an account with one sandbox", () => {
        sandboxes.value = [{ id: `sbx-here`, name: `Home`, lastSeenAt: `2026-01-01T00:00:00Z` }];
        expect(hasOtherSandboxes.value).toBe(false);
    });

    it("has somewhere to look once a second sandbox has checked in", () => {
        expect(hasOtherSandboxes.value).toBe(true);
    });

    // lastSeenAt: null means the sandbox never announced an address; nothing to ask yet.
    it("does not count an unfinished setup", () => {
        sandboxes.value = [
            { id: `sbx-here`, name: `Home`, lastSeenAt: `2026-01-01T00:00:00Z` },
            { id: `sbx-half`, name: `Half`, lastSeenAt: null },
        ];
        expect(hasOtherSandboxes.value).toBe(false);
    });
});

describe("what one repo's row says", () => {
    it("counts what a truncated scan dropped on either side, not only what it shipped", () => {
        const [row] = rowsOf(
            box([repo({ staged: [{ path: `a` }] as never, unstaged: [{ path: `b` }] as never, truncated: { staged: 400, unstaged: 500 } })]),
        );
        expect(row?.uncommitted).toBe(902);
    });

    it("does not fold a halted merge's conflicts into the uncommitted count", () => {
        const [row] = rowsOf(box([repo({ conflicted: [{ path: `a` }, { path: `b` }] as never })]));
        expect(row?.uncommitted).toBe(0);
    });

    it("reports an unreadable repo as unknown rather than clean", () => {
        const [row] = rowsOf(box([repo({ repo: `broken`, error: `not a git repository`, staged: [{ path: `a` }] as never })]));
        expect(row).toMatchObject({ unreadable: true, uncommitted: 0 });
    });

    it("carries the box's name, so a row can be read without its heading", () => {
        const [row] = rowsOf(box([repo({ remote: remote({ ahead: 2, upstream: `origin/main` }) })]));
        expect(row).toMatchObject({ sandboxName: `Laptop`, sandboxId: `sbx-laptop`, ahead: 2, publish: false });
    });

    // remote({}) has no upstream tracked, so ahead is unsayable and publish is the verb.
    it("marks a branch that has never been published", () => {
        const [row] = rowsOf(box([repo({ remote: remote({}) })]));
        expect(row).toMatchObject({ ahead: 0, publish: true });
    });
});

describe("which rows are worth showing", () => {
    const rowFor = (over: Partial<RepoChanges>) => rowsOf(box([repo(over)]))[0]!;

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

    it("keeps a repo git refused to scan", () => {
        expect(worthShowing(rowFor({ error: `not a git repository` }))).toBe(true);
    });

    it("drops a clean repo that has no remote configured", () => {
        expect(worthShowing(rowFor({ remote: undefined }))).toBe(false);
    });
});

describe("the headline, which is the shared derivation", () => {
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

// A sandbox asleep on its own computer read as "isn't answering" beside the ones that were broken, and after a reload
// what it held was unknown, though nothing changes in a stopped sandbox (2026-10-29).
describe("a box that is quiet, and why", () => {
    const seen = `2026-10-29T09:00:00.000Z`;
    const sleeping = { id: `sbx-laptop`, name: `Laptop`, hosted: null, sleep: { heardAt: seen, wakeable: true } };
    // SAFETY: quietOf reads the box's sandbox (id, hosted, sleep), readAt and answered, which every case names.
    const quiet = (over: object) => quietOf({ ...box([]), ...over } as never)?.answer;

    it("names a box that should answer and does not", () => {
        expect(quiet({ sandbox: { id: `sbx-laptop`, name: `Laptop`, hosted: null, sleep: null }, answered: false, unreachable: true })).toBe(`not-answering`);
    });

    it("says asleep, not broken, for a sleeper it has never read, and whether its computer can start it", () => {
        expect(quiet({ sandbox: sleeping, readAt: undefined, answered: false })).toBe(`asleep`);
        expect(quiet({ sandbox: { ...sleeping, sleep: { heardAt: seen, wakeable: false } }, readAt: undefined })).toBe(`unwakeable`);
    });

    it("needs no line for a sleeper whose last holdings are known, or a box that answered", () => {
        expect(quiet({ sandbox: sleeping, readAt: 1, answered: false })).toBeUndefined();
        expect(quiet({ sandbox: sleeping, readAt: 1, answered: true })).toBeUndefined();
    });

    it("keeps a repo's counts and none of its file lists", () => {
        // SAFETY: keptRepo only counts the lists; a row's other fields are never read.
        const files = [{ path: `a.ts` }, { path: `b.ts` }] as never;
        const kept = keptRepo(repo({ staged: files, unstaged: files, truncated: { staged: 3, unstaged: 0 }, remote: remote({ ahead: 2, upstream: `origin/main` }) }));
        expect([kept.staged, kept.unstaged, kept.truncated]).toEqual([[], [], { staged: 5, unstaged: 2 }]);
        expect(rowsOf(box([kept]))[0]).toMatchObject({ uncommitted: 7, ahead: 2 });
    });

    it("starts a box not read on this page from what it last held here", () => {
        // A box no earlier case has looked at, since what is kept is read once per page.
        localStorage.setItem(changesAcrossKey(`sbx-desk`), JSON.stringify({ readAt: 42, repos: [keptRepo(repo({ remote: remote({ ahead: 1, upstream: `origin/main` }) }))] }));
        sandboxes.value = [...sandboxes.value, { id: `sbx-desk`, name: `Desk`, lastSeenAt: `2026-01-01T00:00:00Z` }];
        const laptop = changeBoxes.value.find((entry) => entry.sandbox.id === `sbx-desk`);
        expect(laptop?.readAt).toBe(42);
        expect(laptop?.answered).toBeUndefined();
        expect(rowsOf(laptop!).map((row) => row.ahead)).toEqual([1]);
    });
});
