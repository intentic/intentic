import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { matchCommand } from "@intentic/sandbox-contract";
import { sdk } from "../../runtimes/claude/claude-sdk.js";
import { z } from "zod";
import { commandRun } from "../../guard/actions.js";
import { createCredentialOracle } from "../../guard/credential-files.js";
import { guard } from "../../guard/guard.js";
import { armWatcher, cancelWatcher, DEFAULT_INTERVAL_S, DEFAULT_TIMEOUT_S, listWatchers, type WatcherTurnSeed } from "./watchers.js";

// The agent's door to the condition watch (watchers.ts): an SDK MCP server since the handler must run in the daemon,
// where the watch outlives the turn, and `alwaysLoad` keeps it in the prompt so it isn't replaced by a sleep-and-poll
// loop. The check is gated once at arm time under the same rulebook Bash runs under, since nobody will be there later
// to answer a card; a held or denied class is refused outright, worded to send the agent through Bash instead.

export interface WatchServerDeps {
    // Absent for a conversationless turn (the bench): a watch with no conversation has nowhere to deliver its wake.
    readonly conversationId: string | undefined;
    // The tree and credentials the check runs with, snapshotted since the turn will be long gone at check time.
    readonly cwd: string;
    readonly env: Readonly<Record<string, string>>;
    // The turn identity the wake must reproduce, see WatcherTurnSeed.
    readonly turn: WatcherTurnSeed;
}

const answer = (payload: Record<string, unknown>): { content: [{ type: "text"; text: string }] } => ({
    content: [{ type: "text", text: JSON.stringify(payload) }],
});

// A watch check is judged only against the hard rule, never the safety judge: every judge input is a property of a turn
// that won't exist when the check fires, and `ask` has nobody to answer it at 3am. Everything else arms; the refusal
// says what to do instead.
const ruleRefusal = (command: string, cwd: string): string | undefined => {
    // Same fact-check the command gate runs, at the sandbox locus, so a `.env` of ports isn't refused as secret.
    for (const match of matchCommand(command, { locus: "sandbox", holdsSecret: createCredentialOracle(cwd) })) {
        const verdict = guard(commandRun, { commandClass: match.commandClass, locus: "sandbox", live: match.live });
        if (verdict.effect !== "allow") {
            return `${verdict.reason}: a watch check runs unattended, so it cannot ask. Run the command through Bash instead, or watch with a narrower read-only check.`;
        }
    }
    return undefined;
};

export const watchServer = (deps: WatchServerDeps): McpSdkServerConfigWithInstance =>
    sdk().createSdkMcpServer({
        name: "watch",
        alwaysLoad: true,
        tools: [
            sdk().tool(
                "start",
                "Watch an outside condition and get woken when it fires: instead of writing a polling loop. Give a cheap " +
                    "check command that exits 0 once the condition is met and non-zero while still waiting (e.g. query a CI " +
                    "run's status and exit 0 only on completion). The check runs once now: a broken command fails to your " +
                    "face: then the daemon re-runs it on the interval after your turn ends, and when it passes (or the " +
                    "timeout hits, whichever first) this conversation is woken exactly once with the check's output. Use for " +
                    "CI runs, deploys, remote queues: anything outside this sandbox. Do NOT use it for work you started " +
                    "here (background commands, subagents, delegated CLIs): the harness already notifies you about those, " +
                    "and the wait tool covers parking on them mid-turn.",
                {
                    command: z
                        .string()
                        .min(1)
                        .describe("The check. Exit 0 = condition met (fires the wake); non-zero = still waiting. Keep it cheap and read-only."),
                    note: z
                        .string()
                        .min(1)
                        .max(200)
                        .describe('One line on what is being watched, e.g. "CI run 316 on intentic/intentic": shown in the wake and to the user.'),
                    intervalSeconds: z
                        .number()
                        .min(10)
                        .max(1800)
                        .optional()
                        .describe(`Seconds between checks, matched to how fast the state actually changes. Default ${DEFAULT_INTERVAL_S}.`),
                    timeoutSeconds: z
                        .number()
                        .min(60)
                        .max(86_400)
                        .optional()
                        .describe(`Deadline. If the check never passes, you are woken anyway with its last output. Default ${DEFAULT_TIMEOUT_S}.`),
                },
                async (args) => {
                    if (deps.conversationId === undefined) {
                        return answer({
                            outcome: "refused",
                            reason: "This turn has no conversation, so a watch would have nowhere to deliver its wake.",
                        });
                    }
                    const refusal = ruleRefusal(args.command, deps.cwd);
                    if (refusal !== undefined) {
                        return answer({ outcome: "refused", reason: refusal });
                    }
                    const outcome = await armWatcher({
                        conversationId: deps.conversationId,
                        command: args.command,
                        note: args.note,
                        ...(args.intervalSeconds !== undefined ? { intervalSeconds: args.intervalSeconds } : {}),
                        ...(args.timeoutSeconds !== undefined ? { timeoutSeconds: args.timeoutSeconds } : {}),
                        cwd: deps.cwd,
                        env: deps.env,
                        turn: deps.turn,
                    });
                    if (outcome.kind === "refused") {
                        return answer({ outcome: "refused", reason: outcome.reason });
                    }
                    if (outcome.kind === "already-met") {
                        return answer({
                            outcome: "already-met",
                            note: "The check already exits 0, the condition holds now. Nothing was armed and no wake is coming; act on the output directly.",
                            firstCheck: outcome.firstCheck,
                        });
                    }
                    return answer({
                        outcome: "armed",
                        watchId: outcome.id,
                        intervalSeconds: outcome.intervalSeconds,
                        timeoutSeconds: outcome.timeoutSeconds,
                        firstCheck: outcome.firstCheck,
                        note: "You can end this turn, the watch runs without you and this conversation is woken when it fires or times out.",
                    });
                },
            ),
            sdk().tool(
                "stop",
                "Stop an armed watch by id (from watch start), when the condition stopped mattering. No wake will fire for it. Passing no id lists this conversation's armed watches instead.",
                {
                    watchId: z.string().min(1).optional().describe("The id to stop. Omit to list armed watches."),
                },
                async (args) => {
                    if (deps.conversationId === undefined) {
                        return answer({ outcome: "none", watches: [] });
                    }
                    if (args.watchId === undefined) {
                        return answer({ outcome: "listed", watches: listWatchers(deps.conversationId) });
                    }
                    // Awaited: the disarm reaches the watch journal too, so a container recreate can't undo a stop
                    // moments later.
                    const stopped = await cancelWatcher(deps.conversationId, args.watchId);
                    return stopped
                        ? answer({ outcome: "stopped", watchId: args.watchId })
                        : answer({
                              outcome: "unknown-watch",
                              note: "No armed watch of this conversation has that id, it may have fired, timed out, or been stopped already.",
                          });
                },
            ),
        ],
    });
