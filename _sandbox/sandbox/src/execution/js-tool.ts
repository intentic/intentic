import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { sdk } from "../runtimes/claude/claude-sdk.js";
import { z } from "zod";
import { resolveCommandSecrets, type SecretAccess } from "../agent/tools/agent-secrets.js";
import type { TurnPlacement } from "../agents/worktrees/isolation.js";
import { JS_TIMEOUT_DEFAULT_S, JS_TIMEOUT_MAX_S, type JsExecutionPlan, type JsRunResult, runJs } from "./js-runtime.js";

// One tool, a peer of Bash, mounted by agent.ts from the request's own `jsExecution` field; the SDK server is only the
// wire. Planning lives in turn-plan, fencing in js-runtime, gated by the same command gate and secret exit Bash rides.
// Name constants live here since the mount, the `Code` alias, and the command-gate matcher must agree.
export const JS_SERVER_NAME = "code";
export const JS_TOOL_NAME = "mcp__code__run";
export const JS_TOOL_ALIAS = "Code";

export interface JsToolDeps {
    readonly plan: JsExecutionPlan;
    // Where this turn's tree actually stands (agents/isolation.ts); the runner enters or maps it, see placedPlan.
    readonly placement: TurnPlacement | undefined;
    // The turn's own signal: a script still running when the user stops the turn dies with it.
    readonly signal: AbortSignal;
    // Secret-reference resolution, when this sandbox stores any; absent, references pass through as literal text.
    readonly secrets?: SecretAccess;
}

// What the run looked like, to a model that has to act on it: output first, status last, nothing wrapped in JSON to
// unwrap. An undefined exit code is a run that didn't end on its own; each road below says which.
export const formatJsResult = (result: JsRunResult, timeoutSeconds: number): string => {
    const parts = [...(result.stdout === "" ? [] : [result.stdout]), ...(result.stderr === "" ? [] : [`--- stderr ---\n${result.stderr}`])];
    const status = result.timedOut
        ? `killed: still running at the ${timeoutSeconds}s timeout`
        : result.exitCode === undefined
          ? `killed before exiting (turn stopped, output flooded, or the process could not start)`
          : `exit ${result.exitCode}`;
    return `${parts.length === 0 ? "(no output)" : parts.join("\n")}\n${status}`;
};

// Exported for the tests that pin its honesty: what a scoped plan promises must be what js-runtime enforces.
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
    sdk().createSdkMcpServer({
        name: JS_SERVER_NAME,
        // In the prompt, not behind tool search: a mode the model must go looking for gets replaced by its shell habit.
        alwaysLoad: true,
        tools: [
            sdk().tool(
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

// The handler itself, what a `run` call does once the SDK delivers it; the piece the tests drive (the server wrapper
// above is only registration).
export const runJsTool = async (deps: JsToolDeps, args: { code: string; timeoutSeconds?: number | undefined }): Promise<string> => {
    const timeoutSeconds = Math.min(args.timeoutSeconds ?? JS_TIMEOUT_DEFAULT_S, JS_TIMEOUT_MAX_S);
    // The secret exit lives in the handler, not a hook: Bash must compose its resolution inside the tmux rewrite since
    // two hooks order themselves, but a JS run has only this one pipeline, after the command gate has read the script.
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
