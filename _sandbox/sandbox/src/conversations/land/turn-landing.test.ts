import { type Rule, SandboxSettingsSchema } from "@intentic/sandbox-contract/schemas/settings";
import { unstubbed } from "@intentic/testing";
import type { LandOutcome } from "./land.js";
import { services } from "../../harness/route-services.testing.js";
import { beginTurn } from "../actor/conversation-actors.testing.js";
import {
    type LandBooks,
    type LandingDecision,
    landedFrame,
    landedOutcomeOf,
    landingDecision,
    type LandingDeps,
    type LandingHooks,
    askToLandHome,
    decideLanding,
    landTurn,
    settleLandBooks,
} from "./turn-landing.js";
import { conversationEntry, isolatedAgent } from "../registry/agents-store.testing.js";
import { unlinkedMessage } from "../worktrees/checkout-link.js";
import { noteLandHeldForWake, takeLandHeldForWake } from "./wake-held.js";
import type { AgentWorktrees } from "../worktrees/worktrees.js";
import type { BranchCheckouts } from "../worktrees/branches/branch-checkouts.js";

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
const allowFailing: Rule = { ...allow, id: "allow-failing", label: "Land failing work", when: { outcome: ["checks-failed"] } };

// No check takes part: nothing checks the work when it lands, and CI checks what the owner pushes.
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
            "under a rule naming the retired checks-failed outcome is decided by the rest of the table",
            [allowFailing, hold],
            undefined,
            {
                mode: "measure",
                writes: [
                    { kind: "fired", rule: "hold-all" },
                    { kind: "held", content: '"Hold everything" held this work on its branch instead of landing it.' },
                ],
            },
        ],
        ["with the override on lands past a rule naming the retired checks-failed outcome", [allowFailing], true, { mode: "check", writes: [] }],
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
    test.each([
        ["because it failed", { failed: true, aborted: false }],
        ["because it was stopped", { failed: false, aborted: true }],
    ] as const)("%s lands nothing and reconciles nothing", async (_case, ending) => {
        const deps = await registered(true);
        const kept = books();
        const frames = await drain(
            landTurn(deps, hooks, { conversationId: "c", prompt: "p", autoLand: true, awaitingWake: false, sync: async () => [], ...ending }, kept),
        );
        expect(frames).toStrictEqual([]);
        expect(kept).toStrictEqual(books());
    });

    // Auto-land is on and no rule holds anything, so only the wake it awaits can be what stops this land: past the guard,
    // the unstubbed settings store would name itself. What counts as awaiting a wake is the turn's close's to say
    // (turn-close.ts), from what the conversation holds once its wakes are armed.
    test("because it ended to wait on a wake it armed lands nothing and reconciles nothing", async () => {
        const deps = await registered(true);
        const kept = books();
        const turn = { conversationId: "c", prompt: "p", autoLand: true, failed: false, aborted: false, awaitingWake: true, sync: async () => [] };
        expect(await drain(landTurn(deps, hooks, turn, kept))).toStrictEqual([]);
        expect(kept).toStrictEqual(books());
        // Kept, with the turn's own answer to landing, for if the wake goes away without firing (wake-held-land.ts).
        expect(await takeLandHeldForWake(deps, "c")).toStrictEqual({ autoLand: true });
    });

    test("that failed clears the land an earlier close kept for a wake: it never lands by itself", async () => {
        const deps = await registered(true);
        await noteLandHeldForWake(deps, "c", {});
        const turn = { conversationId: "c", prompt: "p", autoLand: true, failed: true, aborted: false, awaitingWake: true, sync: async () => [] };
        expect(await drain(landTurn(deps, hooks, turn, books()))).toStrictEqual([]);
        expect(await takeLandHeldForWake(deps, "c")).toBeUndefined();
    });

    // Nothing runs in the worktree first: what the repository derives is written where the work landed, after (rederive.ts).
    test("awaiting nothing, the same turn goes straight on to decide its land", async () => {
        const deps = await registered(true);
        const turn = { conversationId: "c", prompt: "p", autoLand: true, failed: false, aborted: false, awaitingWake: false, sync: async () => [] };
        await expect(drain(landTurn(deps, hooks, turn, books()))).rejects.toThrow("deps.sandboxSettings.get was called, and this test did not stub it");
    });

    test("because the conversation is not isolated lands nothing either", async () => {
        const kept = books();
        const turn = { conversationId: "c", prompt: "p", autoLand: true, failed: false, aborted: false, awaitingWake: false, sync: async () => [] };
        expect(await drain(landTurn(await registered(false), hooks, turn, kept))).toStrictEqual([]);
        expect(kept).toStrictEqual(books());
    });
});

// A land that breaks rather than refuses stays on the card until one goes through; before, the books an ended turn
// settles only logged it, and the card rested on a standing read off the main repo's copy of a branch that never moved.
describe("a land that breaks", () => {
    test("while an ended turn's books settle is kept on the card, in the words it broke with", async () => {
        const { agents, conversations, perf, logger } = services();
        await beginTurn(conversations, { conversationId: "c", isolated: true, prompt: "p", profile: { agent: "claude", harness: "native" } }, 1);
        await agents.recordWorktree("c", [{ repo: "root", base: "a".repeat(40) }]);
        // The checkout lost its link and could not be re-linked: every land stops at its first step.
        const agentWorktrees = unstubbed<AgentWorktrees>("worktrees", { relink: async () => ["root"] });
        await settleLandBooks({ agents, conversations, perf, logger, agentWorktrees, branchCheckouts: unstubbed<BranchCheckouts>("branchCheckouts", {}) }, "c");
        expect(agents.get("c")?.landFailure).toEqual({ reason: unlinkedMessage(["root"]), code: "unlinked", at: expect.any(Number) });
    });
});

// A home conversation judges its children's work before it takes any (land-target.ts holdsChildren), and asks a
// maintainer for its own land where it may not land by itself.
describe("a home's family", () => {
    const home = conversationEntry({ id: "home-1", identity: { home: true } });
    const decideDeps = {
        sandboxSettings: unstubbed<LandingDeps["sandboxSettings"]>("sandboxSettings", {}),
        agentWorktrees: unstubbed<LandingDeps["agentWorktrees"]>("agentWorktrees", {}),
        logger: unstubbed<LandingDeps["logger"]>("logger", {}),
        auth: undefined,
        members: unstubbed<LandingDeps["members"]>("members", {}),
        ownerEmail: async () => undefined,
        agents: { entry: (id: string) => (id === "home-1" ? home : conversationEntry({ id })) },
    };
    const child = isolatedAgent([{ repo: "root", base: "cut" }], { id: "sub-a" });

    test("holds a child's work off a home's checkout, asking no rule; any other parent takes it", async () => {
        expect(await decideLanding(decideDeps, { kind: "parent", parent: "home-1" }, child, undefined, [])).toEqual({ mode: "measure", writes: [] });
        expect(await decideLanding(decideDeps, { kind: "parent", parent: "other" }, child, undefined, [])).toEqual({ mode: "check", writes: [] });
    });

    // Whether a home lands by itself is its owner's authority at the land (home-conversation.ts homeOwnerLands), never the
    // answer its opening latched nor a hold set on it: a member granted `lands` later lands, and one whose grant was taken
    // back is held.
    test("a home's own land follows its owner's grant as it stands at the land", async () => {
        const owner = { email: "ada@example.com", name: "Ada", since: 1 };
        const atRest = (autoLand: boolean | undefined) =>
            isolatedAgent([{ repo: "root", base: "cut" }], {
                id: "home-1",
                identity: { home: true },
                social: { owner, reactions: [] },
                postures: autoLand === undefined ? {} : { autoLand },
            });
        const ada = { email: "ada@example.com", role: "guest", agents: "home" } as const;
        const withGrant = (lands: boolean) => ({
            ...decideDeps,
            auth: unstubbed<NonNullable<LandingDeps["auth"]>>("auth", {}),
            sandboxSettings: unstubbed<LandingDeps["sandboxSettings"]>("sandboxSettings", { get: async () => SandboxSettingsSchema.parse({}) }),
            ownerEmail: async () => "owner@example.com",
            members: unstubbed<LandingDeps["members"]>("members", {
                list: async () => [lands ? { ...ada, lands: true } : ada],
            }),
        });
        const main = { kind: "main", ruled: true } as const;
        expect(await decideLanding(withGrant(true), main, atRest(undefined), undefined, [])).toEqual({ mode: "check", writes: [] });
        expect(await decideLanding(withGrant(false), main, atRest(true), undefined, [])).toEqual({ mode: "measure", writes: [] });
        expect(await decideLanding(withGrant(true), main, atRest(false), undefined, [])).toEqual({ mode: "check", writes: [] });
        expect(await decideLanding(withGrant(true), main, atRest(undefined), false, [])).toEqual({ mode: "check", writes: [] });
    });

    test("a home whose work was held asks a maintainer in its owner's name; nothing else does", async () => {
        const asked: unknown[] = [];
        const deps = { agents: unstubbed<LandingDeps["agents"]>("agents", { requestLand: async (...args: unknown[]) => void asked.push(args.slice(0, 2)) }) };
        const owner = { email: "ada@example.com", name: "Ada", since: 1 };
        const held = isolatedAgent([], { id: "home-1", identity: { home: true }, social: { owner, reactions: [] } });
        await askToLandHome(deps, held, "ready");
        await askToLandHome(deps, held, "landed");
        await askToLandHome(deps, { ...held, identity: {} }, "ready");
        expect(asked).toEqual([["home-1", { email: "ada@example.com", name: "Ada" }]]);
    });
});
