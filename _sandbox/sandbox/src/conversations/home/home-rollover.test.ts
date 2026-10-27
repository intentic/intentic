import type { AgentSummary } from "@intentic/sandbox-contract/schemas/agents";
import { unstubbed } from "@intentic/testing";
import type { Services } from "../../composition.js";
import { HOME_WORK_NOTE_TITLE, homeRolloverOf, homeWorkNote, type RolloverBasis } from "./home-rollover.js";

// When a home conversation's next turn opens a fresh session instead of re-reading its old one: the rule, apart from
// the turn that carries it out.

const NOW = 1_800_000_000_000;
const basis = (over: Partial<RolloverBasis> = {}): RolloverBasis => ({
    home: true,
    pending: undefined,
    sessionId: "s1",
    continuing: false,
    contextTokens: 40_000,
    promptCache: { at: NOW - 60_000, ttlMs: 300_000 },
    budget: 150_000,
    now: NOW,
    ...over,
});
const COLD = { at: NOW - 3_600_000, ttlMs: 300_000 };

test("a home under its budget with a warm cache resumes its session", () => {
    expect(homeRolloverOf(basis())).toBeUndefined();
    expect(homeRolloverOf(basis({ contextTokens: 149_999 }))).toBeUndefined();
});

test("a home that reached its budget starts fresh, cache warm or not", () => {
    expect(homeRolloverOf(basis({ contextTokens: 150_000 }))).toBe("budget");
    expect(homeRolloverOf(basis({ contextTokens: 400_000, promptCache: COLD }))).toBe("budget");
});

test("past half its budget, a cold cache is reason enough: resuming would write it all again", () => {
    expect(homeRolloverOf(basis({ contextTokens: 75_000, promptCache: COLD }))).toBe("cold");
    expect(homeRolloverOf(basis({ contextTokens: 74_999, promptCache: COLD }))).toBeUndefined();
    // The expiry edge is kept whole, as the cold trim keeps it.
    expect(homeRolloverOf(basis({ contextTokens: 100_000, promptCache: { at: NOW - 310_000, ttlMs: 300_000 } }))).toBeUndefined();
    // No clock on record is never cold.
    expect(homeRolloverOf(basis({ contextTokens: 100_000, promptCache: undefined }))).toBeUndefined();
});

test("a person's ask wins, with or without a session left to roll", () => {
    expect(homeRolloverOf(basis({ pending: "asked" }))).toBe("asked");
    expect(homeRolloverOf(basis({ pending: "cleared", sessionId: undefined }))).toBe("cleared");
});

test("nothing for another conversation, a turn already opening fresh, a re-run, or a zero budget", () => {
    expect(homeRolloverOf(basis({ home: false, contextTokens: 900_000 }))).toBeUndefined();
    expect(homeRolloverOf(basis({ sessionId: undefined, contextTokens: 900_000 }))).toBeUndefined();
    expect(homeRolloverOf(basis({ continuing: true, contextTokens: 900_000 }))).toBeUndefined();
    expect(homeRolloverOf(basis({ budget: 0, contextTokens: 900_000 }))).toBeUndefined();
    expect(homeRolloverOf(basis({ contextTokens: undefined }))).toBeUndefined();
});

// SAFETY: homeWorkNote reads only id, status, updatedAt, startedBy, fresh, title and archivedAt, which each card sets.
const card = (over: Partial<AgentSummary> & Pick<AgentSummary, "id" | "status" | "updatedAt">): AgentSummary => over as AgentSummary;
// The note reads the registry's list alone; anything else it asked would throw.
const roster = (cards: readonly AgentSummary[]): Pick<Services, "agents"> => ({ agents: unstubbed<Services["agents"]>("agents", { list: () => [...cards] }) });

test("the fresh session is told which subagents it started and where each one's work stands, newest first", () => {
    const agents = roster([
                card({ id: "sub-a", status: "ready", updatedAt: 1, startedBy: "agent:home-x", title: "Fix the parser" }),
                card({ id: "sub-b", status: "running", updatedAt: 3, startedBy: "agent:home-x", title: "Add tests" }),
                card({ id: "rev-a", status: "idle", updatedAt: 2, fresh: { of: "sub-a", kind: "review", by: "home-x", at: 2 } }),
                card({ id: "sub-old", status: "landed", updatedAt: 4, startedBy: "agent:home-x", archivedAt: 5 }),
                card({ id: "elsewhere", status: "running", updatedAt: 9, startedBy: "agent:home-y" }),
    ]);
    const note = homeWorkNote(agents, "home-x");
    expect(note?.title).toBe(HOME_WORK_NOTE_TITLE);
    const lines = note?.text.split("\n").filter((line) => line.startsWith("- "));
    expect(lines).toEqual([
        "- sub-b · Add tests · working",
        "- rev-a (review) · untitled · idle",
        "- sub-a · Fix the parser · finished, its work held on its branch for you to judge and merge",
    ]);
});

test("a home that started nothing still on the board is told nothing", () => {
    expect(homeWorkNote(roster([]), "home-x")).toBeUndefined();
});
