// The scope switcher once listed every conversation that ever had a branch, flat, in roster order, each under the same
// robot: forty rows of near-identical names with nothing to tell them apart. These pin what replaced it.
import type { FleetAgent } from "../../../agents/fleet/useAgents-fleet";
import { copyMatches, SCOPE_WINDOW, scopeGroups, switchableCopies } from "../scopeChoices";

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
