import { createSdkMcpServer, type McpSdkServerConfigWithInstance, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { resolveCommandSecrets, type SecretAccess } from "../agent/agent-secrets.js";
import type { TurnPlacement } from "../agents/isolation.js";
import { JS_TIMEOUT_DEFAULT_S, JS_TIMEOUT_MAX_S, type JsExecutionPlan, type JsRunResult, runJs } from "./js-runtime.js";

/* THE JS BACKEND AS THE CLAUDE CODE LOOP SEES IT, one tool, a peer of Bash, mounted by agent.ts directly
 * from the request's own `jsExecution` field the way the ask tool and the terminal hand-off are mounted from
 * theirs. The SDK's in-process server seam is the WIRE here, nothing more: the backend is planned in
 * turn-plan, fenced in js-runtime, gated by the same command gate and secret exit Bash rides, a reader who
 * wants to know what a JS run may do reads the execution module, not a tool registry.
 *
 * The name constants live here because three places must agree on them exactly: the mount, the alias that
 * lets prompts and skills say `Code` the way they say `Bash`, and the command-gate matcher that puts JS runs
 * under the owner's rulebook. */
export const JS_SERVER_NAME = "code";
export const JS_TOOL_NAME = "mcp__code__run";
export const JS_TOOL_ALIAS = "Code";

export interface JsToolDeps {
    readonly plan: JsExecutionPlan;
    // Where this turn's tree actually stands (agents/isolation.ts), the runner enters or maps, see placedPlan.
    readonly placement: TurnPlacement | undefined;
    // The turn's own signal: a script still running when the user stops the turn dies with it.
    readonly signal: AbortSignal;
    // The `{{secret:name}}` exit, when this sandbox stores any (agent/agent-secrets.ts). Absent ⇒ references
    // pass through as literal text, exactly as they would in a Bash command on a secretless sandbox.
    readonly secrets?: SecretAccess;
}

/* What the run looked like, to a model that has to act on it, the same text shape a shell gives: output
 * first, the status last, nothing wrapped in JSON it would have to unwrap. An undefined exit code is a run
 * that did not end on its own, and each of those roads says which it was. */
export const formatJsResult = (result: JsRunResult, timeoutSeconds: number): string => {
    const parts = [...(result.stdout === "" ? [] : [result.stdout]), ...(result.stderr === "" ? [] : [`--- stderr ---\n${result.stderr}`])];
    const status = result.timedOut
        ? `killed: still running at the ${timeoutSeconds}s timeout`
        : result.exitCode === undefined
          ? `killed before exiting (turn stopped, output flooded, or the process could not start)`
          : `exit ${result.exitCode}`;
    return `${parts.length === 0 ? "(no output)" : parts.join("\n")}\n${status}`;
};

// Exported for the tests that pin its honesty: what a scoped plan promises the model must be what js-runtime
// enforces, and the sentence that admits what the fence cannot cut must not quietly disappear.
export const jsToolDescription = (plan: JsExecutionPlan): string =>
    `Run a JavaScript program in the workspace: the code execution mode, a peer of the shell. ` +
    `The script is an ES module (top-level \`await\` works) run on Node 24: \`fetch\` and every \`node:\` builtin are there, ` +
    `and imports resolve against the workspace's own node_modules where they exist. ` +
    `Prefer it over shell one-liners for logic: reading and transforming files, calling HTTP APIs, anything you would ` +
    `otherwise assemble from grep/curl/jq pipes. ${
        plan.readRoots.length === 0
            ? "This session's scripts have NO filesystem access: work in memory and print results. "
            : `Reads are allowed under ${plan.readRoots.join(", ")}; ` +
              (plan.writeRoots.length === 0
                  ? "nothing on disk may be changed: writes are refused by the runtime itself. "
                  : `writes under ${plan.writeRoots.join(", ")}. `)
    }${
        plan.allowSpawn
            ? "Starting other programs (child_process) works. "
            : "Starting other programs is refused by the runtime, this session has no shell, and a script is not a way around that; if the task needs one, say so. "
    }A \`{{secret:name}}\` reference in the script is resolved to the stored value on the way into the process, so carry ` +
    `credentials as references, never pasted values. ` +
    `stdout and stderr come back tail-capped with the exit status; the process is killed at the timeout.`;

export const jsExecutionServer = (deps: JsToolDeps): McpSdkServerConfigWithInstance =>
    createSdkMcpServer({
        name: JS_SERVER_NAME,
        // In the prompt, not behind tool search: an execution mode the model has to go looking for is one it
        // replaces with the shell habit it already has, the same reasoning that keeps the ask tool loaded.
        alwaysLoad: true,
        tools: [
            tool(
                "run",
                jsToolDescription(deps.plan),
                {
                    code: z.string().describe("The ES module to run. Top-level await allowed; print what you need back."),
                    timeoutSeconds: z
                        .number()
                        .int()
                        .min(1)
                        .max(JS_TIMEOUT_MAX_S)
                        .optional()
                        .describe(`Seconds before the run is killed. Default ${JS_TIMEOUT_DEFAULT_S}, max ${JS_TIMEOUT_MAX_S}.`),
                },
                async (args) => ({ content: [{ type: "text" as const, text: await runJsTool(deps, args) }] }),
            ),
        ],
    });

/* The handler itself, bare, what a `run` call does once the SDK has delivered it, and the piece the tests
 * drive (the server wrapper above is registration, not behaviour). */
export const runJsTool = async (deps: JsToolDeps, args: { code: string; timeoutSeconds?: number | undefined }): Promise<string> => {
    const timeoutSeconds = Math.min(args.timeoutSeconds ?? JS_TIMEOUT_DEFAULT_S, JS_TIMEOUT_MAX_S);
    /* The secret exit, in the handler rather than as a hook: Bash needs its resolution composed inside the
     * tmux rewrite because two hooks rewriting one string must order themselves; a JS run has no second
     * rewriter, so the one pipeline is right here, after the command gate's hook has already read (and
     * possibly carded) the reference-form script, and inside the process boundary the transcript never
     * crosses: what the model sent, and what the result echoes back through masking, is the reference. */
    let code = args.code;
    if (deps.secrets !== undefined) {
        const resolved = await resolveCommandSecrets(args.code, deps.secrets, "code");
        if ("refusal" in resolved) {
            return resolved.refusal;
        }
        code = resolved.command;
    }
    const result = await runJs(deps.plan, code, {
        timeoutMs: timeoutSeconds * 1000,
        signal: deps.signal,
        placement: deps.placement,
    });
    return formatJsResult(result, timeoutSeconds);
};
