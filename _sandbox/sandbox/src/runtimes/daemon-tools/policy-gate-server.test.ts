import { pino } from "pino";
import { z } from "zod";
import { sdkServerDoor } from "./sdk-door.js";
import { declarationOf, rulesOf } from "../../rules/repo-checks.js";
import { type GateHooks, gateServer, NOT_A_HOOK, preToolUseAnswer } from "./policy-gate-server.js";
import type { PolicyTurn } from "./policy-gate.js";

// The policy gate as a runtime's own hooks reach it on the door: the answers in the hook-decision shape, and the
// end-of-turn checks said once.

const CHECKS = rulesOf(declarationOf("intentic", [{ when: "turn", run: "pnpm verify" }]));

const ContentSchema = z.object({ result: z.object({ content: z.array(z.object({ text: z.string() })) }) });

// What a gate tool answers: the hook decision, as its text part carries it.
const DecisionSchema = z.object({
    decision: z.literal("block").optional(),
    reason: z.string().optional(),
    hookSpecificOutput: z
        .object({
            hookEventName: z.string(),
            permissionDecision: z.string().optional(),
            permissionDecisionReason: z.string().optional(),
            updatedInput: z.unknown().optional(),
            additionalContext: z.string().optional(),
        })
        .optional(),
});

const callTool = async (door: ReturnType<typeof sdkServerDoor>, name: string, args: Record<string, unknown>): Promise<z.infer<typeof DecisionSchema>> => {
    const answer = ContentSchema.parse(await door.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }));
    return DecisionSchema.parse(JSON.parse(answer.result.content[0]?.text ?? "null"));
};

test("each verdict reads as the PreToolUse decision a hook answers", () => {
    expect(preToolUseAnswer({ decision: "allow" })).toEqual({});
    // Codex refuses `permissionDecision: "allow"` without an `updatedInput`, and a refused answer is a hook that failed.
    expect(preToolUseAnswer({ decision: "allow", context: "note" })).toEqual({
        hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: "note" },
    });
    expect(preToolUseAnswer({ decision: "deny", reason: "no" })).toEqual({
        hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "no" },
    });
    expect(preToolUseAnswer({ decision: "rewrite", input: { command: "ls -a" } })).toEqual({
        hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: { command: "ls -a" } },
    });
});

test("a call while the turn cannot be placed is refused", async () => {
    const door = sdkServerDoor(gateServer({ turn: () => undefined, mark: () => {} }));
    expect(await callTool(door, "pre_tool_use", { tool_name: "Read", tool_input: {} })).toMatchObject({
        hookSpecificOutput: { permissionDecision: "deny" },
    });
    door.close();
});

test("stop runs the repositories' turn checks once and hands back what they found; a second stop is let go", async () => {
    let runs = 0;
    const door = sdkServerDoor(
        gateServer({
            turn: () => undefined,
            mark: () => {},
            turnChecks: {
                rules: CHECKS,
                change: async () => ({ paths: ["intentic/src/a.ts"], repos: ["intentic"] }),
                run: async () => {
                    runs += 1;
                    return { status: "failed", output: "a.ts: 1 error" };
                },
                onFired: () => {},
                logger: pino({ level: "silent" }),
            },
        }),
    );
    const first = await callTool(door, "stop", {});
    expect(first.decision).toBe("block");
    expect(first.reason).toContain("a.ts: 1 error");
    expect(await callTool(door, "stop", {})).toEqual({});
    expect(runs).toBe(1);
    door.close();
});

// A turn with no rules to enforce, so its gate is never consulted.
const OPEN_TURN: PolicyTurn = {
    gate: {
        enforcing: false,
        consult: () => {
            throw new Error("a gate with nothing to enforce is not consulted");
        },
    },
    push: () => {},
};

test("a call without the loop's key is the model calling the gate itself, and is refused", async () => {
    const hooks: GateHooks = { key: "k-1" };
    const door = sdkServerDoor(gateServer({ turn: () => OPEN_TURN, mark: () => {}, hooks: () => hooks }));
    expect(await callTool(door, "pre_tool_use", { tool_name: "Bash", tool_input: { command: "ls" } })).toEqual({
        hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: NOT_A_HOOK },
    });
    expect(await callTool(door, "pre_tool_use", { tool_name: "Bash", tool_input: { command: "ls" }, key: "k-1" })).toEqual({});
    door.close();
});

test("the loop names the tool for the list, settles the verdict and adds what it found after the call", async () => {
    const settled: string[] = [];
    const hooks: GateHooks = {
        listName: (call) => (call.tool === "apply_patch" ? "Edit" : call.tool),
        settle: async (call, verdict) => {
            settled.push(`${call.id ?? "?"}:${verdict.decision}`);
            return call.tool === "Bash" ? { decision: "rewrite", input: { command: "wrapped" } } : verdict;
        },
        original: () => ({ command: "curl https://example.com" }),
        afterTool: async (call) => (call.tool === "apply_patch" ? "a.ts: 1 error" : undefined),
    };
    const marks: string[] = [];
    const door = sdkServerDoor(gateServer({ turn: () => ({ ...OPEN_TURN, allowedTools: ["Edit", "Bash"] }), mark: (source) => marks.push(source), hooks: () => hooks }));
    expect(await callTool(door, "pre_tool_use", { tool_name: "apply_patch", tool_input: { command: "*** Begin Patch" }, tool_use_id: "c1" })).toEqual({});
    expect(await callTool(door, "pre_tool_use", { tool_name: "Bash", tool_input: { command: "ls" }, tool_use_id: "c2" })).toEqual({
        hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: { command: "wrapped" } },
    });
    // Off the list: refused before the loop's settle could rewrite it into anything.
    expect(await callTool(door, "pre_tool_use", { tool_name: "mcp__web__fetch", tool_input: {}, tool_use_id: "c3" })).toMatchObject({
        hookSpecificOutput: { permissionDecision: "deny" },
    });
    expect(settled).toEqual(["c1:allow", "c2:allow", "c3:deny"]);
    expect(await callTool(door, "post_tool_use", { tool_name: "apply_patch", tool_input: {}, tool_response: "ok", tool_use_id: "c1" })).toEqual({
        hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: "a.ts: 1 error" },
    });
    // The taint reading is of the command the model wrote, not the wrapper Codex ran.
    expect(await callTool(door, "post_tool_use", { tool_name: "Bash", tool_input: { command: "wrapped" }, tool_response: "page", tool_use_id: "c2" })).toEqual({});
    expect(marks.length).toBeGreaterThan(0);
    door.close();
});

test("a settle that throws refuses the call rather than answering an error, which Codex would run past", async () => {
    const hooks: GateHooks = {
        settle: async () => {
            throw new Error("boom");
        },
    };
    const door = sdkServerDoor(gateServer({ turn: () => OPEN_TURN, mark: () => {}, hooks: () => hooks }));
    const answer = await callTool(door, "pre_tool_use", { tool_name: "Bash", tool_input: { command: "ls" } });
    expect(answer.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(answer.hookSpecificOutput?.permissionDecisionReason).toContain("boom");
    door.close();
});
