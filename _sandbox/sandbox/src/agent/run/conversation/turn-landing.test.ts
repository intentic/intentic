import type { Rule } from "@intentic/sandbox-contract";
import { describe, expect, test } from "bun:test";
import { unstubbed } from "@intentic/testing";
import type { LandOutcome } from "../../../agents/land/land.js";
import { checkRunOf } from "../../verification/turn-checks.js";
import { services } from "../../../harness/route-services.testing.js";
import { beginTurn } from "../../../testing.js";
import { type LandBooks, type LandingDecision, landedFrame, landedOutcomeOf, landingDecision, type LandingDeps, type LandingHooks, landTurn } from "./turn-landing.js";

const hold: Rule = { id: "hold-all", label: "Hold everything", moment: "agent.finished", action: { kind: "verdict", verdict: "hold" }, enabled: true };
const allow: Rule = { id: "allow-all", label: "Land everything", moment: "agent.finished", action: { kind: "verdict", verdict: "allow" }, enabled: true };
const allowRed: Rule = { ...allow, id: "allow-red", label: "Land red work", when: { outcome: ["checks-failed"] } };
const suite = { ruleId: "suite", label: "Run the suite", command: "pnpm test", status: "failed" as const, at: 1 };

describe("a land decision", () => {
    const decisions: [string, readonly Rule[], "clean" | "checks-failed", boolean | undefined, LandingDecision][] = [
        ["with no rule and no override holds, quietly", [], "clean", undefined, { mode: "measure", writes: [] }],
        ["with the override on lands, whatever the table says", [hold], "clean", true, { mode: "check", writes: [] }],
        ["with the override off holds, quietly", [allow], "clean", false, { mode: "measure", writes: [] }],
        ["under an allowing rule lands, and stamps it", [allow], "clean", undefined, { mode: "check", writes: [{ kind: "fired", rule: "allow-all" }] }],
        [
            "under a holding rule holds, stamps it and says so",
            [hold],
            "clean",
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
            "after the turn's own check failed holds even against the override, and names the check",
            [allow],
            "checks-failed",
            true,
            { mode: "measure", writes: [{ kind: "held", content: '"Run the suite" failed on this turn\'s work (`pnpm test`), so it waits on its branch instead of landing.' }] },
        ],
        ["after a failed check lands only where a rule allows red work", [allowRed], "checks-failed", undefined, { mode: "check", writes: [{ kind: "fired", rule: "allow-red" }] }],
    ];
    test.each(decisions)("%s", (_case, rules, outcome, override, decision) => {
        expect(landingDecision(rules, { repos: ["root"], outcome }, override, outcome === "checks-failed" ? suite : undefined)).toStrictEqual(decision);
    });

    test("that held for a failed check it cannot name says nothing about it", () => {
        expect(landingDecision([], { outcome: "checks-failed" }, undefined, undefined)).toStrictEqual({ mode: "measure", writes: [] });
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
        await beginTurn(conversations, { conversationId: "c", isolated, prompt: "p", profile: { agent: "claude", harness: "native" } }, 1);
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
    const suiteRule: Rule = { id: "suite", label: "Run the suite", moment: "turn.ending", action: { kind: "command", command: "pnpm test", timeoutMs: 900_000 }, enabled: true };

    test.each([
        ["because it failed", { failed: true, aborted: false }],
        ["because it was stopped", { failed: false, aborted: true }],
    ] as const)("%s lands nothing, reconciles nothing, and still takes its check's verdict", async (_case, ending) => {
        const deps = await registered(true);
        deps.conversations.send("c", { kind: "check-ran", check: checkRunOf(suiteRule, { status: "failed", output: "" }) });
        const kept = books();
        const frames = await drain(landTurn(deps, hooks, { conversationId: "c", prompt: "p", autoLand: true, sync: async () => [], ...ending }, kept));
        expect(frames).toStrictEqual([]);
        expect(kept).toStrictEqual(books());
        expect(deps.conversations.send("c", { kind: "verdict-taken" }).reply).toBeUndefined();
    });

    test("because the conversation is not isolated lands nothing either", async () => {
        const kept = books();
        const turn = { conversationId: "c", prompt: "p", autoLand: true, failed: false, aborted: false, sync: async () => [] };
        expect(await drain(landTurn(await registered(false), hooks, turn, kept))).toStrictEqual([]);
        expect(kept).toStrictEqual(books());
    });
});
