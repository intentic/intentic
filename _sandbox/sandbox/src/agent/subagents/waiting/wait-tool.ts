import { toolAnnotations } from "@intentic/sandbox-contract/peer-mcp-server";
import { z } from "zod";
import { sdk } from "../../../engines/claude-sdk.js";
import type { ConversationActors } from "../../../conversations/actor/conversation-actors.js";
import { opt } from "../../../opt.js";
import { backgroundJobOf } from "../../tools/jobs/background-jobs.js";
import type { JobReport } from "../../tools/jobs/job-report.js";
import { outputPattern } from "./output-lines.js";
import type { SubagentWaitUntil } from "../subagents.js";
import { NO_TARGET, waitTargetOf, waitTargetsOf } from "./wait-targets.js";
import {
    type ChildLookups,
    type ChildrenWaitAnswer,
    childrenWaitAnswer,
    untailed,
    waitForChildren,
    waitForNamedWork,
    waitForWork,
    workWaitAnswer,
} from "./work-wait.js";

// The `wait` tool, apart from the server it is mounted on (subagent-wait.ts). A tool, not a CLI: a blocking shell command
// would hit the soft-timeout and become the polling it replaces.

// Long enough for a real run, short enough to return if forgotten; a longer wait means calling again. Out-of-range
// timeouts are clamped in the handler, never refused by the schema: a refused call costs the model a retry.
const DEFAULT_TIMEOUT_S = 600;
const MAX_TIMEOUT_S = 1800;

// The tool's whole answer as one JSON text block, so the model can branch on `outcome` without parsing prose.
const asText = (json: string) => ({ content: [{ type: "text" as const, text: json }] });

const UNTIL = z.enum(["blocked", "finished"]);
const DEFAULT_UNTIL: readonly SubagentWaitUntil[] = ["blocked", "finished"];

// `until` as a pattern: what it is matched against, from where, and what else still ends the wait.
const UNTIL_WORDS =
    'Which states end the wait; default ["blocked","finished"]. Or, for one background command named as `target`, a ' +
    "regular expression (JavaScript syntax): the wait also returns, with outcome `matched`, at the first line of its " +
    "output that matches, handing back `match` (the line, its number, and up to three lines either side). Lines are " +
    "matched one at a time once complete (^ and $ anchor a line; nothing spans two), with terminal colours removed; " +
    "case-sensitive unless it starts with (?i). It reads the command's output from its start, so a line printed before you " +
    "called still counts, or just past the line your last pattern wait on it matched, so waiting again finds the next " +
    "one. The command exiting, or sitting at a prompt, still ends the wait.";

// What a pattern names a wait on anything but one command with.
const PATTERN_ON_ONE_COMMAND =
    "`until` as a pattern reads one background command's output: name that command's ID as `target`. A subagent, \"any\", \"all\" or `targets` take until as states.";

const NOTHING_TO_WAIT_FOR =
    "Nothing to wait for: no subagent or background command of this conversation is still running under that id, or its ending was already reported.";

// What the wait tool tells the model it does, in one place outside the server it is mounted on.
const WAIT_WORDS =
    "Wait until work you started here needs you: a subagent you started, or a command you ran with " +
    "run_in_background. Blocks until the target is blocked on input (a question or permission), or " +
    "finishes, whichever comes first. For an agent it returns its status, its last report (capped at 12k characters with a full-file retrieval handle, as " +
    "`report`, where the row's `summary` is only its head), and " +
    "`verification` — whether anything actually checked the work that report describes (`verified` / " +
    "`unproven` / `failing` / `no-code`, with the check that spoke). Read it before you build on what it " +
    "says: an agent's own account of its work is a claim, not a result. A spawned one's `landing` says where " +
    "its work went: into your checkout already, or held on its branch where it clashed with your edits " +
    "(merge brings it in). For a command it returns the " +
    "exit code, the tail of its output and the file holding all of it, and while it runs how long it has " +
    "been quiet; a command sitting at a prompt (blocked reading its terminal, nothing moving) returns " +
    "`blocked` with `waitingForInput`, since nothing in your turn can type into it and waiting again will " +
    "not end it. Target a subagent your runtime's own " +
    "tool started by that call's id, one you spawned by the id spawn returned, a background command by " +
    'the ID its Bash call returned, or "any" for whichever of these moves first (each is reported once; ' +
    "a background command counts only while a child is still running, so with no child left it answers at once and " +
    "lists the commands still running in `running`). " +
    "An agent `paused` has not finished: its turn stopped on a spent allowance or stopped short, the sandbox " +
    "runs it again by itself (its `error` says when), and its report comes after that; cancel it before " +
    "giving its task to another agent. " +
    'To wait on several children or commands as one, name them in `targets` (or pass target "all" for every child ' +
    "still running): the wait comes back early only for trouble (a child blocked on a question, paused, " +
    "failed or stopped, as `agent`), and otherwise once every one has finished, each in `agents` with its " +
    "whole report (commands in `jobs`), so a fan-out costs you one wake instead of one per child. " +
    "A question or pause it already handed you is not handed over again: waiting again on that child parks until it " +
    "moves on (answer the question first). To return at a line of a command's output (a server's \"listening\", a " +
    "build's \"error\"), pass `until` a pattern. " +
    "Use this instead of sleeping or polling in a loop. On timeout it returns `progress`, a few lines for each thing " +
    "waited on saying what moved since your last wait: a command's new lines and bytes, its last lines and how long it " +
    "has been quiet; a child's tool calls since, its last words, what holds it (waiting for room, a question) and the " +
    "files it changed. There is nothing to look up between waits: call it again to keep waiting. It also returns early, with outcome `message`, when something is said into your " +
    "turn while it waits (the owner, a watch, a subagent's report, a land of a subagent's work), so you read it " +
    "now rather than when the wait runs out.";

export interface WaitToolDeps {
    // The conversation whose children and commands this turn may wait on; a parent supervises only its own.
    readonly conversationId: string | undefined;
    // Where its children and background commands are held, and the queue a report a wait took is withdrawn from.
    readonly conversations: Pick<ConversationActors, "holdings" | "queued" | "send">;
    // The turn's own abort; a parked wait settles when the turn is stopped.
    readonly signal: AbortSignal;
    // What a wait reads of a spawned child beyond its row: its question, whole report, landing, machine and result.
    readonly lookups: ChildLookups;
}

// A wait on several children as one (work-wait.ts waitForChildren): `targets`, or every live child for "all".
const waitOnMany = async (
    deps: WaitToolDeps,
    conversationId: string,
    targets: readonly string[] | undefined,
    timeoutMs: number,
): Promise<ChildrenWaitAnswer & { readonly jobs?: readonly object[]; readonly job?: object }> => {
    const mixed = targets?.some((id) => backgroundJobOf(deps.conversations, conversationId, id) !== undefined) === true;
    const many = mixed && targets !== undefined
        ? await waitForNamedWork(deps.conversations, conversationId, { targets, until: DEFAULT_UNTIL, timeoutMs, signal: deps.signal })
        : await waitForChildren(deps.conversations, conversationId, { ...opt("targets", targets), timeoutMs, signal: deps.signal });
    const said = childrenWaitAnswer(many, deps.lookups);
    const command = "job" in many && many.job !== undefined
        ? workWaitAnswer({ outcome: many.outcome === "failed" ? "finished" : many.outcome, job: many.job }, deps.lookups)
        : {};
    // A timeout's progress already says each command's last lines.
    const told = (job: JobReport): object => (many.progress === undefined ? job : untailed(job));
    return {
        ...said,
        ...command,
        outcome: said.outcome,
        ...opt("jobs", "jobs" in many ? many.jobs.map(told) : undefined),
        ...opt("job", "jobs" in many && many.job !== undefined ? told(many.job) : undefined),
        ...opt("note", many.outcome === "unknown-target" ? NOTHING_TO_WAIT_FOR : undefined),
    };
};

// What `until` asks for: the states that end the wait, with the pattern a command's output is read for where it named
// one, or why the pattern it named is none.
type UntilAsked = { readonly states: readonly SubagentWaitUntil[]; readonly pattern?: RegExp } | { readonly refused: string };

const UntilSchema = z.union([z.array(UNTIL).min(1), z.string().min(1)]).optional();

const untilAsked = (until: z.infer<typeof UntilSchema>): UntilAsked => {
    if (until === undefined) {
        return { states: DEFAULT_UNTIL };
    }
    if (Array.isArray(until)) {
        return { states: until };
    }
    const pattern = outputPattern(until);
    return pattern instanceof RegExp ? { states: DEFAULT_UNTIL, pattern } : { refused: pattern.error };
};

// A wait on one target, or on "any": a pattern only on a background command.
const waitOnOne = async (
    deps: WaitToolDeps,
    conversationId: string,
    name: string | undefined,
    asked: { readonly states: readonly SubagentWaitUntil[]; readonly pattern?: RegExp },
    timeoutMs: number,
): Promise<object> => {
    // A command's ID is exact, so a pattern on anything else is refused before a child's name is looked for.
    if (asked.pattern !== undefined && (name === undefined || backgroundJobOf(deps.conversations, conversationId, name) === undefined)) {
        return { outcome: "refused", note: PATTERN_ON_ONE_COMMAND };
    }
    const target = await waitTargetOf(deps.conversations, conversationId, name, deps.signal);
    if (target === undefined) {
        return { outcome: "unknown-target", note: NO_TARGET };
    }
    const result = await waitForWork(deps.conversations, conversationId, {
        ...opt("target", target === "any" ? undefined : target),
        until: asked.states,
        timeoutMs,
        signal: deps.signal,
        ...opt("pattern", asked.pattern),
    });
    // The shared answer's own note, where it has one, says more than the generic one.
    return { ...opt("note", result.outcome === "unknown-target" ? NOTHING_TO_WAIT_FOR : undefined), ...workWaitAnswer(result, deps.lookups) };
};

/** The wait tool: on one target, several, "any" or "all", for states or, on one command, a line of its output. */
export const waitTool = (deps: WaitToolDeps) =>
    sdk().tool(
        "wait",
        WAIT_WORDS,
        {
            // Optional because `targets` stands in for it: required, it refused every call naming only `targets`, the
            // way the description tells the model to wait on several (26 failed calls in 25 conversations, 10-16..10-26).
            target: z
                .string()
                .min(1)
                .optional()
                .describe(
                    'The subagent\'s id (its call\'s, Claude\'s agentId, or the one spawn returned), a background command\'s ID, "any", or "all" for every child still running. Leave it out when you name `targets`.',
                ),
            targets: z
                .array(z.string().min(1))
                .min(1)
                .optional()
                .describe("Several subagent or background command ids, waited on as one; `target` is then ignored. Returns early only for trouble."),
            until: UntilSchema.describe(UNTIL_WORDS),
            timeoutSeconds: z.number().optional().describe(`Default ${DEFAULT_TIMEOUT_S}; clamped to 5..${MAX_TIMEOUT_S} seconds`),
        },
        async (args) => {
            if (deps.conversationId === undefined) {
                return asText(JSON.stringify({ outcome: "unknown-target", note: "This turn has no conversation, so it has no children to wait on." }));
            }
            const asked = untilAsked(args.until);
            if ("refused" in asked) {
                return asText(JSON.stringify({ outcome: "refused", note: asked.refused }));
            }
            const timeoutMs = Math.round(Math.min(Math.max(5, args.timeoutSeconds ?? DEFAULT_TIMEOUT_S), MAX_TIMEOUT_S) * 1000);
            if (args.targets === undefined && args.target !== "all") {
                return asText(JSON.stringify(await waitOnOne(deps, deps.conversationId, args.target, asked, timeoutMs)));
            }
            if (asked.pattern !== undefined) {
                return asText(JSON.stringify({ outcome: "refused", note: PATTERN_ON_ONE_COMMAND }));
            }
            const targets = await waitTargetsOf(deps.conversations, deps.conversationId, args.targets, deps.signal);
            return asText(JSON.stringify({ ...(await waitOnMany(deps, deps.conversationId, targets, timeoutMs)) }));
        },
        // Moves only which endings this conversation was told, marked as a wait settles, so parallel waits never share one.
        { annotations: toolAnnotations("read") },
    );
