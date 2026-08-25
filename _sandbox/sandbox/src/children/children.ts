import type { AgentEvent, AgentHarness, AgentProvider, AgentTurn } from "@intentic/sandbox-contract";
import { newConversationId, PROVIDERS } from "@intentic/sandbox-contract";
import type { Services } from "../composition.js";
import { openSpawnedChild, noteSpawnedChild, settleSpawnedChild, type SubagentTurn } from "../agent/subagents.js";
import { startTurnRun } from "../agent/turn-runs.js";
import { openTurnTranscript, recordTurnTranscript } from "../sessions/turn-transcript.js";
import type { TurnFn } from "../loops/loop-runner.js";

/* SPAWN A FULL AGENT FROM INSIDE A TURN, on ANY connected provider, the daemon-side half of the `spawn` tool
 * (agent/subagent-wait.ts mounts it beside `wait`).
 *
 * THE CHILD IS AN ORDINARY CONVERSATION, and that one decision is most of this module. It runs through the same
 * detached pump every composer turn does (turn-runs.ts), so it is watchable from any window, stoppable with the
 * same /agent/stop, transcribed by the same record, isolated in a worktree of its own, and served by whichever
 * provider adapter its spec names — which is the entire point: the spawning turn's own runtime is irrelevant,
 * because the child rides the same adapter registry the composer does. A Claude turn spawns Cursor's Composer
 * with the same call a Cursor turn would spawn Codex with.
 *
 * WHAT THIS MODULE ITSELF OWNS is therefore only what a conversation does not: the parentage (which turn
 * started it, how deep the chain is), the budgets, and the child's life reported onto the parent's roster
 * (agent/subagents.ts, the `spawned` kind) — by direct call at each move, because the daemon is driving both
 * ends. No hook spools, no stdout tails, no regex over bash commands: those exist for children whose runtimes
 * this daemon does not run, and this is the kind whose runtime it does.
 *
 * THE BUDGETS ARE THE OWNER'S EXISTING ONES (SandboxSettings.subagentsAtOnce / subagentsPerTurn /
 * subagentDepth), enforced here in the daemon rather than handed to a harness as env, because a spawned child
 * gets the spawn tool too, and a cap a model is merely told about is a cap a runaway chain never reads. The
 * ledgers are in-memory like the roster's records and die with the daemon, which loses nothing that matters: a
 * daemon death also ends every child turn the ledgers were counting.
 *
 * A CHILD OUTLIVES ITS PARENT'S TURN on purpose, the same life a backgrounded delegation's process has: the
 * spawn tool answers the moment the child is running, and the parent supervises through `wait` — or walks away
 * and leaves the child to finish as a conversation in its own right, landing its work under the workspace's
 * ordinary posture. */

// How much of the child's closing text the spawn/wait surfaces carry inline. The full text is in the child's
// own transcript; this is the roster row's answer to "what did it conclude".
const REPORT_KEPT = 2_000;

/* Parentage and spend, per conversation. `depth` is keyed by the CHILD's conversation id (a conversation
 * absent here is depth 0, a person's own); `spent` by the PARENT's, counting what it has started, live and
 * lifetime. Module singletons for the roster's reason: the tool handler, the tests and any future route must
 * see the same ledgers. */
const depths = new Map<string, number>();
const spent = new Map<string, { live: number; total: number }>();

// Tests drive spawning through its real entry point, so they need a way back to empty between cases.
export const resetChildrenForTest = (): void => {
    depths.clear();
    spent.clear();
};

export interface ChildSpawnSpec {
    readonly prompt: string;
    // One line for the roster row and the child conversation's title. Falls back to the prompt's head.
    readonly description?: string;
    readonly provider?: AgentProvider;
    readonly harness?: AgentHarness;
    readonly model?: string;
    readonly effort?: string;
    readonly account?: string;
}

export interface ChildParent {
    readonly conversationId: string;
    // The parent turn's tree as the daemon reaches it, the roster handle's cwd.
    readonly cwd: string;
}

export type ChildSpawnResult =
    // `id` is the child's conversation id, the roster record's id, and the wait tool's target, one string.
    | { readonly ok: true; readonly id: string }
    | { readonly ok: false; readonly message: string };

// The provider's display label for the roster row ("Cursor", "Codex"); an id the catalog does not name (an
// endpoint, an installed ACP agent) shows as itself, which is at least true.
const labelOf = (provider: AgentProvider): string => PROVIDERS.find((entry) => entry.value === provider)?.label ?? provider;

/* What the child is waiting on, when a card parks its turn: the card's own words, one line. The parent's
 * `wait` returns `blocked` with this riding the record's summary, which is the difference between a parent
 * that can say "the child needs permission to run rm -rf build" and one that can only say "it stopped". */
const blockedReason = (event: AgentEvent): string | undefined => {
    if (event.kind === "question") {
        return event.questions[0]?.question ?? "Waiting on a question.";
    }
    if (event.kind === "permission") {
        return event.title ?? `Waiting on permission for ${event.toolName}.`;
    }
    if (event.kind === "plan") {
        return "Waiting for its plan to be approved.";
    }
    return undefined;
};

/** Start a child agent and return the moment it is running. Refusals are ordinary states (a budget met, a
 *  depth exhausted), worded for the model that asked; a provider refusal (nothing connected) arrives later,
 *  as the child's own failure, exactly as it would arrive to a person at the composer. */
export const spawnChild = async (services: Services, parent: ChildParent, spec: ChildSpawnSpec, turnFn: TurnFn): Promise<ChildSpawnResult> => {
    const settings = await services.sandboxSettings.get();
    const depth = (depths.get(parent.conversationId) ?? 0) + 1;
    if (depth > settings.subagentDepth) {
        return { ok: false, message: `Spawn depth ${settings.subagentDepth} reached: this agent is itself a spawned child and may not go deeper.` };
    }
    const ledger = spent.get(parent.conversationId) ?? { live: 0, total: 0 };
    if (ledger.live >= settings.subagentsAtOnce) {
        return { ok: false, message: `${ledger.live} children are already running: wait for one before starting another.` };
    }
    if (ledger.total >= settings.subagentsPerTurn) {
        return { ok: false, message: `This conversation has started ${ledger.total} children, its lifetime budget.` };
    }
    const provider = spec.provider ?? "claude";
    const harness = spec.harness ?? "native";
    const id = `sub-${newConversationId()}`;
    const description = (spec.description ?? spec.prompt).replaceAll(/\s+/gu, " ").trim().slice(0, 200);
    const turn: AgentTurn & { conversationId: string } = {
        prompt: spec.prompt,
        conversationId: id,
        title: description.slice(0, 80),
        // A worktree of its own, so parallel children (and the parent) never edit under each other. Landing
        // keeps the workspace's ordinary posture: a child's finished work merges the way any turn's does.
        isolated: true,
        // Nobody is at a composer. This is what the flag means, and it also sets the safe persona floor: an
        // unattended turn with no named persona speaks for no outside account.
        unattended: true,
        agent: provider,
        harness,
        ...(spec.model !== undefined ? { model: spec.model } : {}),
        ...(spec.effort !== undefined ? { effort: spec.effort } : {}),
        ...(spec.account !== undefined ? { account: spec.account } : {}),
    };
    /* The roster handle: the PARENT's conversation, which is what the record files under and what the wait
     * tool matches on. The session/subagentsDir halves are the SDK children's concern and stay empty here. */
    const handle: SubagentTurn = { conversationId: parent.conversationId, cwd: parent.cwd, sessionId: undefined, subagentsDir: undefined };
    const opened = openTurnTranscript(services, turn);
    const run = startTurnRun((input, signal) => turnFn(services, input, signal), turn, {
        before: opened,
        transcript: (events, startedAt) => recordTurnTranscript(services, turn, events, startedAt),
    });
    if (run === undefined) {
        // A fresh id colliding with a live run should be impossible; saying so beats pretending a child exists.
        return { ok: false, message: "The child's conversation could not be started." };
    }
    depths.set(id, depth);
    spent.set(parent.conversationId, { live: ledger.live + 1, total: ledger.total + 1 });
    openSpawnedChild(handle, {
        id,
        description,
        agentType: labelOf(provider),
        provider,
        harness,
        spawnDepth: depth,
        ...(spec.model !== undefined ? { model: spec.model } : {}),
    });
    // The child's whole life, reduced onto its roster record. Detached: the spawn answers now, the parent
    // supervises through `wait`, and the pump folds even a thrown turn into an error frame and a done.
    void (async () => {
        let bubble = "";
        let report = "";
        let toolUses = 0;
        let tokens = 0;
        let failure: string | undefined;
        try {
            for await (const { event } of run.follow(0)) {
                if (event.kind === "delta" && event.parentToolUseId === undefined) {
                    bubble += event.text;
                    continue;
                }
                if (event.kind === "text_end" && event.parentToolUseId === undefined) {
                    // The LAST closed bubble is the report: a turn's closing text is its answer, and the head
                    // of everything it ever said is its greeting.
                    report = bubble.trim() === "" ? report : bubble;
                    bubble = "";
                    continue;
                }
                if (event.kind === "tool_call" && event.parentToolUseId === undefined) {
                    toolUses += 1;
                    noteSpawnedChild(id, { toolUses, lastTool: event.name });
                    continue;
                }
                if (event.kind === "usage") {
                    tokens += (event.inputTokens ?? 0) + (event.outputTokens ?? 0);
                    noteSpawnedChild(id, { tokens });
                    continue;
                }
                const blocked = blockedReason(event);
                if (blocked !== undefined) {
                    noteSpawnedChild(id, { status: "blocked", summary: blocked });
                    continue;
                }
                if (event.kind === "resolved") {
                    noteSpawnedChild(id, { status: "running" });
                    continue;
                }
                if (event.kind === "error") {
                    failure = event.message;
                }
            }
        } catch (error) {
            failure = error instanceof Error ? error.message : String(error);
        } finally {
            const closing = (bubble.trim() !== "" ? bubble : report).trim().slice(0, REPORT_KEPT);
            settleSpawnedChild(id, {
                failed: failure !== undefined,
                report: closing,
                ...(failure !== undefined ? { error: failure } : {}),
            });
            const now = spent.get(parent.conversationId);
            if (now !== undefined) {
                spent.set(parent.conversationId, { live: Math.max(0, now.live - 1), total: now.total });
            }
        }
    })();
    return { ok: true, id };
};
