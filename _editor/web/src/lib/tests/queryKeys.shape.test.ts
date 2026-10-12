import { partialMatchKey } from "@tanstack/vue-query";

// `of()` and `ofSandbox()` must produce the same key shape, since sandboxQueryPredicate finds a box's entries by
// reading the id off the last position. The scoping rule is mocked to a fixed id so keys can be spelled out in full.
jest.mock("../activeSandbox", () => ({ sandboxKey: (...parts: unknown[]) => [...parts, `sbx-here`] }));

const { agentReviewPrefixes, AGENTS, APPS, pushedKeys, rpcKey, rpcKeyAt, rpcPrefix, WORKSPACE_STATE, workingReviewKeys } = await import(
    "../queryKeys"
);
const { sandboxQueryPredicate } = await import("../../features/sandbox/live/systemEventRouting");

// A contract read is filed under its route name, then its input, then any storage mark, and the box last, so the same
// sweep and the same prefix rules hold for it as for a family.
describe("rpcKey", () => {
    it("files a read under its route name and input, the box last", () => {
        expect(rpcKey(`git.log`, { repo: `app` })).toEqual([`git.log`, { repo: `app` }, `sbx-here`]);
        expect(rpcKey(`settings.get`)).toEqual([`settings.get`, `sbx-here`]);
        expect(rpcKey(`agents.fileDiff`, { id: `a1`, repo: `root`, path: `src/app.ts` }, `unpersisted`)).toEqual([
            `agents.fileDiff`,
            { id: `a1`, repo: `root`, path: `src/app.ts` },
            `unpersisted`,
            `sbx-here`,
        ]);
    });

    it("names another box in the active one's place, and collapses onto rpcKey for the active one", () => {
        expect(rpcKeyAt(`sbx-laptop`, `agents.diff`, { id: `a1` })).toEqual([`agents.diff`, { id: `a1` }, `sbx-laptop`]);
        expect(rpcKeyAt(`sbx-here`, `agents.diff`, { id: `a1` })).toEqual(rpcKey(`agents.diff`, { id: `a1` }));
    });

    it("is swept with the box it names, and reached by its route's prefix from every box", () => {
        const laptop = sandboxQueryPredicate(`sbx-laptop`);
        expect(laptop({ queryKey: rpcKeyAt(`sbx-laptop`, `git.changes`) })).toBe(true);
        expect(laptop({ queryKey: rpcKey(`git.changes`) })).toBe(false);
        expect(rpcPrefix(`git.changes`)).toEqual([`git.changes`]);
        for (const key of [rpcKey(`git.changes`), rpcKeyAt(`sbx-laptop`, `git.changes`)]) {
            expect(key.slice(0, 1)).toEqual([...rpcPrefix(`git.changes`)]);
        }
    });
});

// The daemon's tables name cache entries (`settings`, `rule-firings`); a push must reach what an extension files under
// that name AND the app's own read of the route the name stands for, and nothing else in that route's group.
describe("pushedKeys", () => {
    it("reaches the name itself, then the reads it stands for", () => {
        expect(pushedKeys([`settings`])).toEqual([[`settings`], [`settings.get`]]);
        expect(pushedKeys([`rule-firings`])).toEqual([[`rule-firings`], [`settings.firings`]]);
        expect(pushedKeys([`secrets`])).toEqual([[`secrets`], [`secrets.list`], [`secrets.inventory`], [`secrets.gates`]]);
    });

    it("reads a runtime path joined, and the working tree's review whole", () => {
        expect(pushedKeys([`git`, `changes`])).toEqual([[`git`, `changes`], ...workingReviewKeys]);
        expect(workingReviewKeys).toEqual([[`git.changes`], [`git.fileDiff`]]);
    });

    it("passes a name the app reads nothing under straight through, for the extension that does", () => {
        expect(pushedKeys([`environment`])).toEqual([[`environment`]]);
    });

    it("reaches the reads a pack keys by procedure from a name only its manifest binds", () => {
        expect(pushedKeys([`approvals`])).toEqual([[`approvals`], [`approvals.list`], [`approvals.hookRequests`], [`automations.pendingList`]]);
        expect(pushedKeys([`automation-approvals`])).toEqual([[`automation-approvals`], [`automations.pendingList`]]);
        expect(pushedKeys([`public`])).toEqual([[`public`], [`public.list`]]);
    });
});

describe("ofSandbox", () => {
    it("puts the named box where sandboxKey puts the active one: last", () => {
        expect(AGENTS.of()).toEqual([`agents`, `sbx-here`]);
        expect(AGENTS.ofSandbox(`sbx-laptop`)).toEqual([`agents`, `sbx-laptop`]);
    });

    // A variant lands before the id in both, so a transcript in one box is its own entry, not a prefix-match collision.
    it("keeps a variant ahead of the id, exactly as of() does", () => {
        expect(AGENTS.of(`a1`, `transcript`)).toEqual([`agents`, `a1`, `transcript`, `sbx-here`]);
        expect(AGENTS.ofSandbox(`sbx-laptop`, `a1`, `transcript`)).toEqual([`agents`, `a1`, `transcript`, `sbx-laptop`]);
    });

    // A wiped/recreated sandbox drops everything this browser remembered about it, by predicate; a cross-sandbox entry
    // must be swept the same way, or the ledger keeps painting a workspace that's gone.
    it("is found by the sweep that drops one sandbox's cached state", () => {
        const laptop = sandboxQueryPredicate(`sbx-laptop`);
        expect(laptop({ queryKey: WORKSPACE_STATE.ofSandbox(`sbx-laptop`) })).toBe(true);
        expect(laptop({ queryKey: WORKSPACE_STATE.ofSandbox(`sbx-guest`) })).toBe(false);
        expect(laptop({ queryKey: WORKSPACE_STATE.of() })).toBe(false);
    });

    // Naming the active box produces the identical key, not a second cache entry for the same data.
    it("collapses onto of() when it names the active sandbox", () => {
        expect(AGENTS.ofSandbox(`sbx-here`, `a1`, `transcript`)).toEqual(AGENTS.of(`a1`, `transcript`));
    });

    // `every` still reaches every box's entries, so a write in one sandbox invalidates that sandbox's copy too.
    it("leaves the family-wide prefix reaching across every box", () => {
        expect(WORKSPACE_STATE.every).toEqual([`workspace`, `state`]);
        for (const key of [WORKSPACE_STATE.of(), WORKSPACE_STATE.ofSandbox(`sbx-laptop`)]) {
            expect(key.slice(0, WORKSPACE_STATE.every.length)).toEqual([...WORKSPACE_STATE.every]);
        }
    });
});

// An agent's review is three reads (its diff, the file diffs opened from it, where its landed work went) that the
// workspace's own writes make stale together; the transcript, the expensive read, is never one of them.
describe("agentReviewPrefixes", () => {
    const reached = (key: readonly unknown[]): boolean => agentReviewPrefixes.some((prefix) => partialMatchKey([...key], [...prefix]));

    it("reaches any agent's review in any box, the file diffs opened from it included", () => {
        expect(reached(rpcKey(`agents.diff`, { id: `a1` }))).toBe(true);
        expect(reached(rpcKeyAt(`sbx-laptop`, `agents.diff`, { id: `a2` }))).toBe(true);
        expect(reached(rpcKey(`agents.fileDiff`, { id: `a1`, repo: `root`, path: `src/app.ts` }, `unpersisted`))).toBe(true);
        expect(reached(rpcKey(`agents.history`, { id: `a1` }))).toBe(true);
    });

    it("leaves the rest of what is cached about an agent alone", () => {
        expect(reached(AGENTS.of(`a1`, `transcript`))).toBe(false);
        expect(reached(rpcKey(`agents.systemPrompt`, { id: `a1` }))).toBe(false);
        expect(reached(rpcKey(`git.changes`))).toBe(false);
    });
});

// Two readers that picked one name stored two shapes under one entry: the automations and workflows packs both keyed
// `personas` (the whole answer, and a bare list), and the preview list's `apps` key equalled a pack's one-repo read
// whenever there was exactly one monorepo. A contract read is now keyed by its procedure on both sides, and the preview
// list's repos ride as one element no key of plain names can equal.
describe("keys that used to collide", () => {
    // What `api.sandbox.key(...parts)` hands a pack: plain names, then the box.
    const packKey = (...parts: string[]): unknown[] => [...parts, `sbx-here`];

    it("files a pack's persona read and the shell's under the one procedure key", () => {
        expect(rpcKey(`personas.list`)).toEqual([`personas.list`, `sbx-here`]);
        expect(rpcKey(`personas.list`)).not.toEqual(packKey(`personas`));
    });

    it("never lets the preview list's apps equal one repo's read, by name or by procedure", () => {
        expect(APPS.of([`web`])).toEqual([`apps`, [`web`], `sbx-here`]);
        expect(APPS.of([`web`])).not.toEqual(packKey(`apps`, `web`));
        expect(rpcKey(`workspace.appsList`, { repo: `web` })).toEqual([`workspace.appsList`, { repo: `web` }, `sbx-here`]);
    });

    it("refreshes both from the dev-server push, and the CI board and automations from theirs", () => {
        const reached = (name: string, key: unknown[]): boolean => pushedKeys([name]).some((path) => partialMatchKey(key, [...path]));
        expect(reached(`apps`, APPS.of([`web`, `docs`]))).toBe(true);
        expect(reached(`apps`, rpcKey(`workspace.appsList`, { repo: `web` }))).toBe(true);
        expect(reached(`ci-runs`, rpcKey(`ci.runs`))).toBe(true);
        expect(reached(`automations`, rpcKey(`automations.list`))).toBe(true);
        expect(reached(`personas`, rpcKey(`personas.list`))).toBe(true);
        expect(reached(`settings`, rpcKey(`settings.get`))).toBe(true);
    });

    it("refreshes the shell's ports and outbox and the preview extension's, one entry each, from one push", () => {
        const reached = (name: string, key: unknown[]): boolean => pushedKeys([name]).some((path) => partialMatchKey(key, [...path]));
        expect(reached(`ports`, rpcKey(`ports.list`))).toBe(true);
        expect(reached(`public`, rpcKey(`public.list`))).toBe(true);
        expect(reached(`activity-status`, rpcKey(`activity.status`))).toBe(true);
    });
});
