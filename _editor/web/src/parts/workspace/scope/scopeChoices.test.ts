// The scope switcher once listed every conversation that ever had a branch, flat, in roster order, each under the same
// robot: forty rows of near-identical names with nothing to tell them apart. These pin what replaced it.
import type { FleetAgent } from "../../../models/fleet/useAgents-fleet";
import { BRANCH_WINDOW, branchChoices, branchGroups, copyMatches, SCOPE_WINDOW, scopeGroups, switchableCopies } from "./scopeChoices";

const NONE = { plan: false, question: false, permission: false, capability: false, credential: false, conflict: false };

const copy = (id: string, over: Partial<FleetAgent> = {}): FleetAgent => ({
    id,
    title: `Conversation ${id}`,
    status: `landed`,
    provider: `claude`,
    harness: `claude-code`,
    branch: `agent/${id}`,
    updatedAt: 1_000,
    attention: NONE,
    open: false,
    unread: false,
    unsent: false,
    ...over,
});

// Copies in one lane, given oldest first so the switcher's own order has something to undo: f0 is the most recent.
const many = (count: number, over: Partial<FleetAgent> = {}): FleetAgent[] =>
    Array.from({ length: count }, (_, i) => copy(`f${i}`, { updatedAt: 10_000 - i, ...over })).toReversed();

const ids = (agents: readonly FleetAgent[] | undefined): string[] => (agents ?? []).map((agent) => agent.id);

describe(`which copies the switcher offers`, () => {
    it(`keeps conversations with a checkout of their own in this sandbox`, () => {
        const offered = switchableCopies([copy(`a`), copy(`b`, { branch: undefined }), copy(`c`, { sandboxId: `elsewhere` })]);

        expect(ids(offered)).toEqual([`a`]);
    });
});

describe(`the switcher's groups`, () => {
    it(`files copies under the board's lanes`, () => {
        const groups = scopeGroups([copy(`done`), copy(`asks`, { status: `awaiting` }), copy(`runs`, { status: `running` })], { current: undefined });

        expect(groups.map((group) => [group.lane, ids(group.agents)])).toEqual([
            [`attention`, [`asks`]],
            [`active`, [`runs`]],
            [`finished`, [`done`]],
        ]);
    });

    // The board orders Active by when each turn started; a switcher that did the same would put the newest copy last.
    it(`puts the latest activity first in every lane`, () => {
        const [group] = scopeGroups(
            [
                copy(`started-first`, { status: `running`, startedAt: 1, updatedAt: 5 }),
                copy(`started-later`, { status: `running`, startedAt: 2, updatedAt: 9 }),
            ],
            { current: undefined },
        );

        expect(ids(group?.agents)).toEqual([`started-later`, `started-first`]);
    });

    it(`leaves out a lane with nothing in it`, () => {
        expect(scopeGroups([copy(`done`)], { current: undefined }).map((group) => group.lane)).toEqual([`finished`]);
    });

    it(`folds a long lane to its latest few and counts the rest`, () => {
        const [group] = scopeGroups(many(SCOPE_WINDOW + 30), { current: undefined });

        expect(group?.agents).toHaveLength(SCOPE_WINDOW);
        expect(group?.agents[0]?.id).toBe(`f0`);
        expect(group?.hidden).toBe(30);
    });

    // A failed fan-out drops a dozen children into Attention at once: that lane folds as Finished does.
    it(`folds a crowded Attention lane too`, () => {
        const [group] = scopeGroups(many(SCOPE_WINDOW + 9, { status: `error` }), { current: undefined });

        expect(group?.lane).toBe(`attention`);
        expect(group?.hidden).toBe(9);
    });

    it(`keeps the copy on screen listed even past the fold`, () => {
        const [group] = scopeGroups(many(SCOPE_WINDOW + 30), { current: `f20` });

        expect(ids(group?.agents)).toContain(`f20`);
        expect(group?.hidden).toBe(29);
    });

    it(`lists every copy of a lane once it is unfolded, and only that lane`, () => {
        const groups = scopeGroups(
            [...many(SCOPE_WINDOW + 3), ...many(SCOPE_WINDOW + 2, { status: `running` }).map((agent) => ({ ...agent, id: `r-${agent.id}` }))],
            {
                current: undefined,
                unfolded: new Set([`finished`]),
            },
        );

        expect(groups.map((group) => [group.lane, group.hidden])).toEqual([
            [`active`, 2],
            [`finished`, 0],
        ]);
    });

    it(`searches past the fold, by every word typed`, () => {
        const copies = [...many(SCOPE_WINDOW + 10), copy(`old`, { title: `Workspace changes view`, updatedAt: 1 })];

        const [group] = scopeGroups(copies, { current: undefined, query: `CHANGES  workspace` });

        expect(ids(group?.agents)).toEqual([`old`]);
        expect(group?.hidden).toBe(0);
    });

    it(`says nothing when no copy matches`, () => {
        expect(scopeGroups(many(3), { current: undefined, query: `nothing like it` })).toEqual([]);
    });
});

describe(`what a query matches`, () => {
    it(`reads the branch as well as the title`, () => {
        expect(copyMatches({ title: `Push button changes`, branch: `agent/x9k2` }, `x9k`)).toBe(true);
        expect(copyMatches({ title: undefined, branch: `agent/x9k2` }, `agent`)).toBe(true);
        expect(copyMatches({ title: `Push button changes`, branch: `agent/x9k2` }, `pull`)).toBe(false);
    });
});

describe(`the branches the switcher offers`, () => {
    const local = (name: string, at: number, current = false) => ({ name, current, at });
    const seen = (remote: string, branch: string, at: number) => ({ remote, branch, at });

    it(`lists a repository's other branches newest first, leaving out its main line and the agents' own`, () => {
        const listing = {
            branches: [local(`main`, 50, true), local(`feature/login`, 40), local(`agent/c-1`, 90), local(`release`, 60)],
            remotes: [],
        };

        expect(branchChoices(`root`, listing).map((choice) => choice.branch)).toEqual([`release`, `feature/login`]);
    });

    it(`folds a remote copy of a local branch into it, keeps a remote-only one once by its short name, and drops the remotes' main and HEAD`, () => {
        const listing = {
            branches: [local(`main`, 50, true), local(`feature/login`, 40)],
            remotes: [seen(`origin`, `main`, 50), seen(`origin`, `HEAD`, 50), seen(`origin`, `feature/login`, 45), seen(`origin`, `fix/typo`, 70), seen(`fork`, `fix/typo`, 20)],
        };

        expect(branchChoices(`web`, listing)).toEqual([
            { repo: `web`, branch: `fix/typo`, at: 70, remote: `origin` },
            { repo: `web`, branch: `feature/login`, at: 40 },
        ]);
    });

    // The daemon makes a local branch from origin's tip only, so a branch no other place holds is nothing to view or start from.
    it(`offers a remote-only branch from origin alone`, () => {
        const listing = { branches: [local(`main`, 50, true)], remotes: [seen(`upstream`, `topic`, 60), seen(`fork`, `wip`, 55), seen(`origin`, `ready`, 30)] };

        expect(branchChoices(`web`, listing).map((choice) => choice.branch)).toEqual([`ready`]);
    });

    it(`also leaves out the main line a repository was moved off, when the changes name it`, () => {
        const listing = { branches: [local(`hotfix`, 50, true), local(`main`, 40), local(`next`, 30)], remotes: [] };

        expect(branchChoices(`root`, listing, `main`).map((choice) => choice.branch)).toEqual([`next`]);
    });

    it(`groups by repository in the order given, folds each to its newest few, and keeps the branch on screen`, () => {
        const choices = [
            ...Array.from({ length: BRANCH_WINDOW + 3 }, (_, i) => ({ repo: `root`, branch: `b${i}`, at: 100 - i })),
            { repo: `apps/web`, branch: `web-only`, at: 1 },
        ];
        const groups = branchGroups(choices, { current: { repo: `root`, branch: `b${BRANCH_WINDOW + 2}` } });

        expect(groups.map((group) => group.repo)).toEqual([`root`, `apps/web`]);
        expect(groups[0]?.branches).toHaveLength(BRANCH_WINDOW + 1);
        expect(groups[0]?.branches.at(-1)?.branch).toBe(`b${BRANCH_WINDOW + 2}`);
        expect(groups[0]?.hidden).toBe(2);
        expect(branchGroups(choices, { current: undefined, unfolded: new Set([`root`]) })[0]?.hidden).toBe(0);
    });

    it(`searches every branch, folded or not, by name or repository`, () => {
        const choices = [
            ...Array.from({ length: BRANCH_WINDOW + 3 }, (_, i) => ({ repo: `root`, branch: `b${i}`, at: 100 - i })),
            { repo: `apps/web`, branch: `login`, at: 1 },
        ];

        expect(branchGroups(choices, { current: undefined, query: `b${BRANCH_WINDOW + 2}` }).flatMap((group) => group.branches.map((choice) => choice.branch))).toEqual([
            `b${BRANCH_WINDOW + 2}`,
        ]);
        expect(branchGroups(choices, { current: undefined, query: `web log` }).map((group) => group.repo)).toEqual([`apps/web`]);
    });
});

