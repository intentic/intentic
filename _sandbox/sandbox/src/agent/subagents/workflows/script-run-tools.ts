import { z } from "zod";
import { AgentHarnessSchema, AgentProviderSchema } from "@intentic/sandbox-contract/schemas/agent";
import { toolAnnotations } from "@intentic/sandbox-contract/peer-mcp-server";
import { sdk } from "../../../engines/claude-sdk.js";
import { opt } from "../../../opt.js";
import { ResultValueSchema } from "../child-result.js";
import { MAX_CALLS } from "./script-run-calls.js";
import {
    DEFAULT_CONCURRENCY,
    MAX_CONCURRENCY,
    type ScriptRunDoor,
    type ScriptRunRefusal,
    type ScriptRunStart,
    type ScriptRunStatus,
    type ScriptRunStopped,
} from "./script-runs.js";

// The workflow tools a delegating turn gets on its `subagents` server (subagent-wait.ts): start a run, read or wait on
// one, stop one. The run itself is script-runs.ts.

const MAX_WAIT_S = 1800;

const WORKFLOW_WORDS =
    "Run a workflow: a script that coordinates subagents for you, so a fan-out (review every file, verify every finding, " +
    "port every package) costs you one call instead of a turn of bookkeeping. The script opens with " +
    '`export const meta = { name: "…", description: "…", phases: [{ title: "…" }] }`, and the rest is the body of an async ' +
    "function: `await agent(prompt, { label, provider, model, schema })` starts a subagent (a full agent in its own worktree, " +
    "on any connected provider; its work lands in your checkout as a spawned one's does) and resolves to its final report, " +
    "or to its value matching `schema`, which it is sent back to fix at most twice; `parallel([() => agent(…), …])` waits " +
    "for all, a failed one as null; `pipeline(items, item => agent(…), found => agent(…))` takes each item through every " +
    "stage without waiting for the others; `phase(title)` and `log(…)` mark progress; `args` is what you pass. What the body " +
    "returns is the run's result. A call names its provider and model, or takes the run's `provider` and `model`. It " +
    "answers a run id at once, and the run's ending wakes this conversation with its result, so you need not wait on it. " +
    "Finished calls are kept: after a restart the run goes on where it was, and `resume` with an earlier run's id hands " +
    "back every call whose prompt and options are unchanged, so an edited script pays only for what changed. The script " +
    `has no clock, randomness, files or network: only these calls. At most ${MAX_CALLS} agent calls a run, ${DEFAULT_CONCURRENCY} ` +
    "at once unless you say otherwise; your own subagent limits apply as well.";

// Any JSON the script reads as `args`: an object or a list, as the run's caller passes it.
const ARGS_FIELD = z.union([z.looseObject({}), z.array(z.unknown())]).optional().describe("What the script reads as `args`.");

// Whatever a workflow tool answers, as one JSON text block the model can branch on.
type WorkflowAnswer = ScriptRunStart | ScriptRunStatus | ScriptRunRefusal | ScriptRunStopped;
// A type, not an interface: the SDK's result type has an index signature, which only a type literal meets implicitly.
type TextResult = { content: [{ type: "text"; text: string }] };
const answer = (payload: WorkflowAnswer): TextResult => ({ content: [{ type: "text", text: JSON.stringify(payload) }] });

/** The workflow tools over this turn's door to its runs. */
export const workflowTools = (door: ScriptRunDoor, signal: AbortSignal) => [
    sdk().tool(
        "workflow",
        WORKFLOW_WORDS,
        {
            script: z.string().min(1).optional().describe("The script itself."),
            scriptPath: z.string().min(1).optional().describe("Instead of `script`: a file holding it, in your working tree."),
            args: ARGS_FIELD,
            provider: AgentProviderSchema.optional().describe("The provider a call runs on when it names none; with `model`."),
            model: z.string().min(1).optional().describe("The model a call runs on when it names none; with `provider`."),
            harness: AgentHarnessSchema.optional().describe("The loop a call runs in when it names no provider of its own."),
            effort: z.string().optional().describe("How hard a call thinks when it names no provider of its own."),
            concurrency: z.number().int().min(1).max(MAX_CONCURRENCY).optional().describe(`How many of its subagents may work at once; default ${DEFAULT_CONCURRENCY}.`),
            resume: z.string().min(1).optional().describe("An earlier run's id: every call it finished whose prompt and options are unchanged is handed back, not run again."),
        },
        async (input) => {
            const args = input.args === undefined ? undefined : ResultValueSchema.safeParse(input.args);
            if (args !== undefined && !args.success) {
                return answer({ ok: false, message: "`args` must be JSON." } satisfies ScriptRunRefusal);
            }
            if ((input.provider === undefined) !== (input.model === undefined)) {
                return answer({ ok: false, message: "Name the run's `provider` and `model` together, or neither." } satisfies ScriptRunRefusal);
            }
            const defaults =
                input.provider === undefined || input.model === undefined
                    ? undefined
                    : { provider: input.provider, model: input.model, ...opt("harness", input.harness), ...opt("effort", input.effort) };
            return answer(
                await door.start({
                    ...opt("script", input.script),
                    ...opt("scriptPath", input.scriptPath),
                    ...opt("args", args?.data),
                    ...opt("defaults", defaults),
                    ...opt("concurrency", input.concurrency),
                    ...opt("resume", input.resume),
                }),
            );
        },
        // Commits allowance to every subagent it starts, and nothing later gives it back.
        { annotations: toolAnnotations("destructive") },
    ),
    sdk().tool(
        "workflow_status",
        "Where a workflow run of yours stands: its phase, how many of its calls are running, done, failed or handed back from " +
            "an earlier run, each worker's subagent id (wait, send or cancel it like any you spawned), its log, and once it " +
            "ends, what it returned or the error it ended on. `waitSeconds` waits that long for it to end first, and returns " +
            "early, with waitOutcome `message`, when something is said into your turn (as the wait tool does): read it, then call again.",
        {
            run: z.string().min(1).describe("The run's id, from workflow."),
            waitSeconds: z.number().min(0).max(MAX_WAIT_S).optional().describe(`How long to wait for it to end first; default 0, at most ${MAX_WAIT_S}.`),
        },
        async (input) => answer(await door.status(input.run, Math.round((input.waitSeconds ?? 0) * 1000), signal)),
        { annotations: toolAnnotations("read") },
    ),
    sdk().tool(
        "workflow_stop",
        "Stop a workflow run of yours: its script ends, its subagents still working are stopped, and what they wrote stays in " +
            "their worktrees. Its ending wakes you as usual, and `resume` with its id later keeps every call it finished.",
        { run: z.string().min(1).describe("The run's id, from workflow.") },
        async (input) => answer(door.stop(input.run)),
        { annotations: toolAnnotations("destructive") },
    ),
];
