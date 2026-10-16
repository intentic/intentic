import type { AgentEvent } from "@intentic/sandbox-contract/events/agent-events";
import { CONSULT_FAILED } from "../decorators/vendor-ask.js";
import { JS_TOOL_NAME } from "../../seams/js-tool-names.js";
import type { CommandGuard, GuardOutcome, GuardSubject } from "../../guard/command-guard.js";
import { AMBIGUOUS_TURN, consultPolicy, createPolicyGate, NO_GATE, NO_TURN, type PolicyTurn, programOf } from "./policy-gate.js";

// One policy answer for every runtime's pre-tool seam: the tool list, the turn's rewrite, then the command gate, and a
// refusal wherever the call cannot be placed or checked.

interface Asked {
    readonly program: string;
    readonly subject: GuardSubject;
    readonly cwd: string | undefined;
}

const gateAnswering = (outcome: GuardOutcome, asked: Asked[] = []): CommandGuard => ({
    enforcing: true,
    async *consult(program, subject, where) {
        asked.push({ program, subject, cwd: where?.cwd });
        yield { kind: "delta", text: "card" };
        return outcome;
    },
});

const turnWith = (gate: CommandGuard | undefined, extra: Partial<PolicyTurn> = {}): PolicyTurn & { readonly pushed: AgentEvent[] } => {
    const pushed: AgentEvent[] = [];
    return { gate, push: (event) => pushed.push(event), pushed, ...extra };
};

describe("programOf: what a call runs", () => {
    test("a shell tool's command, under whichever name the runtime gives the tool and the field", () => {
        expect(programOf({ tool: "Bash", input: { command: "ls" } })?.program).toBe("ls");
        expect(programOf({ tool: "exec_command", input: { cmd: "ls -la" } })?.program).toBe("ls -la");
        expect(programOf({ tool: "Shell", input: {}, program: "rm -rf x" })).toEqual({
            program: "rm -rf x",
            subject: { toolName: "Shell", displayName: "Run command", noun: "command", language: "bash" },
        });
    });

    test("the JS backend's script, under its own subject", () => {
        expect(programOf({ tool: JS_TOOL_NAME, input: { code: "console.log(1)" } })?.subject.toolName).toBe(JS_TOOL_NAME);
    });

    test("any other tool runs nothing, whatever its input happens to name", () => {
        expect(programOf({ tool: "mcp__github__search", input: { input: "rm -rf /" } })).toBeUndefined();
        expect(programOf({ tool: "Read", input: { command: "rm -rf /" } })).toBeUndefined();
    });
});

describe("consultPolicy", () => {
    test("no turn is a refusal", async () => {
        expect(await consultPolicy(undefined, { tool: "Read", input: {} })).toEqual({ decision: "deny", reason: NO_TURN });
    });

    test("a program in a turn whose gate is not running is refused; a call that runs nothing is not", async () => {
        expect(await consultPolicy(turnWith(undefined), { tool: "Bash", input: { command: "ls" } })).toEqual({ decision: "deny", reason: NO_GATE });
        expect(await consultPolicy(turnWith(undefined), { tool: "Read", input: { file_path: "/work/x" } })).toEqual({ decision: "allow" });
    });

    test("the tool list refuses first, before anything runs or is asked", async () => {
        const asked: Asked[] = [];
        const turn = turnWith(gateAnswering({ allow: true }, asked), { allowedTools: ["Read", "Bash(git log:*)"] });
        expect(await consultPolicy(turn, { tool: "Read", input: {} })).toEqual({ decision: "allow" });
        expect(await consultPolicy(turn, { tool: "Bash", input: { command: "git log --oneline" } })).toEqual({ decision: "allow" });
        const refused = await consultPolicy(turn, { tool: "Bash", input: { command: "rm -rf build" } });
        expect(refused.decision).toBe("deny");
        expect(asked.map((entry) => entry.program)).toEqual(["git log --oneline"]);
    });

    test("a held command parks on the gate with its frames pushed to the turn and its watchdog held, then answers", async () => {
        const asked: Asked[] = [];
        let holds = 0;
        let released = 0;
        const turn = turnWith(gateAnswering({ allow: false, reason: "Deleting files needs your approval." }, asked), {
            hold: () => {
                holds += 1;
                return () => {
                    released += 1;
                };
            },
        });
        expect(await consultPolicy(turn, { tool: "Bash", input: { command: "rm -rf build", workdir: "/work/app" } })).toEqual({
            decision: "deny",
            reason: "Deleting files needs your approval.",
        });
        expect(asked).toEqual([{ program: "rm -rf build", subject: expect.objectContaining({ toolName: "Bash" }), cwd: "/work/app" }]);
        expect(turn.pushed).toEqual([{ kind: "delta", text: "card" }]);
        expect([holds, released]).toEqual([1, 1]);
    });

    test("what the gate says about an allowed command rides back as context", async () => {
        const turn = turnWith(gateAnswering({ allow: true, context: "This install writes to your own copy." }));
        expect(await consultPolicy(turn, { tool: "Bash", input: { command: "pnpm add zod" } })).toEqual({
            decision: "allow",
            context: "This install writes to your own copy.",
        });
    });

    test("a rewrite is judged as the call that will run, and comes back as the new input", async () => {
        const asked: Asked[] = [];
        const turn = turnWith(gateAnswering({ allow: true }, asked), {
            rewrite: async (call) => ({ input: { command: `${String(programOf(call)?.program)} --dry-run` } }),
        });
        expect(await consultPolicy(turn, { tool: "Bash", input: { command: "make deploy" } })).toEqual({
            decision: "rewrite",
            input: { command: "make deploy --dry-run" },
        });
        expect(asked.map((entry) => entry.program)).toEqual(["make deploy --dry-run"]);
        const refusing = turnWith(gateAnswering({ allow: true }), { rewrite: async () => ({ refuse: "not here" }) });
        expect(await consultPolicy(refusing, { tool: "Bash", input: { command: "ls" } })).toEqual({ decision: "deny", reason: "not here" });
    });

    test("a gate that enforces nothing is never consulted", async () => {
        const gate: CommandGuard = {
            enforcing: false,
            // eslint-disable-next-line require-yield
            async *consult() {
                throw new Error("an unenforcing gate must never be consulted");
            },
        };
        expect(await consultPolicy(turnWith(gate), { tool: "Bash", input: { command: "rm -rf /" } })).toEqual({ decision: "allow" });
    });

    test("a consult that throws is a refusal, worded by the caller when it asks", async () => {
        const gate: CommandGuard = {
            enforcing: true,
            // eslint-disable-next-line require-yield
            async *consult() {
                throw new Error("the card store is unwritable");
            },
        };
        expect(await consultPolicy(turnWith(gate), { tool: "Bash", input: { command: "ls" } })).toEqual({ decision: "deny", reason: CONSULT_FAILED });
        expect(await consultPolicy(turnWith(gate), { tool: "Bash", input: { command: "ls" } }, { failed: () => "own words" })).toEqual({
            decision: "deny",
            reason: "own words",
        });
    });
});

describe("createPolicyGate: placing a call in its turn", () => {
    const deny = (reason: string): CommandGuard => gateAnswering({ allow: false, reason });

    test("an exact key is its turn; with one turn live, any call is that turn's", async () => {
        const gate = createPolicyGate();
        gate.register("a", turnWith(deny("from a")));
        expect(await gate.consult("a", { tool: "Bash", input: { command: "ls" } })).toEqual({ decision: "deny", reason: "from a" });
        expect(await gate.consult(undefined, { tool: "Bash", input: { command: "ls" } })).toEqual({ decision: "deny", reason: "from a" });
        expect(await gate.consult("stranger", { tool: "Bash", input: { command: "ls" } })).toEqual({ decision: "deny", reason: "from a" });
    });

    test("with several turns live, a call naming none of them is refused rather than guessed", async () => {
        const gate = createPolicyGate();
        gate.register("a", turnWith(gateAnswering({ allow: true })));
        gate.register("b", turnWith(gateAnswering({ allow: true })));
        expect(await gate.consult(undefined, { tool: "Bash", input: { command: "ls" } })).toEqual({ decision: "deny", reason: AMBIGUOUS_TURN });
        expect(await gate.consult("b", { tool: "Bash", input: { command: "ls" } })).toEqual({ decision: "allow" });
    });

    test("with no turn live, a call is refused unless the seam is one outside processes share", async () => {
        expect(await createPolicyGate().consult("a", { tool: "Bash", input: { command: "ls" } })).toEqual({ decision: "deny", reason: NO_TURN });
        expect(await createPolicyGate({ noLiveTurn: "allow" }).consult("a", { tool: "Bash", input: { command: "ls" } })).toEqual({
            decision: "allow",
        });
    });

    test("retiring an older registration leaves the turn that replaced it", async () => {
        const gate = createPolicyGate();
        const retireOld = gate.register("a", turnWith(deny("old")));
        gate.register("a", turnWith(deny("new")));
        retireOld();
        expect(await gate.consult("a", { tool: "Bash", input: { command: "ls" } })).toEqual({ decision: "deny", reason: "new" });
    });
});
