import type { LoopRecord } from "@intentic/sandbox-contract/schemas/loops";
import type { LandStanding } from "../land/standing.js";
import { isolatedAgent } from "../registry/agents-store.testing.js";
import type { PersistedAgent } from "../registry/agents-store.js";
import { fleetLoopOf, stoppedUnlanded, unlandedBefore, unlandedWorkChore, withLoops } from "./fleet-left-off.js";

const NOW = 1_800_000_000_000;
const DAY_AGO = NOW - 25 * 3_600_000;

const deps = (standing: LandStanding, running = false) => ({
    agents: { standingOf: () => standing },
    conversations: { running: () => running },
});

// 2026-11-19: stopped, unlanded work sat on its branch until the owner happened to remember it.
describe("stoppedUnlanded", () => {
    const stopped = isolatedAgent([], { id: "jet-dewt", updatedAt: DAY_AGO });
    const before = unlandedBefore(24, NOW);

    test.each<LandStanding>(["ready", "conflict"])("work %s to land, idle past the window, is forgotten work", (standing) => {
        expect(stoppedUnlanded(deps(standing), stopped, before)).toBe(true);
    });

    test("work that landed, or never was, is not", () => {
        expect(stoppedUnlanded(deps("landed"), stopped, before)).toBe(false);
        expect(stoppedUnlanded(deps("idle"), stopped, before)).toBe(false);
    });

    test("work still being done, or touched inside the window, is not", () => {
        expect(stoppedUnlanded(deps("ready", true), stopped, before)).toBe(false);
        expect(stoppedUnlanded(deps("ready"), { ...stopped, updatedAt: NOW - 3_600_000 }, before)).toBe(false);
    });

    test("a subagent's work is its parent's to land", () => {
        const child = isolatedAgent([], { id: "bison-gbq3", updatedAt: DAY_AGO, placement: { kind: "worktree", branch: "agent/bison-gbq3", repos: [], parent: "jet-dewt" } });
        expect(stoppedUnlanded(deps("ready"), child, before)).toBe(false);
    });
});

const record = (state: LoopRecord["state"]): LoopRecord => ({
    conversationId: "rhino-pvf5",
    goal: "`make check` exits 0.",
    prompt: "Take the next open item.",
    context: "fresh",
    output: { kind: "claim" },
    checks: [{ kind: "command", command: "make check" }],
    maxIterations: 10,
    stallLimit: 2,
    isolated: true,
    state,
    startedAt: 1,
    resumed: 0,
    iterations: [{ n: 1, at: 2, outcome: "continue", changed: true, detail: "group 7 landed", remaining: 4 }],
});

test("a loop reads as its round, its count, what ends it and what the last round said", () => {
    expect(fleetLoopOf(record("running"))).toEqual({ state: "running", round: 1, max: 10, remaining: 4, until: "make check", last: "group 7 landed" });
});

test("only a running loop rides on its roster row", () => {
    const rows = [{ id: "rhino-pvf5" }, { id: "jet-dewt" }];
    expect(withLoops(rows, [record("running")])).toEqual([{ id: "rhino-pvf5", loop: fleetLoopOf(record("running")) }, { id: "jet-dewt" }]);
    expect(withLoops(rows, [record("done")])).toEqual(rows);
});

test("once a day the operators are told how much live work sits stopped and never landed, and nothing when none does", async () => {
    const entries: readonly PersistedAgent[] = [
        isolatedAgent([], { id: "jet-dewt", updatedAt: DAY_AGO }),
        isolatedAgent([], { id: "bison-gbq3", updatedAt: DAY_AGO, archivedAt: DAY_AGO }),
        isolatedAgent([], { id: "rhino-pvf5", updatedAt: NOW - 60_000 }),
    ];
    const told: [number, number][] = [];
    const chore = (standing: LandStanding) =>
        unlandedWorkChore({
            agents: { ids: () => entries.map((entry) => entry.id), entry: (id) => entries.find((entry) => entry.id === id), standingOf: () => standing },
            conversations: { running: () => false },
            tell: async (count, hours) => {
                told.push([count, hours]);
            },
            logger: { info: () => undefined },
            now: () => NOW,
        });
    expect(chore("ready").everyMs).toBe(24 * 3_600_000);
    await chore("ready").run();
    // The archived one and the one touched a minute ago are not counted.
    expect(told).toEqual([[1, 24]]);
    await chore("landed").run();
    expect(told).toEqual([[1, 24]]);
});
