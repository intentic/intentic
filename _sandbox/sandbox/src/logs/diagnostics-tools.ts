import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { sdk } from "../engines/claude-sdk.js";
import {
    type DiagnosticsQuery,
    DiagnosticsErrorsArgs,
    DiagnosticsResourcesArgs,
    DiagnosticsRestartsArgs,
    DiagnosticsSlowArgs,
    DiagnosticsTimelineArgs,
    DiagnosticsTurnsArgs,
} from "@intentic/sandbox-contract/schemas/diagnostics";
import { toolAnnotations } from "@intentic/sandbox-contract/peer-mcp-server";
import { type DiagnosticsDeps, runDiagnosticsQuery } from "./diagnostics-queries.js";

// The diagnostics queries (diagnostics-queries.ts) as the tools a turn mounts: each tool's description, its arguments as
// the contract spells them (schemas/diagnostics.ts), and the one answer every door gives. Read-only, every one.

export type DiagnosticsToolDeps = DiagnosticsDeps;

const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });

// What every log line is, said once in each description that reads them: agents wrote jq against `.msg` and read blanks.
const LINE_SCHEMA =
    "Lines are pino JSON: `time` (ISO), `level` (a label), `message` (not `msg`), `ctx.conversationId` and `ctx.requestId`, " +
    "`err` for an exception; jq `.message` when reading /history/logs/daemon.log yourself.";

const answer = async (deps: DiagnosticsToolDeps, ask: DiagnosticsQuery) => ok(await runDiagnosticsQuery(deps, ask));

const read = { annotations: toolAnnotations("read") };

export const createDiagnosticsServer = (deps: DiagnosticsToolDeps): McpSdkServerConfigWithInstance =>
    sdk().createSdkMcpServer({
        name: "diagnostics",
        tools: [
            sdk().tool(
                "errors",
                `What went wrong, newest first. Reach for this BEFORE re-instrumenting code or trying to reproduce a bug. ` +
                    `\`source: "daemon"\` (the default) is the sandbox's own log (daemon.log, and daemon.log.1 when the window reaches ` +
                    `back into it): failing turns, refused providers, crashed automations, unhandled rejections. ` +
                    `\`source: "browser"\` is what the EDITOR reported about itself (client.jsonl): render errors, stalls the user felt, ` +
                    `startup recoveries, each with the page the user was on. Many matches are grouped by message with a count and ` +
                    `first/last time; stacks are left out unless asked for. ${LINE_SCHEMA}`,
                DiagnosticsErrorsArgs,
                async (args) => answer(deps, { query: "errors", ...args }),
                read,
            ),
            sdk().tool(
                "slow",
                "Operations the daemon measured as slower than their budget (perf.jsonl holds only the slow ones, not every span), " +
                    "each with the machine's one-minute load at the time: the load separates a real regression from a busy machine. " +
                    "Many matches are grouped (count, p50, p95, max and the worst one); `groupBy` chooses how. " +
                    '`source: "rollups"` answers instead from every span, slow or not, kept two weeks as ten-minute histograms per op ' +
                    "and subject: true counts, total time, failures and p50/p90/p99/max over any window, for a performance audit or " +
                    "a question about what is normal. The answer names the file it came from.",
                DiagnosticsSlowArgs,
                async (args) => answer(deps, { query: "slow", ...args }),
                read,
            ),
            sdk().tool(
                "turns",
                "How recent agent turns ended: which model actually ran, what it cost, for a failed one its error code and the " +
                    "provider's own sentence, and for one that ran, whether anything CHECKED the work it did. This is the durable " +
                    "record, so it answers questions about turns nobody was watching, and it is the place to look when a session " +
                    "died, a turn produced the wrong provider's error, or several conversations broke at once. " +
                    '`verification` is the part a status word cannot give you: "verified" means a check passed after the last code ' +
                    'edit and `check` names it, "unproven" means nothing ran, "failing" means the last one did not pass, "no-code" ' +
                    "means nothing a check could speak to was edited. A turn ending with `checklistOpen` above zero abandoned a plan " +
                    "it wrote itself, which is what a turn that stopped rather than finished looks like from here. `toolCalls` shows " +
                    "only when it is zero: the turn produced words and acted on nothing, the shape of a model that announced a step " +
                    "and then stopped. A turn that simply answered a question reads the same, so weigh it against what was asked.",
                DiagnosticsTurnsArgs,
                async (args) => answer(deps, { query: "turns", ...args }),
                read,
            ),
            sdk().tool(
                "resources",
                "One field of the sandbox's resource series over time, sampled once a minute and kept about a week. Answers what a " +
                    "log cannot: was the machine out of memory, was the event loop stalling, who was holding the RAM, did the kernel " +
                    "kill anything. min, mean and max cover every sample in the window; a long window is thinned to `limit` rows, each " +
                    "the largest of its slice. A path naming an object or a list (`system`, `processes.top`) answers with its newest " +
                    "value instead. Useful paths: `system.cgroup.event_oom_kill` (processes the kernel killed), " +
                    "`processes.byRole.toolchain.rssBytes` (a build, test or typecheck fan-out; also browser, agentRuntime, localModel, " +
                    "container, searchEngine, terminal, languageServer, git, extension), `processes.top` (the eight heaviest " +
                    "processes by resident plus swapped, each with its `owner`, the conversation whose turn or job started it or " +
                    "`daemon` / `one-shot`, absent on a process nothing stamped, and its `jobId` when it ran under a job (a background " +
                    "job, or a foreground command filed as one)), `processes.byOwner` (count, rssBytes and swapBytes per owner, " +
                    "unstamped processes under `unstamped`, e.g. `processes.byOwner.<conversationId>.rssBytes`: which conversation " +
                    "holds the memory), " +
                    "`window.eventLoop.delayP99Ms`, `window.cpu.utilizationPercent`, `daemon.memory.rssBytes`, " +
                    "`system.pressure.memory.some`, `system.loadAverage`, `uptimeSeconds`, and `queue.heavy.longestHoldSeconds` " +
                    "(with .held and .slots) for a heavy command that took a queue slot and did not give it back.",
                DiagnosticsResourcesArgs,
                async (args) => answer(deps, { query: "resources", ...args }),
                read,
            ),
            sdk().tool(
                "restarts",
                "The daemon's boots, newest first, and for each why the run before it ended: stopped cleanly or killed, on which " +
                    "signal, after how long, and who asked for it (the owner, `ic`, the host's keeper, an update) with their reason. " +
                    "A run killed without warning is named where the records allow: `netd-stuck` (netd killed a daemon that stopped " +
                    "answering or never said hello) or `oom-victim` (the kernel's OOM killer chose the daemon), and each unclean stop's " +
                    "post-mortem says what was killed for memory, by whom (netd's guard, the sandbox's own memory bound, the kernel's " +
                    "global OOM), whose process it was, and which conversations' turns it holds. Reach for it when turns were " +
                    "interrupted, a session vanished, or the editor reconnected by itself.",
                DiagnosticsRestartsArgs,
                async (args) => answer(deps, { query: "restarts", ...args }),
                read,
            ),
            sdk().tool(
                "timeline",
                "Everything recorded about ONE conversation, oldest first, one line per event: the daemon.log lines that name it (in " +
                    "`ctx.conversationId`, a field, or the message), its activity entries (turn started, completed or failed, " +
                    "dependency checks, CI repairs, refused pushes), its turns from the spend ledger, and the daemon boots in between. " +
                    "Use it instead of grepping /history for a conversation id. What was said is in `agents show <id> --transcript`.",
                DiagnosticsTimelineArgs,
                async (args) => answer(deps, { query: "timeline", ...args }),
                read,
            ),
        ],
    });
