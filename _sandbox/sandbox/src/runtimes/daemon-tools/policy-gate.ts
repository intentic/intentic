import type { PreToolUseHookInput } from "@anthropic-ai/claude-agent-sdk";
import { errorMessage } from "@intentic/base/errors";
import type { AgentEvent } from "@intentic/sandbox-contract/events/agent-events";
import type { Logger } from "pino";
import { allowlistRefusal, toolAllowed } from "../../agent/tools/tool-allowlist.js";
import { askCwdOf, askProgramOf, CONSULT_FAILED, VendorToolInputSchema } from "../decorators/vendor-ask.js";
import { JS_TOOL_NAME } from "../../seams/js-tool-names.js";
import { type CommandGuard, consultWith, type GuardOutcome, JS_SUBJECT, type GuardSubject, vendorSubject } from "../../guard/command-guard.js";

// The owner's policy asked before a tool runs, for any runtime that can put a hook in front of its tools: one answer
// whether the question came over Cursor's hook socket, a Codex `mcp_tool` hook calling the door's `gate` server
// (policy-gate-server.ts), or any other runtime's pre-execution seam. What it reads: the turn's tool list (the
// allowlist an outside-driven turn is held to), then, for a call that runs a program, the turn's command gate, which
// may park on a card until a person answers. It fails closed: a call it cannot place in a turn, a turn whose gate is not
// running, or a consult that threw is refused, never waved through.

// A call's input as a pre-tool hook hands it over, whatever tool made it.
export type PolicyInput = PreToolUseHookInput["tool_input"];

export interface PolicyCall {
    // The tool as the runtime names it (Cursor's `Shell`, Codex's `Bash`, the JS backend's `mcp__code__run`).
    readonly tool: string;
    readonly input: PolicyInput;
    // The program the call runs, when the runtime already knows it; otherwise read off the input of a shell or script
    // tool (programOf below).
    readonly program?: string | undefined;
    // Where it runs, when the runtime says per call; otherwise read off the input, else the gate's own.
    readonly cwd?: string | undefined;
}

// `hold` is not a verdict of its own: a call the rules hold parks inside `consult` on a card (its frames pushed to the
// turn, its watchdog held) and comes back allow or deny once a person answered.
export type PolicyVerdict =
    | { readonly decision: "allow"; readonly context?: string }
    | { readonly decision: "deny"; readonly reason: string }
    // Run, with the input changed (a rewrite the turn's own hook asked for).
    | { readonly decision: "rewrite"; readonly input: PolicyInput; readonly context?: string };

// What a rewrite hook answers: refuse with a sentence, run with a changed input, or leave the call alone.
export type PolicyRewrite = { readonly refuse: string } | { readonly input: PolicyInput } | undefined;

// One live turn as the policy reads it.
export interface PolicyTurn {
    // The turn's command gate (vendor-gate.ts); absent while the loop that mints it has not started, which refuses.
    readonly gate: CommandGuard | undefined;
    // Where the cards a held call raises go: the turn's own stream.
    readonly push: (event: AgentEvent) => void;
    // The turn's watchdog hold, taken while a card waits on a person.
    readonly hold?: (() => () => void) | undefined;
    // The turn's tool list, when it carries one: a call off it is refused before anything else is asked.
    readonly allowedTools?: readonly string[] | undefined;
    // A change the turn makes to a call before it runs (a path redirect, a shield reading a token back), asked after the
    // tool list and before the rules, so the rules read the call that will actually run.
    readonly rewrite?: ((call: PolicyCall) => Promise<PolicyRewrite>) | undefined;
}

export const NO_TURN =
    "This call could not be placed in any running turn, so nothing could check it against your owner's safety policy and it was refused. " +
    "Do not retry it: carry on with what you can do without it, and say plainly what you left undone.";
export const NO_GATE =
    "This turn's command gate is not running, so nothing could check this against your owner's safety policy and it was refused. " +
    "Do not retry it: carry on with what you can do without it, and say plainly what you left undone.";
export const AMBIGUOUS_TURN =
    "Several turns are running and this call named none of them, so nothing could tell whose rules it answers to and it was refused. " +
    "Do not retry it: say plainly what you could not run.";

// The names runtimes give their shell tool; a call to one runs the command its input names.
const SHELL_TOOLS: ReadonlySet<string> = new Set(["bash", "shell", "exec", "exec_command", "local_shell", "run_shell_command", "run_terminal_cmd", "terminal", "execute"]);

/** The program a call runs and the subject its card names, or undefined for a call that runs none. */
export const programOf = (call: PolicyCall): { readonly program: string; readonly subject: GuardSubject } | undefined => {
    const fields = VendorToolInputSchema.parse(call.input);
    if (call.tool === JS_TOOL_NAME) {
        const code = call.program ?? fields.code;
        return code === undefined ? undefined : { program: code, subject: JS_SUBJECT };
    }
    const program = call.program ?? (SHELL_TOOLS.has(call.tool.toLowerCase()) ? askProgramOf(fields) : undefined);
    return program === undefined ? undefined : { program, subject: vendorSubject(call.tool) };
};

const allowed = (outcome: Extract<GuardOutcome, { allow: true }>, input: PolicyInput | undefined): PolicyVerdict => {
    if (input !== undefined) {
        return outcome.context === undefined ? { decision: "rewrite", input } : { decision: "rewrite", input, context: outcome.context };
    }
    return outcome.context === undefined ? { decision: "allow" } : { decision: "allow", context: outcome.context };
};

// Whatever a consult threw, as errorMessage reads it.
type Thrown = Parameters<typeof errorMessage>[0];

export interface ConsultOptions {
    // The sentence a consult that threw is refused with; the vendor-ask wording when absent.
    readonly failed?: (error: Thrown) => string;
}

const failedReason = (options: ConsultOptions, error: Thrown): string => options.failed?.(error) ?? CONSULT_FAILED;

// The turn's tool list: a refusal for a call off it, else undefined.
const listRefusal = (turn: PolicyTurn, call: PolicyCall): PolicyVerdict | undefined => {
    if (turn.allowedTools === undefined) {
        return undefined;
    }
    const command = SHELL_TOOLS.has(call.tool.toLowerCase()) ? (call.program ?? askProgramOf(VendorToolInputSchema.parse(call.input))) : undefined;
    return toolAllowed(turn.allowedTools, { name: call.tool, command })
        ? undefined
        : { decision: "deny", reason: allowlistRefusal({ name: call.tool, command }, turn.allowedTools) };
};

// The turn's own rewrite: a refusal, or the call that will actually run and the input it was changed to, if it was.
const rewriteOf = async (
    turn: PolicyTurn,
    call: PolicyCall,
    options: ConsultOptions,
): Promise<{ readonly verdict: PolicyVerdict } | { readonly current: PolicyCall; readonly rewritten: PolicyInput | undefined }> => {
    let rewrite: PolicyRewrite;
    try {
        rewrite = await turn.rewrite?.(call);
    } catch (error) {
        return { verdict: { decision: "deny", reason: failedReason(options, error) } };
    }
    if (rewrite === undefined) {
        return { current: call, rewritten: undefined };
    }
    if ("refuse" in rewrite) {
        return { verdict: { decision: "deny", reason: rewrite.refuse } };
    }
    // The rules read what will run: the rewritten input, its program read again rather than the one named before.
    return { current: { tool: call.tool, input: rewrite.input, cwd: call.cwd }, rewritten: rewrite.input };
};

// The command gate on the program the call runs, holding the turn's watchdog while a card waits.
const gateVerdict = async (
    gate: CommandGuard,
    turn: PolicyTurn,
    current: PolicyCall,
    rewritten: PolicyInput | undefined,
    options: ConsultOptions,
): Promise<PolicyVerdict> => {
    const run = programOf(current);
    // Same short-circuit every vendor-gated runtime takes: no rules or taint costs nothing, not even classifying.
    if (run === undefined || !gate.enforcing) {
        return allowed({ allow: true }, rewritten);
    }
    const release = turn.hold?.();
    try {
        const where = current.cwd ?? askCwdOf(VendorToolInputSchema.parse(current.input));
        const outcome = await consultWith(gate, run.program, run.subject, turn.push, { cwd: where });
        return outcome.allow ? allowed(outcome, rewritten) : { decision: "deny", reason: outcome.reason };
    } catch (error) {
        return { decision: "deny", reason: failedReason(options, error) };
    } finally {
        release?.();
    }
};

/**
 * Asks one turn's policy about one call. Undefined for the turn (it could not be placed) is a refusal, as is a call that
 * runs a program in a turn whose gate is not running, or a consult that threw.
 */
export const consultPolicy = async (turn: PolicyTurn | undefined, call: PolicyCall, options: ConsultOptions = {}): Promise<PolicyVerdict> => {
    if (turn === undefined) {
        return { decision: "deny", reason: NO_TURN };
    }
    const listed = listRefusal(turn, call);
    if (listed !== undefined) {
        return listed;
    }
    const rewrite = await rewriteOf(turn, call, options);
    if ("verdict" in rewrite) {
        return rewrite.verdict;
    }
    if (turn.gate === undefined) {
        // A call that runs nothing needs no gate; one that runs a program does not run unchecked.
        return programOf(rewrite.current) === undefined ? allowed({ allow: true }, rewrite.rewritten) : { decision: "deny", reason: NO_GATE };
    }
    return gateVerdict(turn.gate, turn, rewrite.current, rewrite.rewritten, options);
};

// How a call names its turn was settled: exactly, by elimination (one turn live), or not at all.
export type TurnPlacement = { readonly turn: PolicyTurn } | { readonly refused: string } | { readonly outside: true };

export interface PolicyGate {
    // Registers a live turn under the key its hooks carry back; returns the retire, which retires only this registration.
    readonly register: (key: string, turn: PolicyTurn) => () => void;
    readonly place: (key: string | undefined) => TurnPlacement;
    readonly consult: (key: string | undefined, call: PolicyCall, options?: ConsultOptions) => Promise<PolicyVerdict>;
}

export interface PolicyGateOptions {
    readonly logger?: Pick<Logger, "warn">;
    // What a call is when no turn at all is live. `refuse` (the default) for a seam only the daemon's turns can reach.
    // `allow` for a machine-wide hook a process the daemon never started also passes through (Cursor's /etc hooks file,
    // which the owner's own hand-run Cursor reads too): no daemon turn's rules govern that process, and refusing it would
    // break the owner's own tool, not protect a turn.
    readonly noLiveTurn?: "refuse" | "allow";
}

/**
 * The registry a socket-borne hook places its calls through, by the key the runtime's payload carries (Cursor's agent
 * id). An exact key is its turn; with one turn live, a call naming none of the live keys can only be from it (and if it
 * is not, it is checked by rules rather than let past); with several, nothing tells them apart and the call is refused.
 */
export const createPolicyGate = (options: PolicyGateOptions = {}): PolicyGate => {
    const turns = new Map<string, PolicyTurn>();
    const place = (key: string | undefined): TurnPlacement => {
        const exact = key === undefined ? undefined : turns.get(key);
        if (exact !== undefined) {
            return { turn: exact };
        }
        const [only, ...others] = turns.values();
        if (only !== undefined && others.length === 0) {
            return { turn: only };
        }
        if (only === undefined) {
            return options.noLiveTurn === "allow" ? { outside: true } : { refused: NO_TURN };
        }
        options.logger?.warn({ key, live: turns.size }, "policy gate: could not tell which turn is asking, refusing");
        return { refused: AMBIGUOUS_TURN };
    };
    return {
        register: (key, turn) => {
            turns.set(key, turn);
            return () => {
                if (turns.get(key) === turn) {
                    turns.delete(key);
                }
            };
        },
        place,
        consult: async (key, call, consultOptions) => {
            const placed = place(key);
            if ("outside" in placed) {
                return { decision: "allow" };
            }
            if ("refused" in placed) {
                return { decision: "deny", reason: placed.refused };
            }
            return consultPolicy(placed.turn, call, consultOptions);
        },
    };
};

// The sentence a hook endpoint refuses with when the consult itself failed: names the failure, tells the model not to
// retry.
export const guardFailed = (error: Thrown): string =>
    `The command guard failed (${errorMessage(error)}), so this command was refused. Do not retry it: say plainly what you could not run.`;
