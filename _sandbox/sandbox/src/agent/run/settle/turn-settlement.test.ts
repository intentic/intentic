import { WORKSPACE_ROOT } from "@intentic/constants";
import type { AgentEvent } from "@intentic/sandbox-contract";
import type { AgentRequest } from "../../providers/agent-request.js";
import { createTurnFrames } from "../frames/frame-reducers.js";
import type { RoutedTurn } from "../../../seams/turn-starter.js";
import type { HeldTurn } from "../turn/turn-resume.js";
import { settleTurn, type TurnEnd } from "./turn-settlement.js";
import { parkedCards } from "../../../conversations/actor/parked-cards.js";
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
const input: RoutedTurn & { conversationId: string } = { agent: "claude", harness: "native", prompt: "ship the parser", conversationId: "c-1" };
const noCode = { state: "no-code", paths: [], check: undefined } as const;

// A turn that walked `stream`, held as classification left it; each case names what it is about.
const ended = (stream: readonly AgentEvent[], change: Partial<Omit<TurnEnd, "frames">> = {}, held?: HeldTurn): TurnEnd => {
    const frames = createTurnFrames(WORKSPACE_ROOT, undefined);
    for (const event of stream) {
        frames.note(event);
    }
    frames.hold(held);
    return {
        input,
        provider: "claude",
        attribution: { account: "acct" },
        request,
        spawnedChild: false,
        aborted: false,
        isolated: false,
        isolation: undefined,
        experiments: { turnIndex: 3, mapArm: true },
        frames,
        ...change,
    };
};

const edit: AgentEvent = {
    kind: "tool_call",
    id: "e",
    name: "Edit",
    category: "edit",
    status: "completed",
    locations: [{ path: "/work/src/parser.ts" }],
};
const check: AgentEvent = {
    kind: "tool_call",
    id: "t",
    name: "Bash",
    category: "execute",
    status: "in_progress",
    target: `pnpm test ${"x".repeat(250)}`,
};
const passed: AgentEvent = { kind: "tool_call_update", id: "t", status: "completed", content: [{ type: "text", text: "--- [exit 0, 1s]" }] };

describe("a finished turn", () => {
    test("lands one ledger row with its summed cost, how it ended, and every stamp planning took", () => {
        const end = ended([
            { kind: "session", sessionId: "s-1" },
            { kind: "delta", text: "on it" },
            edit,
            check,
            passed,
            {
                kind: "todos",
                items: [
                    { content: "a", status: "completed" },
                    { content: "b", status: "pending" },
                ],
            },
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
        const end = ended([{ kind: "error", code: "claude-not-entitled", message: `not enabled ${"y".repeat(500)}` }], {
            input: { ...input, model: "" },
        });
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
        const plan = settleTurn(
            ended(
                [
                    { kind: "delta", text: "x" },
                    { kind: "error", message: "aborted" },
                ],
                { aborted: true, provider: "codex" },
            ),
        );
        expect(plan.usage.outcome).toBe("cancelled");
        // It changed nothing a check could speak to, so the card's last record stands.
        expect(plan.proof).toBeUndefined();
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

describe("the resume record", () => {
    test("is the hold the last failure's classification left, as it stands", () => {
        const held: HeldTurn = { input, reason: "stopped", sessionId: "s-1", ran: true, standing: noCode };
        expect(settleTurn(ended([{ kind: "error", message: "died" }], {}, held)).hold).toStrictEqual({ kind: "held", held });
    });

    test("is proof the run got somewhere when nothing is held, and nothing at all without a conversation", () => {
        expect(settleTurn(ended([{ kind: "delta", text: "done" }])).hold).toStrictEqual({ kind: "got-somewhere", conversationId: "c-1" });
        expect(settleTurn(ended([{ kind: "error", message: "died" }], { input: { agent: "claude", harness: "native", prompt: "p" } })).hold).toBeUndefined();
    });
});

// What the card records of the turn's own proof (AgentSummary.proof): read off its tool calls, never asked of the model,
// and never a reason to send the turn back. Checks run after the work lands.
describe("the proof it records", () => {
    const failed: AgentEvent = {
        kind: "tool_call_update",
        id: "t",
        status: "completed",
        content: [{ type: "text", text: "1 failed\n--- [exit 1, 4s]" }],
    };
    const surface: AgentEvent = { ...edit, id: "v", locations: [{ path: `${WORKSPACE_ROOT}/src/Card.vue` }] };
    const looked: AgentEvent = { kind: "tool_call", id: "l", name: "mcp__web__browser_take_screenshot", category: "other", status: "completed" };

    // `at` is the settle's own clock, so it is bounded by the instants around the call rather than pinned.
    const proofOf = (end: TurnEnd): ReturnType<typeof settleTurn>["proof"] => {
        const before = Date.now();
        const { proof } = settleTurn(end);
        expect(proof?.proof.at ?? before).toBeGreaterThanOrEqual(before);
        expect(proof?.proof.at ?? before).toBeLessThanOrEqual(Date.now());
        return proof;
    };

    test("names the check that passed after the last edit, cut to a line", () => {
        expect(proofOf(ended([edit, check, passed]))).toStrictEqual({
            conversationId: "c-1",
            proof: { at: expect.any(Number), verification: "verified", check: `pnpm test ${"x".repeat(190)}` },
        });
    });

    test("names the check that failed, on any runtime, isolated or not", () => {
        for (const change of [{}, { provider: "codex" as const, isolated: true }, { provider: "cursor" as const }]) {
            expect(proofOf(ended([edit, check, failed], change))?.proof).toStrictEqual({
                at: expect.any(Number),
                verification: "failing",
                check: `pnpm test ${"x".repeat(190)}`,
            });
        }
    });

    test("says a turn that changed code and checked nothing is unproven", () => {
        expect(proofOf(ended([edit]))).toStrictEqual({ conversationId: "c-1", proof: { at: expect.any(Number), verification: "unproven" } });
    });

    test("counts the rendered files changed without a look after them, and forgets the ones looked at since", () => {
        expect(proofOf(ended([surface]))?.proof).toStrictEqual({ at: expect.any(Number), verification: "unproven", unviewed: 1 });
        expect(proofOf(ended([surface, looked]))?.proof).toStrictEqual({ at: expect.any(Number), verification: "unproven" });
    });

    test("is nothing for a turn that touched no code and left nothing unlooked at, so the last record stands", () => {
        expect(settleTurn(ended([{ kind: "delta", text: "nothing to change" }])).proof).toBeUndefined();
    });

    test("is nothing for a spawned child, whose parent's report carries its proof", () => {
        expect(settleTurn(ended([edit, check, passed], { spawnedChild: true })).proof).toBeUndefined();
    });

    // Only frames feed the ledgers on a live turn, and any edit is itself an answer; this is the guard for the ledger a
    // turn that never answered could still be holding.
    test("is nothing for a turn the provider never answered, whatever its ledgers hold", () => {
        const end = ended([{ kind: "error", code: "claude-not-entitled", message: "not enabled" }]);
        end.frames.verification.noteEdit(`${WORKSPACE_ROOT}/src/parser.ts`);
        expect(end.frames.verification.standing().state).toBe("unproven");
        expect(settleTurn(end).proof).toBeUndefined();
    });

    test("is nothing without a conversation to record it on", () => {
        expect(settleTurn(ended([edit], { input: { agent: "claude", harness: "native", prompt: "p" } })).proof).toBeUndefined();
    });
});
