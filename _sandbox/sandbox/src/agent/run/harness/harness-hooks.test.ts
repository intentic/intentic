import { WORKSPACE_ROOT } from "@intentic/constants";
import type { AgentEvent, AgentTurn, Rule } from "@intentic/sandbox-contract";
import { unstubbed } from "@intentic/testing";
import type { Services } from "../../../composition.js";
import { parkedCards } from "../../../agents/actor/parked-cards.js";
import { CHECKS_SESSION } from "../../../terminal/terminal-session.js";
import { memoryFleet } from "../../../testing.js";
import type { TurnContext } from "../../providers/adapter.js";
import { createTurnFrames } from "../frames/frame-reducers.js";
import { type TurnEndingHooksDeps, turnEndingHooksOf } from "./harness-hooks.js";

// The Stop's checks as the turn's own proof: what `pnpm verify:turn` said at the end is what the turn's row records.

const VERIFY_TURN: Rule = {
    id: "verify-turn",
    label: "Verify the turn",
    moment: "turn.ending",
    action: { kind: "command", command: "pnpm verify:turn", timeoutMs: 900_000 },
    enabled: true,
};

const edit: AgentEvent = { kind: "tool_call", id: "e", name: "Edit", category: "edit", status: "completed", locations: [{ path: "/work/src/a.ts" }] };

const setup = (input: AgentTurn = { prompt: "p", conversationId: "c-1" }) => {
    const { conversations } = memoryFleet();
    const logged: { readonly fields: Record<string, unknown>; readonly message: string }[] = [];
    const deps = unstubbed<TurnEndingHooksDeps>("deps", {
        conversations,
        workspace: unstubbed<Services["workspace"]>("workspace", { root: WORKSPACE_ROOT }),
        logger: unstubbed<Services["logger"]>("logger", {
            info: ((fields: Record<string, unknown>, message: string) => {
                logged.push({ fields, message });
            }) as Services["logger"]["info"],
        }),
        // As the real runner does, `onStarted` fires as the command leaves the session's queue.
        terminalRun: unstubbed<Services["terminalRun"]>("terminalRun", {
            tryRun: async (_session, _command, options) => {
                options.onStarted?.();
                return { code: 0, output: "all green\n" };
            },
        }),
    });
    const frames = createTurnFrames(WORKSPACE_ROOT, undefined);
    const context: TurnContext = {
        base: {
            spec: { prompt: "p", cwd: WORKSPACE_ROOT },
            policy: {},
            tools: {},
            hooks: { cards: parkedCards(conversations) },
            signal: new AbortController().signal,
        },
        attachmentPaths: [],
        localCwd: WORKSPACE_ROOT,
        effectiveCwd: WORKSPACE_ROOT,
        cliEnv: {},
        steering: undefined,
        verification: frames.verification,
    };
    return { conversations, logged, frames, hooks: turnEndingHooksOf(deps, input, context, [VERIFY_TURN]) };
};

describe("the end-of-turn check", () => {
    test("passing after the last edit verifies the turn, and names itself as the check", () => {
        const { frames, hooks } = setup();
        frames.note(edit);
        hooks.onCheckRun?.(VERIFY_TURN, { status: "passed", output: "" });
        expect(frames.verification.standing()).toEqual({ state: "verified", paths: ["/work/src/a.ts"], check: "pnpm verify:turn (end of turn)" });
    });

    test("failing after the last edit makes the turn failing, whatever passed before it", () => {
        const { frames, hooks } = setup();
        frames.note(edit);
        hooks.onCheckRun?.(VERIFY_TURN, { status: "passed", output: "" });
        frames.note({ ...edit, id: "e2" });
        hooks.onCheckRun?.(VERIFY_TURN, { status: "failed", exitCode: 1, output: "1 failed" });
        expect(frames.verification.standing()).toEqual({ state: "failing", paths: ["/work/src/a.ts"], check: "pnpm verify:turn (end of turn)" });
    });

    // Neither measured the diff, as the land reads them too (turn-checks.ts landingOutcome).
    test.each(["error", "cancelled"] as const)("that ended %s leaves the turn unproven", (status) => {
        const { frames, hooks } = setup();
        frames.note(edit);
        hooks.onCheckRun?.(VERIFY_TURN, { status, output: "" });
        expect(frames.verification.standing()).toEqual({ state: "unproven", paths: ["/work/src/a.ts"], check: undefined });
    });

    test("still reaches the conversation's actor for the land", () => {
        const { conversations, hooks } = setup();
        hooks.onCheckRun?.(VERIFY_TURN, { status: "failed", output: "" });
        expect(conversations.send("c-1", { kind: "verdict-taken" }).reply?.status).toBe("failed");
    });

    test("proves a turn with no conversation too", () => {
        const { frames, hooks } = setup({ prompt: "p" });
        frames.note(edit);
        hooks.onCheckRun?.(VERIFY_TURN, { status: "passed", output: "" });
        expect(frames.verification.standing().state).toBe("verified");
    });
});

// Any line read alone must say whose check it was and where it ran; the started line adds how long it waited its turn.
test("every line of the check carries the same identity", async () => {
    const { logged, hooks } = setup();
    await hooks.runRuleCommand?.("pnpm verify:turn", 60_000);
    const identity = { command: "pnpm verify:turn", anchored: false, cwd: WORKSPACE_ROOT, session: CHECKS_SESSION, conversationId: "c-1" };
    expect(logged.map((line) => line.message)).toEqual(["checks: check queued", "checks: check started", "checks: check settled"]);
    expect(logged[0]?.fields).toStrictEqual(identity);
    expect(logged[1]?.fields).toStrictEqual({ ...identity, waitedMs: expect.any(Number) });
    expect(logged[2]?.fields).toStrictEqual({ ...identity, status: "passed", exitCode: 0, durationMs: expect.any(Number) });
});
