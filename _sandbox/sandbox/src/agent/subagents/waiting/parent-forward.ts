import { readFile, realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type { RunnerSubagentResult } from "@intentic/sandbox-contract/protocol/doors/runner-protocol";
import type { Logger } from "pino";
import { z } from "zod";
import type { ConversationActors } from "../../../conversations/actor/conversation-actors.js";
import { parseBody, type ParentSubagentCall, type ToolArgs } from "../../../runners/fleet/parent-subagents.js";
import { ROSTER, subagentRunning } from "../../../conversations/actor/subagent-roster.js";
import { backgroundJobOf, runningJobsOf } from "../../tools/jobs/background-jobs.js";
import { boundChildReport, reportBoundOf, type ServerTool, type SubagentToolsWrap } from "./subagent-wait.js";
import { childNamed } from "./wait-targets.js";
import { WORDS_SAID, wordsSaid } from "./work-wait.js";

// A runner's turn hands the tools that touch children to its parent (runners/fleet/parent-subagents.ts has the call, and
// says why); this wraps the `subagents` server's tools so each of those goes there, and the rest stays on the runner.

/** The tools the parent runs for a conversation it placed here; every other tool of the server runs on the runner. */
export const PARENT_RUN_TOOLS: ReadonlySet<string> = new Set([
    "providers",
    "spawn",
    "send",
    "cancel",
    "answer",
    "merge",
    "settle",
    "wait",
    "workflow",
    "workflow_status",
    "workflow_stop",
]);

// How long past a call's own wait the parent is given to answer before the link is called dropped.
const ANSWER_MARGIN_MS = 60_000;
// A call that does not wait (a spawn's placement and admission, a send that moves a child) is answered well within this.
const PLAIN_CALL_MS = 300_000;
// The wait tool's own default and ceiling (wait-tool.ts), and workflow_status's ceiling (script-run-tools.ts).
const WAIT_DEFAULT_S = 600;
const WAIT_MAX_S = 1800;

const NumberField = z.object({ timeoutSeconds: z.number().optional(), waitSeconds: z.number().optional() }).partial();

/** How long the parent is given to answer this call: the call's own wait, clamped as the tool clamps it, and a margin. */
export const callDeadlineMs = (tool: string, args: ToolArgs): number => {
    const asked = NumberField.safeParse(args);
    const fields = asked.success ? asked.data : {};
    if (tool === "wait") {
        return Math.min(Math.max(5, fields.timeoutSeconds ?? WAIT_DEFAULT_S), WAIT_MAX_S) * 1000 + ANSWER_MARGIN_MS;
    }
    if (tool === "workflow_status") {
        return Math.min(Math.max(0, fields.waitSeconds ?? 0), WAIT_MAX_S) * 1000 + ANSWER_MARGIN_MS;
    }
    return PLAIN_CALL_MS;
};

type ToolResult = Awaited<ReturnType<ServerTool["handler"]>>;
// What the SDK hands a handler beside its arguments, passed through untouched.
type ToolExtra = Parameters<ServerTool["handler"]>[1];

// What the forwarding itself answers, in the wait tool's and the supervision tools' own shape.
interface ForwardAnswer {
    readonly ok?: false;
    readonly outcome: "message" | "unreachable" | "aborted";
    readonly note?: string;
    readonly message?: string;
}
const text = (payload: ForwardAnswer): ToolResult => ({ content: [{ type: "text", text: JSON.stringify(payload) }] });

export interface ParentSubagentsDeps {
    readonly conversationId: string;
    readonly call: ParentSubagentCall;
    // This runner's own holdings: the commands and in-process subagents the conversation runs here, and steering.
    readonly conversations: Pick<ConversationActors, "holdings">;
    readonly signal: AbortSignal;
    // Where a report too long to hand over whole is kept, on this runner, so the turn can retrieve the rest.
    readonly logsDir: string;
    // The turn's own tree here, which a workflow's `scriptPath` names a file in.
    readonly cwd: string;
    readonly logger: Pick<Logger, "warn">;
    // The conversations already told their parent is too old for the door, so each is told once.
    readonly toldOld: Set<string>;
}

const WaitArgsSchema = z.object({ target: z.string().optional(), targets: z.array(z.string()).optional() });

const ReportRowSchema = z.looseObject({ report: z.string().optional() });
type ReportRow = z.infer<typeof ReportRowSchema>;
// A wait's answer: one child's report at the top (work-wait.ts workWaitAnswer), several children's each in its row.
const ReportedSchema = z.looseObject({
    outcome: z.string().optional(),
    report: z.string().optional(),
    agents: z.array(ReportRowSchema).optional(),
});
const TextBlockSchema = z.object({ type: z.literal("text"), text: z.string() });

// The wait's answer as relayed, with the outcome it names (undefined where it names none).
interface Bounded {
    readonly result: ToolResult;
    readonly outcome: string | undefined;
}

// The parent hands each report over whole: bounded here, where the rest is kept for this turn to retrieve.
const boundedHere = (deps: ParentSubagentsDeps, result: RunnerSubagentResult): Bounded => {
    // SAFETY: the door relays the parent's tool result, content blocks the SDK's own tools produced.
    const relayed = result as ToolResult;
    const first = TextBlockSchema.safeParse(result.content[0]);
    const said = first.success ? parseBody(ReportedSchema, first.data.text) : undefined;
    if (said === undefined) {
        return { result: relayed, outcome: undefined };
    }
    const bound = reportBoundOf(deps.conversationId);
    const options = { logsDir: deps.logsDir };
    const of = (row: ReportRow): ReportRow => (row.report === undefined ? row : { ...row, report: boundChildReport(row.report, options, bound) });
    const payload = of(said);
    const rows = said.agents;
    if (rows !== undefined) {
        payload["agents"] = rows.map(of);
    }
    return { result: { ...relayed, content: [{ type: "text", text: JSON.stringify(payload) }, ...relayed.content.slice(1)] }, outcome: said.outcome };
};

const ScriptArgsSchema = z.looseObject({ script: z.string().optional(), scriptPath: z.string().optional() });

// A workflow named by a file in this turn's tree: read here, since the parent's copy of the tree lags this turn's edits.
const withScriptRead = async (cwd: string, args: ToolArgs): Promise<ToolArgs> => {
    const asked = ScriptArgsSchema.safeParse(args);
    if (!asked.success || asked.data.script !== undefined || asked.data.scriptPath === undefined) {
        return args;
    }
    const { scriptPath, ...rest } = asked.data;
    try {
        const [real, root] = await Promise.all([realpath(resolve(cwd, scriptPath)), realpath(cwd)]);
        if (real !== root && !real.startsWith(`${root}${sep}`)) {
            return args;
        }
        return { ...rest, script: await readFile(real, "utf8") };
    } catch {
        // allow(silent-catch): a file that cannot be read here goes as named, and the parent's refusal says why
        return args;
    }
};

const OLD_PARENT =
    "This conversation runs on a runner, and the sandbox it runs for is too old to supervise subagents for it, so this ran on " +
    "the runner: subagents started here live on the runner, off the board the person watches, and land from there.";

const unreachable = (tool: string, message: string): ToolResult =>
    text({
        ok: false,
        outcome: "unreachable",
        message:
            `This conversation runs on a runner, and its subagents belong to the sandbox it runs for, which did not answer ` +
            `this \`${tool}\` (${message}). Nothing was done here in its place. Call it again once that sandbox is back${tool === "spawn" ? "; a spawn it took before the link dropped is on its board, so check with wait before spawning the same task again" : ""}.`,
    });

// What the parent made of a call: a result to hand over, a sign the call is the runner's own to serve, or an answer the
// forwarding gives itself (words heard, a parent out of reach, a stopped turn).
type ParentReply =
    | { readonly kind: "result"; readonly result: ToolResult; readonly outcome: string | undefined }
    | { readonly kind: "here"; readonly old: boolean }
    | { readonly kind: "said"; readonly result: ToolResult; readonly unreachable?: true };

// One call asked of the parent, its words-heard race and its fallbacks read; `signal` ends it.
const askParent = async (deps: ParentSubagentsDeps, tool: string, args: ToolArgs, signal: AbortSignal): Promise<ParentReply> => {
    const sent = tool === "workflow" ? await withScriptRead(deps.cwd, args) : args;
    const listening = new AbortController();
    const both = AbortSignal.any([signal, listening.signal]);
    // Words said into this turn reach it here, never at the parent: a wait hands the turn back for them as it would locally.
    const heard = tool === "wait" ? wordsSaid(deps.conversations, deps.conversationId, both).then(() => ({ kind: "heard" as const })) : new Promise<never>(() => undefined);
    const answer = await Promise.race([deps.call(tool, sent, deps.conversationId, { timeoutMs: callDeadlineMs(tool, args), signal: both }), heard]);
    listening.abort();
    switch (answer.kind) {
        case "heard":
            return { kind: "said", result: text({ outcome: "message", note: WORDS_SAID }) };
        case "answered":
            if (tool !== "wait") {
                // SAFETY: the door relays the parent's tool result, content blocks the SDK's own tools produced.
                return { kind: "result", result: answer.result as ToolResult, outcome: undefined };
            }
            return { kind: "result", ...boundedHere(deps, answer.result) };
        case "not-placed":
            return { kind: "here", old: false };
        case "no-door":
            deps.logger.warn(
                { conversationId: deps.conversationId, tool, status: answer.status },
                "runner: the parent does not run subagent tools for runners (an older build) or refused this runner's token, so this ran here",
            );
            return { kind: "here", old: true };
        case "unreachable":
            return { kind: "said", result: unreachable(tool, answer.message), unreachable: true };
        case "aborted":
            return { kind: "said", result: text({ outcome: "aborted" }) };
    }
};

// A result served here because the parent is too old for the door, told so once per conversation.
const toldOnce = (deps: ParentSubagentsDeps, result: ToolResult): ToolResult => {
    if (deps.toldOld.has(deps.conversationId)) {
        return result;
    }
    deps.toldOld.add(deps.conversationId);
    return { ...result, content: [...result.content, { type: "text", text: OLD_PARENT }] };
};

// A call answered by the parent, or here where the parent says it is not one of its; `here` serves it on the runner.
const parentOrHere = async (deps: ParentSubagentsDeps, tool: string, args: ToolArgs, here: () => Promise<ToolResult>): Promise<ToolResult> => {
    const reply = await askParent(deps, tool, args, deps.signal);
    if (reply.kind === "here") {
        const result = await here();
        return reply.old ? toldOnce(deps, result) : result;
    }
    // Nothing of the parent's to wait on: "any" then reads the commands this turn runs here, as a local wait does.
    if (reply.kind === "result" && tool === "wait" && reply.outcome === "unknown-target") {
        return here();
    }
    return reply.result;
};

// Work this turn runs here: a background command, or an in-process subagent or a child this runner spawned itself.
const ranHere = (deps: ParentSubagentsDeps, name: string): boolean =>
    backgroundJobOf(deps.conversations, deps.conversationId, name) !== undefined || childNamed(deps.conversations, deps.conversationId, name) !== undefined;

// What of this turn's still runs here for a wait on "any" (children and commands) or "all" (children only), by id.
const liveHere = (deps: ParentSubagentsDeps, name: "any" | "all"): readonly string[] => [
    ...deps.conversations
        .holdings(ROSTER)
        .of(deps.conversationId)
        .filter(subagentRunning)
        .map((record) => record.id),
    ...(name === "any" ? runningJobsOf(deps.conversations, deps.conversationId).map((job) => job.id) : []),
];

// The outcome a wait served here answers with.
const OutcomeSchema = z.looseObject({ outcome: z.string().optional() });
const outcomeOf = (result: ToolResult): string | undefined => {
    const first = TextBlockSchema.safeParse(result.content[0]);
    return first.success ? parseBody(OutcomeSchema, first.data.text)?.outcome : undefined;
};

const PARENT_SILENT =
    "The sandbox this conversation runs for did not answer, so its subagents were not waited on: this answer is about the work running here only.";

// A wait on work on both machines: the runner's half here and the parent's there, whichever moves first answering, the
// other then stopped. A half that has nothing to wait on (or a parent that cannot be asked) leaves the answer to the other.
// `local` is one wait, or several raced (a wait on "any": each thing running here waited on by itself, since a local
// "any" stops counting commands once no child is left here, and the parent's children are still running).
const raceWait = async (
    deps: ParentSubagentsDeps,
    waitOn: (signal: AbortSignal) => ServerTool,
    extra: ToolExtra,
    local: ToolArgs | readonly ToolArgs[],
    remote: ToolArgs,
): Promise<ToolResult> => {
    const stop = new AbortController();
    const signal = AbortSignal.any([deps.signal, stop.signal]);
    const waits = (Array.isArray(local) ? local : [local]).map((args: ToolArgs) => waitOn(signal).handler(args, extra));
    const here = Promise.race(waits).then((result) => ({ side: "here" as const, result, outcome: outcomeOf(result) }));
    const there = askParent(deps, "wait", remote, signal).then((reply) => ({ side: "parent" as const, reply }));
    const first = await Promise.race([here, there]);
    if (first.side === "here" && first.outcome !== "unknown-target") {
        stop.abort();
        return first.result;
    }
    if (first.side === "parent" && first.reply.kind === "result" && first.reply.outcome !== "unknown-target") {
        stop.abort();
        return first.reply.result;
    }
    if (first.side === "parent" && first.reply.kind === "said" && first.reply.unreachable !== true) {
        stop.abort();
        return first.reply.result;
    }
    // One half had nothing to wait on, or the parent is out of reach or not asked: the other half answers.
    if (first.side === "here") {
        const { reply } = await there;
        return reply.kind === "here" ? first.result : reply.result;
    }
    const mine = await here;
    const reply = first.reply;
    if (reply.kind === "here") {
        return reply.old ? toldOnce(deps, mine.result) : mine.result;
    }
    return reply.kind === "said" ? { ...mine.result, content: [...mine.result.content, { type: "text", text: PARENT_SILENT }] } : mine.result;
};

// A wait: on work running here, here; on the parent's children, at the parent; on both, raced (raceWait).
const forwardedWait =
    (deps: ParentSubagentsDeps, tool: ServerTool, waitOn: (signal: AbortSignal) => ServerTool): ServerTool["handler"] =>
    async (args, extra) => {
        const here = (): Promise<ToolResult> => tool.handler(args, extra);
        const asked = WaitArgsSchema.safeParse(args);
        const { target, targets } = asked.success ? asked.data : {};
        if (targets === undefined && (target === "any" || target === "all")) {
            const live = liveHere(deps, target);
            if (live.length === 0) {
                return parentOrHere(deps, "wait", args, here);
            }
            const { target: _any, ...rest } = args;
            const local = target === "any" ? live.map((id) => ({ ...rest, target: id })) : args;
            return raceWait(deps, waitOn, extra, local, args);
        }
        const names = targets ?? (target === undefined ? [] : [target]);
        const local = names.filter((name) => ranHere(deps, name));
        const remote = names.filter((name) => !ranHere(deps, name));
        // Naming nothing is answered here, as a local wait answers it.
        if (remote.length === 0) {
            return here();
        }
        if (local.length === 0) {
            return parentOrHere(deps, "wait", args, here);
        }
        const { target: _one, ...rest } = args;
        return raceWait(deps, waitOn, extra, { ...rest, targets: local }, { ...rest, targets: remote });
    };

const ChildArgSchema = z.object({ child: z.string() });

// One tool of the server, run by the parent for this conversation, and here where the parent says it is not one of its,
// or where it names a child this runner holds itself (one spawned here while the parent was too old for the door).
const forwarded = (deps: ParentSubagentsDeps, tool: ServerTool): ServerTool["handler"] => async (args, extra) => {
    const here = (): Promise<ToolResult> => tool.handler(args, extra);
    const child = ChildArgSchema.safeParse(args);
    if (child.success && childNamed(deps.conversations, deps.conversationId, child.data.child) !== undefined) {
        return here();
    }
    return parentOrHere(deps, tool.name, args, here);
};

/** The server's tools with each the parent runs handed to it; the rest as they were. */
export const parentSubagentTools =
    (deps: ParentSubagentsDeps) =>
    (tools: ServerTool[], waitOn: (signal: AbortSignal) => ServerTool): ServerTool[] =>
        tools.map((tool) => {
            if (!PARENT_RUN_TOOLS.has(tool.name)) {
                return tool;
            }
            return { ...tool, handler: tool.name === "wait" ? forwardedWait(deps, tool, waitOn) : forwarded(deps, tool) };
        });

// Every conversation on this runner told its parent is too old, for this daemon's life.
const TOLD_OLD = new Set<string>();

export interface ParentSubagentsMount {
    readonly runnerParent?: { readonly current?: { readonly subagents?: ParentSubagentCall } };
    readonly conversations: Pick<ConversationActors, "holdings">;
    readonly logger: Pick<Logger, "warn">;
}

/**
 * How the `subagents` server of a turn is wrapped: on a runner, for a turn of a conversation, its children's tools go to
 * the parent; anywhere else, unchanged.
 */
export const parentSubagentsWrap = (
    services: ParentSubagentsMount,
    turn: { readonly conversationId: string | undefined; readonly signal: AbortSignal; readonly logsDir: string; readonly cwd: string },
): SubagentToolsWrap => {
    const call = services.runnerParent?.current?.subagents;
    if (call === undefined || turn.conversationId === undefined) {
        return (tools) => tools;
    }
    return parentSubagentTools({
        conversationId: turn.conversationId,
        call,
        conversations: services.conversations,
        signal: turn.signal,
        logsDir: turn.logsDir,
        cwd: turn.cwd,
        logger: services.logger,
        toldOld: TOLD_OLD,
    });
};
