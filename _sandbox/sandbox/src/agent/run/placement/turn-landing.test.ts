import type { Rule } from "@intentic/sandbox-contract";
import { unstubbed } from "@intentic/testing";
import type { LandOutcome } from "../../../conversations/land/land.js";
import { services } from "../../../harness/route-services.testing.js";
import { beginTurn } from "../../../testing.js";
import {
    type LandBooks,
    type LandingDecision,
    landedFrame,
    landedOutcomeOf,
    landingDecision,
    type LandingDeps,
    type LandingHooks,
    landTurn,
} from "./turn-landing.js";

const hold: Rule = {
    id: "hold-all",
    label: "Hold everything",
    moment: "agent.finished",
    action: { kind: "verdict", verdict: "hold" },
    enabled: true,
};
const allow: Rule = {
    id: "allow-all",
    label: "Land everything",
    moment: "agent.finished",
    action: { kind: "verdict", verdict: "allow" },
    enabled: true,
};
// Written when a check could still hold work; a turn that reaches its land always ended clean now, so this matches none.
const allowRed: Rule = { ...allow, id: "allow-red", label: "Land red work", when: { outcome: ["checks-failed"] } };

// No check takes part: checks run over the main tree after the work lands, and never hold it (verify-deps.ts).
describe("a land decision", () => {
    const decisions: [string, readonly Rule[], boolean | undefined, LandingDecision][] = [
        ["with no rule and no override holds, quietly", [], undefined, { mode: "measure", writes: [] }],
        ["with the override on lands, whatever the table says", [hold], true, { mode: "check", writes: [] }],
        ["with the override off holds, quietly", [allow], false, { mode: "measure", writes: [] }],
        ["under an allowing rule lands, and stamps it", [allow], undefined, { mode: "check", writes: [{ kind: "fired", rule: "allow-all" }] }],
        [
            "under a holding rule holds, stamps it and says so",
            [hold],
            undefined,
            {
                mode: "measure",
                writes: [
                    { kind: "fired", rule: "hold-all" },
                    { kind: "held", content: '"Hold everything" held this work on its branch instead of landing it.' },
                ],
            },
        ],
        [
            "under a rule naming the retired red outcome is decided by the rest of the table",
            [allowRed, hold],
            undefined,
            {
                mode: "measure",
                writes: [
                    { kind: "fired", rule: "hold-all" },
                    { kind: "held", content: '"Hold everything" held this work on its branch instead of landing it.' },
                ],
            },
        ],
        ["with the override on lands past a rule naming the retired red outcome", [allowRed], true, { mode: "check", writes: [] }],
    ];
    test.each(decisions)("%s", (_case, rules, override, decision) => {
        expect(landingDecision(rules, { repos: ["root"], outcome: "clean" }, override)).toStrictEqual(decision);
    });
});

const outcome = (change: Partial<LandOutcome>): LandOutcome => ({
    landed: false,
    changed: true,
    repos: [],
    diff: { files: 1, insertions: 1, deletions: 0 },
    adjudicated: false,
    ...change,
});

test.each([
    ["held on its branch", outcome({ held: true }), "ready"],
    ["in the main tree", outcome({ landed: true }), "landed"],
    ["neither", outcome({}), "conflict"],
] as const)("a changed land that is %s settles as %s", (_case, landed, settled) => {
    expect(landedOutcomeOf(landed)).toBe(settled);
});

describe("the landed frame", () => {
    test("says what reached the tree and what the reconciler started", () => {
        expect(landedFrame(outcome({ landed: true }), { missing: 2, started: ["web"], deferred: false })).toStrictEqual({
            kind: "landed",
            landed: true,
            deps: { missing: 2, started: ["web"], deferred: false },
        });
    });

    test("names the conflicts and the hold, and nothing it does not have", () => {
        const conflicts = [{ repo: "root", paths: [{ path: "app.ts", reason: "diverged" as const }], clean: 0 }];
        expect(landedFrame(outcome({ conflicts }), undefined)).toStrictEqual({ kind: "landed", landed: false, conflicts });
        expect(landedFrame(outcome({ held: true }), undefined)).toStrictEqual({ kind: "landed", landed: false, held: true });
    });
});

describe("a turn that may not land", () => {
    // Only the registry is real: any other store the land reached for would name itself.
    const registered = async (isolated: boolean): Promise<LandingDeps> => {
        const { agents, conversations } = services();
        await beginTurn(conversations, { conversationId: "c", isolated, prompt: "p", profile: { agent: "claude", harness: "native" }, byPerson: true }, 1);
        return unstubbed<LandingDeps>("deps", { agents, conversations });
    };
    const hooks = unstubbed<LandingHooks>("hooks", {});
    const books = (): LandBooks => ({ span: [{ repo: "root", from: "a", dir: "/w" }], branch: "agent/c", outcome: undefined, reconciled: false });
    const drain = async (frames: AsyncIterable<unknown>): Promise<unknown[]> => {
        const out: unknown[] = [];
        for await (const frame of frames) {
            out.push(frame);
        }
        return out;
    };
    test.each([
        ["because it failed", { failed: true, aborted: false }],
        ["because it was stopped", { failed: false, aborted: true }],
    ] as const)("%s lands nothing and reconciles nothing", async (_case, ending) => {
        const deps = await registered(true);
        const kept = books();
        const frames = await drain(
            landTurn(deps, hooks, { conversationId: "c", prompt: "p", autoLand: true, sync: async () => [], ...ending }, kept),
        );
        expect(frames).toStrictEqual([]);
        expect(kept).toStrictEqual(books());
    });

    // Auto-land is on and no rule holds anything, so only the armed watch can be what stops this land: past the guard,
    // the unstubbed settings store would name itself. Which jobs count as armed is background-jobs.test.ts's to pin.
    test("because it ended to wait on a watch it armed lands nothing and reconciles nothing", async () => {
        const deps = await registered(true);
        deps.conversations.send("c", {
            kind: "watches-shown",
            watches: [{ id: "watch-a1b2", note: "CI on the pushed branch", intervalSeconds: 60, deadlineAt: 9_000 }],
        });
        const kept = books();
        const turn = { conversationId: "c", prompt: "p", autoLand: true, failed: false, aborted: false, sync: async () => [] };
        expect(await drain(landTurn(deps, hooks, turn, kept))).toStrictEqual([]);
        expect(kept).toStrictEqual(books());
    });

    test("once nothing is armed, the same turn goes on to its land", async () => {
        const deps = await registered(true);
        deps.conversations.send("c", { kind: "watches-shown", watches: [] });
        const turn = { conversationId: "c", prompt: "p", autoLand: true, failed: false, aborted: false, sync: async () => [] };
        await expect(drain(landTurn(deps, hooks, turn, books()))).rejects.toThrow("deps.sandboxSettings.get was called, and this test did not stub it");
    });

    test("because the conversation is not isolated lands nothing either", async () => {
        const kept = books();
        const turn = { conversationId: "c", prompt: "p", autoLand: true, failed: false, aborted: false, sync: async () => [] };
        expect(await drain(landTurn(await registered(false), hooks, turn, kept))).toStrictEqual([]);
        expect(kept).toStrictEqual(books());
    });
});
