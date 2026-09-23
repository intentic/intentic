import { WORKSPACE_ROOT } from "@intentic/constants";
import { type AgentEvent, RESUME_NOTES } from "@intentic/sandbox-contract";
import { describe, expect, test } from "bun:test";
import type { LimitWay } from "../../models/limit-way.js";
import type { AgentRequest } from "../../providers/agent-request.js";
import { createTurnFrames, type WallChange } from "../frames/frame-reducers.js";
import type { TurnInput } from "../../../seams/turn-starter.js";
import { daemonStopConversation, holdOf, settleTurn, type TurnEnd } from "./turn-settlement.js";
import { parkedCards } from "../../../agents/actor/parked-cards.js";
import { memoryFleet } from "../../../testing.js";

// Where a turn here parks its cards: one fleet's actors.
const cards = parkedCards(memoryFleet().conversations);

const request: AgentRequest = {
    spec: { prompt: "ship the parser", cwd: WORKSPACE_ROOT },
    policy: {},
    tools: {},
    credential: { kind: "container" },
    hooks: { cards },
    signal: new AbortController().signal,
};
const input: TurnInput & { conversationId: string } = { prompt: "ship the parser", conversationId: "c-1" };
const noCode = { state: "no-code", paths: [], check: undefined } as const;

// A turn that walked `stream` and then had its walls set by classification; each case names what it is about.
const ended = (stream: readonly AgentEvent[], change: Partial<Omit<TurnEnd, "frames">> = {}, walls: WallChange = {}): TurnEnd => {
    const frames = createTurnFrames(WORKSPACE_ROOT, undefined);
    for (const event of stream) {
        frames.note(event);
    }
    frames.hit(walls);
    return {
        input,
        provider: "claude",
        account: "acct",
        attribution: { account: "acct" },
        request,
        resumeArmed: false,
        spawnedChild: false,
        aborted: false,
        isolated: false,
        cwd: WORKSPACE_ROOT,
        isolation: undefined,
        experiments: { turnIndex: 3, mapArm: true },
        frames,
        ...change,
    };
};

const edit: AgentEvent = { kind: "tool_call", id: "e", name: "Edit", category: "edit", status: "completed", locations: [{ path: "/work/src/parser.ts" }] };
const check: AgentEvent = { kind: "tool_call", id: "t", name: "Bash", category: "execute", status: "in_progress", target: `pnpm test ${"x".repeat(250)}` };
const passed: AgentEvent = { kind: "tool_call_update", id: "t", status: "completed", content: [{ type: "text", text: "--- [exit 0, 1s]" }] };

describe("a finished turn", () => {
    test("lands one ledger row with its summed cost, how it ended, and every stamp planning took", () => {
        const end = ended([
            { kind: "session", sessionId: "s-1" },
            { kind: "delta", text: "on it" },
            edit,
            check,
            passed,
            { kind: "todos", items: [{ content: "a", status: "completed" }, { content: "b", status: "pending" }] },
            { kind: "compact", trigger: "auto" },
            { kind: "context_usage", tokens: 1_000, contextWindow: 200_000 },
            { kind: "usage", costUsd: 0.25, inputTokens: 100, numTurns: 1 },
            { kind: "usage", costUsd: 0.5, outputTokens: 7, cacheCreationTokens: 3, durationMs: 40, numTurns: 1 },
        ]);

        expect(
            settleTurn({
                ...end,
                request: { ...request, spec: { ...request.spec, model: "opus" } },
                input: { ...input, model: "opus-4-6", autoPicked: true },
            }).usage,
        ).toStrictEqual({
            provider: "claude",
            account: "acct",
            model: "opus",
            modelRequested: "opus-4-6",
            harness: "native",
            outcome: "ok",
            conversationId: "c-1",
            turns: 2,
            inputTokens: 100,
            outputTokens: 7,
            cacheReadTokens: 0,
            cacheCreationTokens: 3,
            costUsd: 0.75,
            durationMs: 40,
            verification: "verified",
            // The check that spoke, cut to a line.
            check: `pnpm test ${"x".repeat(190)}`,
            filesEdited: 1,
            toolCalls: 2,
            compactions: 1,
            checklistTotal: 2,
            checklistOpen: 1,
            contextTokens: 1_000,
            contextWindow: 200_000,
            searchCalls: 0,
            openingSearches: 0,
            openingListings: 0,
            failedCalls: 0,
            callsBeforeTarget: 0,
            turnIndex: 3,
            mapArm: true,
            autoPicked: true,
        });
    });

    test("that failed before the provider answered is filed unbilled, with its code and sentence and no verdict", () => {
        const end = ended([{ kind: "error", code: "claude-not-entitled", message: `not enabled ${"y".repeat(500)}` }], { input: { ...input, model: "" } });
        expect(settleTurn(end).usage).toStrictEqual({
            provider: "claude",
            account: "acct",
            harness: "native",
            outcome: "error",
            errorCode: "claude-not-entitled",
            errorMessage: `not enabled ${"y".repeat(388)}`,
            conversationId: "c-1",
            turns: 0,
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            costUsd: 0,
            durationMs: 0,
            turnIndex: 3,
            mapArm: true,
            autoPicked: undefined,
        });
    });

    test("that was stopped is cancelled, whatever its frames said", () => {
        const plan = settleTurn(ended([{ kind: "delta", text: "x" }, { kind: "error", message: "aborted" }], { aborted: true, provider: "codex" }));
        expect(plan.usage.outcome).toBe("cancelled");
        expect(plan.daemonStop.conversationId).toBeUndefined();
    });

    test("closes its activity with the summed cost, or with nothing when it billed nothing", () => {
        const billed = ended([
            { kind: "usage", costUsd: 0.25, account: "acct" },
            { kind: "usage", costUsd: 0.5 },
        ]);
        expect(settleTurn(billed).completion).toStrictEqual({ type: "turn.completed", extra: { account: "acct", costUsd: 0.75 } });
        expect(settleTurn(ended([])).completion).toStrictEqual({ type: "turn.completed" });
    });

    test("on the main tree snapshots it under the prompt; in a worktree it never touches the main tree", () => {
        expect(settleTurn(ended([])).snapshot).toBe("ship the parser");
        expect(settleTurn(ended([], { isolated: true })).snapshot).toBeUndefined();
    });

    test("on a routed provider re-reads its files; on a native one it owes nothing", () => {
        expect(settleTurn(ended([], { provider: "codex" })).headroomRefresh).toStrictEqual({ scope: { providers: ["codex"] }, maxAgeMs: 10_000 });
        expect(settleTurn(ended([])).headroomRefresh).toBeUndefined();
    });
});

describe("the resume records", () => {
    test("remember a refused credential only when the frame promised its re-mint", () => {
        const refused = { authRefused: true } as const;
        const armed = { resumeArmed: true, request: { ...request, credential: { kind: "claude-oauth" as const, token: "tok-1" } } };
        const session: AgentEvent[] = [{ kind: "session", sessionId: "s-1" }];
        expect(settleTurn(ended(session, armed, refused)).authFailure).toStrictEqual({ input, sessionId: "s-1", account: "acct", refusedToken: "tok-1" });
        expect(settleTurn(ended(session, { ...armed, resumeArmed: false }, refused)).authFailure).toBeUndefined();
        expect(settleTurn(ended(session, { ...armed, account: undefined }, refused)).authFailure).toBeUndefined();
        expect(settleTurn(ended(session, { resumeArmed: true }, refused)).authFailure).toBeUndefined();
        expect(settleTurn(ended(session, armed)).authFailure).toBeUndefined();
    });

    test("hand an outage the turn's last session, and nothing without a conversation or an outage", () => {
        const outage = { outageHit: true } as const;
        expect(settleTurn(ended([{ kind: "session", sessionId: "s-9" }], {}, outage)).outageFailure).toStrictEqual({ input, sessionId: "s-9", provider: "claude" });
        expect(settleTurn(ended([], { input: { prompt: "p" } }, outage)).outageFailure).toBeUndefined();
        expect(settleTurn(ended([], {}, {})).outageFailure).toBeUndefined();
    });
});

describe("a held turn", () => {
    const way: LimitWay = { standing: noCode, checklist: [{ content: "a", status: "pending" }], handoffTokens: 40, move: { account: "sibling", carry: true } };

    test("on a spent allowance is held whole, with the instant and the way the frame published", () => {
        const end = ended([{ kind: "session", sessionId: "s-1" }], {}, { limit: { hit: true, reopens: 1_900_000_000, way } });
        expect(holdOf(end)).toStrictEqual({
            kind: "held",
            held: { input, reason: "limit", sessionId: "s-1", ran: false, reopensAt: 1_900_000_000, ...way },
        });
    });

    test("on a carried session a sibling refused outright is held for a fresh run on that account", () => {
        const carried: TurnInput & { conversationId: string } = { prompt: `${RESUME_NOTES.carried}\n\nship it`, conversationId: "c-1", account: "sibling" };
        const end = ended(
            [
                { kind: "todos", items: [{ content: "a", status: "pending" }] },
                { kind: "error", message: "session not found" },
            ],
            { input: carried },
        );
        expect(holdOf(end)).toStrictEqual({
            kind: "held",
            held: {
                input: carried,
                reason: "limit",
                ran: true,
                carryRefused: true,
                move: { account: "sibling", carry: false },
                standing: noCode,
                checklist: [{ content: "a", status: "pending" }],
            },
        });
    });

    test("on an uncoded death is held as stopped, with what it left behind", () => {
        const end = ended([
            { kind: "session", sessionId: "s-1" },
            { kind: "delta", text: "looking" },
            { kind: "context_usage", tokens: 9_000, contextWindow: 90_000 },
            { kind: "error", message: "timed out" },
        ]);
        expect(holdOf(end)).toStrictEqual({
            kind: "held",
            held: { input, reason: "stopped", sessionId: "s-1", ran: true, standing: noCode, contextTokens: 9_000 },
        });
    });

    test("is not one when the turn named its own remedy, which resets the ladder instead", () => {
        expect(holdOf(ended([{ kind: "error", code: "context-window-too-small", message: "too small" }]))).toStrictEqual({ kind: "got-somewhere", conversationId: "c-1" });
        expect(holdOf(ended([{ kind: "delta", text: "done" }]))).toStrictEqual({ kind: "got-somewhere", conversationId: "c-1" });
    });

    test("is nothing at all without a conversation", () => {
        expect(holdOf(ended([{ kind: "error", message: "died" }], { input: { prompt: "p" } }))).toBeUndefined();
    });
});

describe("the daemon's own Stop", () => {
    const rules = [{ id: "suite", label: "Suite", moment: "turn.ending", action: { kind: "builtin", name: "verify-edits" }, enabled: true }] as const;

    test("runs for a runtime with no Stop hook, on the rules and ledgers the turn ran with", () => {
        const onRuleFired = (): void => {};
        const verifyTests = async (): Promise<string | undefined> => undefined;
        const isolation = { plan: { worktree: "/w", root: WORKSPACE_ROOT, mirrors: [], overlays: "/o", fence: undefined } };
        const end = ended([edit], {
            input: { ...input, agent: "codex", model: "gpt-5", effort: "high", actsAs: "reviewer", unattended: true, permissionMode: "plan" },
            provider: "codex",
            isolated: true,
            cwd: "/w",
            isolation,
            request: {
                ...request,
                policy: { ...request.policy, turnEndingRules: [...rules] },
                hooks: { ...request.hooks, onRuleFired, verifyTests },
            },
        });
        const { daemonStop } = settleTurn(end);

        expect(daemonStop).toStrictEqual({
            conversationId: "c-1",
            findings: { conversationId: "c-1", isolated: true, request: end.request, edited: ["/work/src/parser.ts"], cwd: "/w", isolation },
            nudge: {
                conversationId: "c-1",
                // The turn's profile whole, and nothing it said or how it was gated.
                profile: { agent: "codex", model: "gpt-5", effort: "high", actsAs: "reviewer", unattended: true },
                rules: [...rules],
                ledger: end.frames.verification,
                view: end.frames.viewing,
                isolation: isolation.plan,
                cwd: "/w",
                onFired: onRuleFired,
                tests: verifyTests,
            },
        });
    });

    test("with nothing to run on still asks the rules, which answer for no conversation", () => {
        const { daemonStop } = settleTurn(ended([], { provider: "codex", input: { prompt: "p" } }));
        expect(daemonStop).toStrictEqual({
            conversationId: undefined,
            findings: { conversationId: undefined, isolated: false, request, edited: [], cwd: WORKSPACE_ROOT, isolation: undefined },
            nudge: undefined,
        });
    });

    test.each([
        ["a runtime with no Stop hook, that ended well", "codex", "ok", "c-1"],
        ["one that failed", "codex", "error", undefined],
        ["one that was stopped", "codex", "cancelled", undefined],
        ["Claude, which runs its own", "claude", "ok", undefined],
    ] as const)("is the daemon's for %s", (_case, provider, outcome, conversationId) => {
        expect(daemonStopConversation(input, provider, outcome, false)).toBe(conversationId);
    });

    test("is nobody's without a conversation", () => {
        expect(daemonStopConversation({ prompt: "p" }, "codex", "ok", false)).toBeUndefined();
    });

    test("is its parent's for a spawned child, whose own Stop answers for it", () => {
        expect(daemonStopConversation(input, "codex", "ok", true)).toBeUndefined();
    });
});
