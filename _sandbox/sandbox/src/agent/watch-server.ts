import { createSdkMcpServer, type McpSdkServerConfigWithInstance, tool } from "@anthropic-ai/claude-agent-sdk";
import { type AdmissionRule, classifyCommand, type CommandClass } from "@intentic/sandbox-contract";
import { z } from "zod";
import { commandRun } from "../guard/actions.js";
import { createCredentialOracle } from "../guard/credential-files.js";
import { guard } from "../guard/guard.js";
import { armWatcher, cancelWatcher, DEFAULT_INTERVAL_S, DEFAULT_TIMEOUT_S, listWatchers, type WatcherTurnSeed } from "./watchers.js";

/* THE AGENT'S DOOR TO THE CONDITION WATCH (agent/watchers.ts), an SDK MCP server for the same reasons
 * subagent-wait.ts is one: the handler runs in the daemon (where the watch must live, since the turn's own
 * process dies with the turn), and `alwaysLoad` keeps it in the prompt, a tool the model has to go looking
 * for is a tool it replaces with the sleep-and-poll loop this exists to retire.
 *
 * THE CHECK IS GATED AT ARM TIME, ONCE, with the same rulebook Bash runs under (guard/command-gate.ts). The
 * check will run repeatedly, later, with nobody there to answer a card, so a command whose class the owner
 * holds or denies is refused here outright, worded so the agent runs it through Bash instead (where a hold can
 * actually be asked). The classifier is regex over shell text and this is friction, not a boundary, the same
 * honest reading command-gate gives of itself. */

export interface WatchServerDeps {
    // Absent for a conversationless turn (the bench): the tools then refuse, a watch with no conversation has
    // nowhere to deliver its wake.
    readonly conversationId: string | undefined;
    // The tree the check runs in (the turn's effective checkout) and the capability credentials it runs with,
    // snapshotted into the watch, because the turn they belong to will be long gone at check time.
    readonly cwd: string;
    readonly env: Readonly<Record<string, string>>;
    // The owner's command rulebook, applied at arm time as above. Empty ⇒ everything arms.
    readonly commandRules: Partial<Readonly<Record<CommandClass, AdmissionRule>>>;
    // The turn identity the wake must reproduce, see WatcherTurnSeed.
    readonly turn: WatcherTurnSeed;
}

const answer = (payload: Record<string, unknown>): { content: [{ type: "text"; text: string }] } => ({
    content: [{ type: "text", text: JSON.stringify(payload) }],
});

// The strictest refusal across the check's classes, deny and hold refuse alike, because the check runs later
// and repeatedly, where nobody can answer a hold.
const ruleRefusal = (command: string, rules: WatchServerDeps["commandRules"], cwd: string): string | undefined => {
    // The same fact-check the command gate runs, for the same reason: a check that reads a `.env` of ports must
    // not be refused as a credential read, least of all with a message telling the agent to go and ask about it.
    for (const commandClass of classifyCommand(command, { holdsSecret: createCredentialOracle(cwd) })) {
        const verdict = guard(commandRun, { commandClass, rules });
        if (verdict.effect !== "allow") {
            return `${verdict.reason}: a watch check runs unattended, so it cannot ask. Run the command through Bash instead, or watch with a narrower read-only check.`;
        }
    }
    return undefined;
};

export const watchServer = (deps: WatchServerDeps): McpSdkServerConfigWithInstance =>
    createSdkMcpServer({
        name: "watch",
        alwaysLoad: true,
        tools: [
            tool(
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
                    const refusal = ruleRefusal(args.command, deps.commandRules, deps.cwd);
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
            tool(
                "stop",
                "Stop an armed watch by id (from watch start), when the condition stopped mattering. No wake will fire for it. Passing no id lists this conversation's armed watches instead.",
                {
                    watchId: z.string().min(1).optional().describe("The id to stop. Omit to list armed watches."),
                },
                (args) => {
                    if (deps.conversationId === undefined) {
                        return Promise.resolve(answer({ outcome: "none", watches: [] }));
                    }
                    if (args.watchId === undefined) {
                        return Promise.resolve(answer({ outcome: "listed", watches: listWatchers(deps.conversationId) }));
                    }
                    const stopped = cancelWatcher(deps.conversationId, args.watchId);
                    return Promise.resolve(
                        stopped
                            ? answer({ outcome: "stopped", watchId: args.watchId })
                            : answer({
                                  outcome: "unknown-watch",
                                  note: "No armed watch of this conversation has that id, it may have fired, timed out, or been stopped already.",
                              }),
                    );
                },
            ),
        ],
    });
