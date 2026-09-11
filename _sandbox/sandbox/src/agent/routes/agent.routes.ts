import { randomUUID } from "node:crypto";
import {
    type ActivityEvent,
    type AgentEvent,
    type AgentProvider,
    type AgentTurn,
    agentContract,
    capabilitiesOf,
    type ContextUsage,
    type EditorContext,
    KeyedProviderSchema,
    RESUME_NOTES,
    type SnapshotTurn,
    type TodoItem,
    type TurnNote,
    type UsageWindow,
    type WorkspaceEvent,
    mentionPaths,
} from "@intentic/sandbox-contract";
import { userRow } from "@intentic/sandbox-contract/transcript-fold";
import { implement, ORPCError } from "@orpc/server";
import { createOutboundSniffer } from "../../activity/outbound.js";
import { emitWorkspaceEvent } from "../../automations/workspace-events.js";
import { turnCliEnv } from "../../capabilities/turn-env.js";
import type { Services } from "../../composition.js";
import type { OrpcContext } from "../../app-env.js";
import type { DependencyLandOrigin } from "../../workspace/deps/dependency-origin.js";
import { REPO_SYNC_NOTE_TITLE, syncAdvisory, syncWorkspaceRepos } from "../../workspace/layout/sync-repos.js";
import { resolveWithin } from "../../workspace/files/workspace-files-paths.js";
import { startAnchor, type TurnPlacement } from "../../agents/worktrees/isolation.js";
import { holdAccount } from "../../runtimes/claude/claude-credentials.js";
import { isIsolated } from "../../agents/registry/agents-store.js";
import { ensureComposedWorktree } from "../context/conversation-context.js";
import { anchorWorktree, forkWorktreeBase } from "../anchors/anchor-worktree.js";
import { anchorSteeredMessage } from "../anchors/steer-anchors.js";
import { landAgent } from "../../agents/land/land.js";
import { verifyLandedTree } from "../../agents/land/verify-landed.js";
import { describeLandingInBackground } from "../../agents/land/landed-subject.js";
import { landingPaths } from "../../agents/land/landing-paths.js";
import { landingVerdict, standing } from "../../rules/rules.js";
import { landingOutcome, takeCheckVerdict } from "../verification/turn-checks.js";
import { type RepoSync, syncConversation } from "../../agents/land/sync.js";
import { recordConversationPrompt, recordPrompt } from "../../sessions/transcript-search.js";
import { handoffHistory, turnStartIndex } from "../../sessions/turn-transcript.js";
import { type ChildSupervisor, childSupervisor, isSpawnedChild } from "../subagents/children.js";
import type { AgentRequest } from "../run/agent.js";
import { adapterFor } from "../providers/adapter-registry.js";
import { composeWirePrompt } from "../prompt/turn-preamble.js";
import { rewindConversation } from "../anchors/rewind.js";
import { commandsOf } from "../providers/agent-commands.js";
import { limitReopensAt } from "../models/limit-reset.js";
import { createFrameLedger } from "../verification/agent-verification.js";
import { createViewFrameLedger } from "../verification/agent-viewing.js";
import { nudgeUnverifiedWork } from "../verification/verify-nudge.js";
import { commandRuleFindings, touchedRepos, workspaceRelative } from "../../rules/turn-ending.js";
import { mentionsSpentAllowance } from "../providers/failure-sentences.js";
import { conversationOf } from "../tools/agent-requests.js";
import { actorOf, type TurnInput } from "../run/turn/turn-actor.js";
import { opt } from "../run/opt.js";
import { registerTurn, SteeringQueue, steerTurn, stopTurn } from "../anchors/agent-steering.js";
import { OUTAGE_MAX_ATTEMPTS, recordProviderFailure, recordProviderSuccess } from "../providers/provider-health.js";
import {
    authResumable,
    clearPendingResume,
    fireLimitResume,
    type LimitFailure,
    limitResumeArmed,
    outageResumeArmed,
    pendingLimitFailure,
    recordAuthFailure,
    recordLimitFailure,
    recordOutageFailure,
    startConversationTurn,
} from "../run/turn/turn-resume.js";
import { dispatchRemoteTurn } from "../../runners/runner-dispatch.js";
import { forgetRemoteRequest, remoteRequestOf } from "../../runners/runner-requests.js";
import { applyReply, composeSteerText } from "../run/turn/turn-interactions.js";
import { withRuntimeHistory } from "../providers/runtime-history.js";
import { handoffStateNote } from "../prompt/handoff-state.js";
import { type LimitWay, limitWayOf } from "../models/limit-way.js";
import { turnRunOf } from "../run/turn/turn-runs.js";
import { nameAgentTitle } from "../models/title-namer.js";
import { createTurnMetrics } from "../run/turn/turn-metrics.js";
import { planTurn } from "../run/turn/turn-plan.js";
import { turnTier } from "../run/turn/turn-tier.js";
import { sumUsage, type UsageFrame } from "../run/turn/turn-usage.js";

// Folds the opt-in editor-context chip into the prompt: the open file, and any selected lines, so deictic prompts ('fix
// this') ground without an @-mention. Four-backtick fence so a selection containing ``` doesn't break out.
const editorContextNote = (context: EditorContext): string => {
    if (context.selection === undefined) {
        return `The user has \`${context.file}\` open in the editor: "this file" likely refers to it.`;
    }
    const range = context.startLine !== undefined && context.endLine !== undefined ? ` (lines ${context.startLine}-${context.endLine})` : "";
    return `The user has \`${context.file}\` open in the editor with this text selected${range}: "this" likely refers to it:\n\`\`\`\`\n${context.selection}\n\`\`\`\``;
};

// Frames a successful model request produces, which is what clears a standing outage.
const ANSWERED_FRAMES = new Set<AgentEvent["kind"]>(["delta", "thinking", "tool_call"]);

// Cards a turn can park on, meaning it addressed the user; prose counts too, a tool call doesn't.
const ADDRESSED_FRAMES: readonly AgentEvent["kind"][] = [
    "plan",
    "question",
    "permission",
    "capability_offer",
    "payment_offer",
    "browser_help",
    "terminal_help",
];

// What the turn loop must remember to judge silentEnding; gathered into one argument to keep runTurn out of the
// reading.
interface TurnSilence {
    readonly conversationId: string | undefined;
    readonly signal: AbortSignal | undefined;
    readonly failed: boolean;
    // Whether the provider spoke at all: worked-and-told-nobody counts as this; never-started does not.
    readonly answered: boolean;
    // Every frame kind emitted; what counts as addressing the user is decided from this set, in one place.
    readonly kinds: ReadonlySet<AgentEvent["kind"]>;
    readonly proseChars: number;
    readonly filesEdited: number;
    readonly toolCalls: number;
}

// Whether this turn put anything in front of the person who asked: prose, or a card it parked on (ADDRESSED_FRAMES).
const addressedUser = (turn: TurnSilence): boolean => turn.proseChars > 0 || ADDRESSED_FRAMES.some((kind) => turn.kinds.has(kind));

// The sentence for a turn that ended with nothing to show for itself, otherwise indistinguishable from a finished one.
// Excludes an edited turn, one never answered, one the user stopped, and one that already failed.
const silentEnding = (turn: TurnSilence): string | undefined => {
    if (turn.conversationId === undefined || turn.signal?.aborted === true || turn.failed || !turn.answered) {
        return undefined;
    }
    if (turn.filesEdited > 0 || addressedUser(turn)) {
        return undefined;
    }
    // Tool calls mean the turn got somewhere before stopping; none means it never got past its first thought.
    const did =
        turn.toolCalls === 0 ? "the model started and then stopped" : `${turn.toolCalls} tool call${turn.toolCalls === 1 ? "" : "s"} and then a stop`;
    return `The turn ended with nothing to show for it: ${did}, no reply and no change to a file. Nothing failed: the session is intact, so carrying on continues from where it stopped.`;
};

// Whether this turn enters the namespace, asked in one place so three callers can't disagree. A property of the
// runtime: only the Claude Code loop enters it.
const entersNamespace = (input: AgentTurn): boolean => capabilitiesOf(input.agent ?? "claude", input.harness ?? "native").isolation === "namespace";

// Injected ahead of `done`, so a silent ending runs the same path a provider failure does (activity, log, ledger,
// Attention). `silent` is a callback since its state is only final once the stream is.
async function* withSilentEnding(frames: AsyncIterable<AgentEvent>, silent: () => string | undefined): AsyncGenerator<AgentEvent> {
    for await (const event of frames) {
        if (event.kind === "done") {
            const message = silent();
            if (message !== undefined) {
                // Uncoded on purpose: it lets the chat answer with a Continue press, not a dead end.
                yield { kind: "error", message };
            }
        }
        yield event;
    }
}

// Runs one agent turn, streaming AgentEvents; `input.agent` picks the provider adapter. Owns the turn's control
// surface: the AbortController /agent/stop cancels, and the SteeringQueue /agent/steer injects into.
export async function* streamAgent(services: Services, input: TurnInput, signal: AbortSignal | undefined): AsyncGenerator<AgentEvent> {
    const controller = new AbortController();
    if (signal?.aborted === true) {
        controller.abort();
    } else {
        signal?.addEventListener("abort", () => controller.abort(), { once: true });
    }
    let steering: SteeringQueue | undefined;
    let unregister: (() => void) | undefined;
    try {
        // Steering exists only where the runtime declares it; others register abort alone.
        steering = capabilitiesOf(input.agent ?? "claude", input.harness ?? "native").steering ? new SteeringQueue() : undefined;
        unregister =
            input.conversationId !== undefined
                ? registerTurn(input.conversationId, { abort: () => controller.abort(), ...(steering !== undefined ? { steering } : {}) })
                : undefined;
        yield* runConversationTurn(services, input, controller.signal, steering);
    } finally {
        unregister?.();
        steering?.close();
    }
}

// Everything the end-of-turn pass does except land on the main tree, for a turn a person ended (dismissed, stopped)
// that skipped that pass. Runs in `measure` mode; never fatal, since this runs after the turn has already ended.
const settleLandBooks = async (services: Services, conversationId: string): Promise<void> => {
    const entry = services.agents.entry(conversationId);
    if (entry === undefined || !isIsolated(entry)) {
        return;
    }
    try {
        const measured = await services.agents.withLandLease(conversationId, () =>
            services.perf.track("agent.land", { id: conversationId, mode: "measure", span: "outstanding" }, () =>
                landAgent(services.agentWorktrees, entry, "measure"),
            ),
        );
        if (measured.changed) {
            await services.agents.recordLanded(conversationId, measured);
        }
    } catch (error) {
        services.logger.warn({ err: error, id: conversationId }, "agents: settling an ended turn's land books failed");
    }
};

// Files a refusal against the MODEL, not the provider: the subscription still serves its other models fine. No-op for
// any other ending; fire-and-forget, like every turn-end write.
const recordModelRefusal = (
    services: Pick<Services, "modelRefusals" | "logger">,
    provider: string,
    model: string | undefined,
    event: { readonly code?: string | undefined; readonly message: string },
): void => {
    if (event.code !== "model-unavailable" || model === undefined || model === "") {
        return;
    }
    void services.modelRefusals
        .record(provider, model, { at: Date.now(), message: event.message })
        .catch((error: unknown) => services.logger.warn({ err: error }, "model refusal: write failed"));
};

// This turn's before-state, as a branch commit: recorded for a reopened tab and framed for the live one, using the same
// id agent-transcript.ts synthesizes for both. Best-effort; nothing pinned means no frame.
async function* anchorIsolatedTurn(
    services: Pick<Services, "agentWorktrees" | "logger" | "turnAnchors">,
    conversationId: string,
    repos: readonly { readonly repo: string; readonly base: string }[],
    turn: SnapshotTurn,
): AsyncGenerator<AgentEvent> {
    const anchored = await anchorWorktree(services, conversationId, repos);
    if (anchored.length === 0) {
        return;
    }
    await services.turnAnchors
        .record(turn.conversationId, turn.index, { kind: "worktree", repos: anchored })
        .catch((error: unknown) => services.logger.warn({ err: error }, "anchors: recording the turn's commits failed"));
    yield { kind: "checkpoint", id: `worktree:${turn.index}`, index: turn.index };
}

// The fleet-registry lifecycle around every turn: `conversationId` acquires the mutex and publishes frames; `isolated`
// only picks the worktree/land flow inside it.
async function* runConversationTurn(
    services: Services,
    input: TurnInput,
    signal: AbortSignal | undefined,
    steering: SteeringQueue | undefined,
): AsyncGenerator<AgentEvent> {
    if (input.conversationId === undefined) {
        // A runner needs a conversation: its branch is what moves between machines; refused otherwise.
        if (input.placement?.kind === "runner") {
            yield { kind: "error", message: "Running on a runner needs a conversation id — the conversation's branch is what travels." };
            yield { kind: "done" };
            return;
        }
        yield* runTurn(services, input, signal, undefined, steering);
        return;
    }
    const conversationId = input.conversationId;
    // Placement belongs to the conversation: a fresh one takes the request, later turns follow the registry.
    const existing = services.agents.entry(conversationId);
    // The persona no longer chooses placement: every caller already asks for isolation now.
    // Where it runs latches the same way: the first request picks the runner, or is refused if unenrolled.
    const requestedRunner = input.placement?.kind === "runner" ? input.placement.id : undefined;
    const runnerId = existing === undefined ? requestedRunner : existing.runner;
    if (existing === undefined && runnerId !== undefined && !(await services.runners.enrolled(runnerId))) {
        yield {
            kind: "error",
            message: `No runner named "${runnerId}" is paired with this sandbox — pair one first, or leave placement out to run here.`,
        };
        yield { kind: "done" };
        return;
    }
    const isolated = runnerId !== undefined || (existing === undefined ? input.isolated === true : existing.branch !== undefined);
    const began = await services.agents.begin(
        {
            conversationId,
            isolated,
            ...(runnerId !== undefined ? { runner: runnerId } : {}),
            prompt: input.prompt,
            provider: input.agent ?? "claude",
            harness: input.harness ?? "native",
            ...(input.title !== undefined ? { title: input.title } : {}),
            ...(input.model !== undefined ? { model: input.model } : {}),
            ...(input.effort !== undefined ? { effort: input.effort } : {}),
            ...(input.thinking !== undefined ? { thinking: input.thinking } : {}),
            ...(input.fast !== undefined ? { fast: input.fast } : {}),
            ...(input.tierHold !== undefined ? { tierHold: input.tierHold } : {}),
            ...(input.account !== undefined ? { account: input.account } : {}),
            ...(input.origin !== undefined ? { origin: input.origin } : {}),
            ...opt("startedBy", input.actor),
            // A fork names its source once; `keep` is the cut's index in the source's own record.
            ...(input.forkOf !== undefined
                ? { forkedFrom: { conversationId: input.forkOf.conversationId, index: input.forkOf.keep, files: input.forkOf.files } }
                : {}),
        },
        Date.now(),
    );
    if (!began) {
        yield { kind: "error", code: "agent-busy", message: "This agent is already running a turn, wait for it to finish." };
        yield { kind: "done" };
        return;
    }
    // Names the conversation while the turn runs, fire-and-forget; a gate skips one already better-named.
    // Warn, not debug: this pass is invisible by construction, so a debug failure goes unnoticed fleet-wide.
    nameAgentTitle(services, conversationId, input.prompt).catch((error: unknown) =>
        services.logger.warn({ err: error }, "agents: title naming failed"),
    );
    // Read once above the isolated/workspace fork, so both arms checkpoint under the same index.
    const turn: SnapshotTurn = { conversationId, index: await turnStartIndex(services, { ...input, conversationId }) };
    // The remote arm: the worktree is a mirror for diff/standing/land; anchored here for /agent/rewind.
    if (runnerId !== undefined) {
        let remoteFailed = false;
        try {
            // The mirror carries the same composition decision the local arm makes, narrowing it identically.
            const worktree = await ensureComposedWorktree(services, input, conversationId, input.worktreeBase, entersNamespace(input));
            const root = worktree.repos.find((repo) => repo.repo === "root") ?? worktree.repos[0];
            yield { kind: "worktree", branch: worktree.branch, base: (root?.base ?? "").slice(0, 7), remote: runnerId };
            yield* anchorIsolatedTurn(services, conversationId, worktree.repos, turn);
            for await (const event of dispatchRemoteTurn(services, { ...input, conversationId }, runnerId, worktree, signal)) {
                services.agents.observe(conversationId, event);
                if (event.kind === "error") {
                    remoteFailed = true;
                }
                yield event;
            }
        } catch (error) {
            if (!(typeof error === "object" && error !== null && (error as { name?: string }).name === "AbortError")) {
                services.agents.observe(conversationId, {
                    kind: "error",
                    message: error instanceof Error ? error.message : "the remote turn failed",
                });
                remoteFailed = true;
            }
            throw error;
        } finally {
            await settleLandBooks(services, conversationId);
            await services.agents.finish(conversationId, Date.now());
        }
        // Referenced so both arms would report symmetrically if a chore emit is added here later.
        void remoteFailed;
        return;
    }
    if (!isolated) {
        try {
            for await (const event of runTurn(services, input, signal, undefined, steering, turn)) {
                services.agents.observe(conversationId, event);
                yield event;
            }
        } catch (error) {
            if (!(typeof error === "object" && error !== null && (error as { name?: string }).name === "AbortError")) {
                services.agents.observe(conversationId, {
                    kind: "error",
                    message: error instanceof Error ? error.message : "agent turn failed",
                });
            }
            throw error;
        } finally {
            await services.agents.finish(conversationId, Date.now());
        }
        return;
    }
    // What this turn's land did, for the `turn.settled` event; the card's standing is derived elsewhere now.
    let outcome: "landed" | "conflict" | "ready" | undefined;
    // Hoisted out of the try since the finally's chore emit reads them: span, branch, and whether it errored.
    let span: WorkspaceEvent["repos"] = [];
    let branch = "";
    let failed = false;
    // Whether the end-of-turn pass ran; the finally settles the books itself when it didn't.
    let reconciled = false;
    try {
        // Lazily create (first turn) or repair the conversation's worktree composition, then announce it.
        const entry = services.agents.entry(conversationId);
        // A fork wanting the files as they were starts at the source's own commit for comparability.
        const worktreeBase = input.worktreeBase ?? (await forkWorktreeBase(services.turnAnchors, input.forkOf));
        // Which repos the conversation carries, decided once and handed back to `ensure` on every later turn.
        const worktree = await ensureComposedWorktree(services, input, conversationId, worktreeBase, entersNamespace(input));
        // Rebases onto today's main line before the model reads it, and again whenever a parked card settles.
        const onto = new Map<string, string>();
        // Tracked since a rebase and a mere merge-base check differ by orders of magnitude, and an unmeasured one would
        // misattribute a slow start.
        const syncOnto = async (): Promise<RepoSync[]> => {
            // Workflow steps stay on the run's snapshot; rebasing would reintroduce the removed race.
            if (input.worktreeBase !== undefined) {
                return [];
            }
            // Read fresh every call, since a land in between moves `landedTip`.
            const current = services.agents.entry(conversationId);
            const landed = new Map((current?.repos ?? []).map((composed) => [composed.repo, composed.landedTip]));
            const synced = await services.perf.track("agent.sync", { id: conversationId }, () =>
                syncConversation(
                    services.agentWorktrees,
                    conversationId,
                    worktree.repos.map(({ repo }) => ({ repo, landedTip: landed.get(repo) })),
                    current?.title,
                ),
            );
            const moved = synced.filter((repo) => repo.blocked !== true);
            if (moved.length === 0) {
                return synced;
            }
            for (const repo of moved) {
                onto.set(repo.repo, repo.onto);
            }
            // `base` is where the branch sits on main; stale, it reads a fast-forward as real work.
            await services.agents.recordWorktree(
                conversationId,
                // oxlint-disable-next-line oxc/no-map-spread -- these are the registry's own persisted records; a fresh object per repo is the point, not a saving
                (services.agents.entry(conversationId)?.repos ?? worktree.repos).map((composed) => ({
                    ...composed,
                    base: onto.get(composed.repo) ?? composed.base,
                })),
            );
            // A mid-turn rebase orphans the span's sha; a moved repo restarts its span at `onto`.
            span = span.map((repo) => ({ repo: repo.repo, from: onto.get(repo.repo) ?? repo.from, dir: repo.dir }));
            return synced;
        };
        // Reported per turn, not once at boot: it depends on how the container launched.
        const enforced = await services.turnIsolation.available();
        // The turn's standing frame, emitted at the start and again whenever a sync moves the branch under a parked
        // card; `base` always names where it sits now.
        const worktreeFrame = (synced: readonly RepoSync[]): Extract<AgentEvent, { kind: "worktree" }> => {
            const root = worktree.repos.find((repo) => repo.repo === "root") ?? worktree.repos[0];
            return {
                kind: "worktree",
                branch: worktree.branch,
                base: (root === undefined ? "" : (onto.get(root.repo) ?? root.base)).slice(0, 7),
                ...(enforced ? {} : { unenforced: true }),
                ...(synced.length > 0
                    ? {
                          sync: {
                              commits: synced.filter((repo) => repo.blocked !== true).reduce((total, repo) => total + repo.commits, 0),
                              blocked: synced.filter((repo) => repo.blocked === true).map((repo) => repo.repo),
                          },
                      }
                    : {}),
            };
        };
        const synced = await syncOnto();
        branch = worktree.branch;
        // Where each repo stood before this turn; a moved repo reads from `onto` instead of `landedTip`.
        span = worktree.repos.map(({ repo, base }) => ({
            repo,
            from: onto.get(repo) ?? entry?.repos.find((recorded) => recorded.repo === repo)?.landedTip ?? base,
            dir: services.agentWorktrees.worktreeDir(conversationId, repo),
        }));
        yield worktreeFrame(synced);
        // Recorded after the rebase above: 'before this message' means the branch the agent is about to read.
        yield* anchorIsolatedTurn(services, conversationId, worktree.repos, turn);
        // Re-syncs whenever a card settles; only a question's picks or an approved plan get this, never a permission
        // card, whose tool call was already computed against the old tree.
        const resync = async (): Promise<AgentEvent | undefined> => {
            // Must never cost the user their answer: best-effort and logged, unlike the turn-start sync.
            try {
                const moved = await syncOnto();
                // An empty answer is a branch that was already current: no movement, so no frame either.
                return moved.length === 0 ? undefined : worktreeFrame(moved);
            } catch (error) {
                services.logger.warn({ err: error, id: conversationId }, "agents: sync on a settled card failed");
                return undefined;
            }
        };
        // Relay the turn while watching for error frames: a failed turn must not auto-land half-done work.
        for await (const event of runTurn(services, input, signal, { id: conversationId, cwd: worktree.cwd, synced, resync }, steering, turn)) {
            services.agents.observe(conversationId, event);
            if (event.kind === "error") {
                failed = true;
            }
            yield event;
        }
        // Auto-lands a clean turn; with auto-land off, the same pass runs in `measure` instead.
        const check = takeCheckVerdict(conversationId);
        const finished = services.agents.entry(conversationId);
        if (!failed && signal?.aborted !== true && finished !== undefined && isIsolated(finished)) {
            // Whether this land reaches the tree or stays held; a per-agent override wins over the table.
            const { rules } = await services.sandboxSettings.get();
            // Changed paths cost a git pass per repo; read only when a rule here actually narrows by path.
            const finishedRules = standing(rules, "agent.finished");
            const paths = finishedRules.some((rule) => (rule.when?.paths?.length ?? 0) > 0)
                ? await landingPaths(services, finished, span)
                : undefined;
            const decided = landingVerdict(
                rules,
                { repos: span.map(({ repo }) => repo), paths, outcome: landingOutcome(check) },
                input.autoLand ?? finished.autoLand,
            );
            // Under the land lease, so a manual land pressed meanwhile queues rather than rebasing under this one.
            const landed = await services.agents.withLandLease(conversationId, async () => {
                // One more rebase before landing, since the top-of-turn sync is stale by now; best-effort.
                try {
                    await syncOnto();
                } catch (error) {
                    services.logger.warn({ err: error, id: conversationId }, "agents: pre-land sync failed, landing on the old base");
                }
                // Re-read after the sync: the frozen composition would hand anchorOf an orphaned base.
                const resynced = services.agents.entry(conversationId);
                const landing = resynced !== undefined && isIsolated(resynced) ? resynced : finished;
                const mode = decided.land ? "check" : "measure";
                return services.perf.track("agent.land", { id: conversationId, mode, span: "outstanding" }, () =>
                    landAgent(services.agentWorktrees, landing, mode),
                );
            });
            reconciled = true;
            // A rule that held work reaches the settings feed; landing is self-evident, so only a hold is.
            // The one hold no rule decided: the work is finished but its own check failed.
            if (decided.held === "checks-failed" && check !== undefined) {
                void services.activity
                    .append({
                        direction: "system",
                        type: "rule.held_work",
                        content: `"${check.label}" failed on this turn's work (\`${check.command}\`), so it waits on its branch instead of landing.`,
                        conversationId,
                    })
                    .catch((error: unknown) => services.logger.warn({ err: error }, "rule activity append failed"));
            }
            if (decided.rule !== undefined) {
                void services.ruleFirings
                    .stamp(decided.rule.id, Date.now())
                    .catch((error: unknown) => services.logger.warn({ err: error }, "rule firing stamp failed"));
                if (!decided.land) {
                    void services.activity
                        .append({
                            direction: "system",
                            type: "rule.held_work",
                            content: `"${decided.rule.label}" held this work on its branch instead of landing it.`,
                            conversationId,
                        })
                        .catch((error: unknown) => services.logger.warn({ err: error }, "rule activity append failed"));
                }
            }
            if (!landed.changed && landed.diff.files > 0) {
                // Nothing new to land, prior output already counts; stays Landed, not downgraded to Idle.
                outcome = "landed";
            }
            if (landed.changed) {
                await services.agents.recordLanded(conversationId, landed);
                outcome = landed.held === true ? "ready" : landed.landed ? "landed" : "conflict";
                if (landed.landed) {
                    // Drafts what this land did, for the Changes panel chip; not awaited yet.
                    describeLandingInBackground(services, conversationId);
                }
                // The moment a dependency change starts costing every later turn's node_modules.
                const verifyContext: DependencyLandOrigin = {
                    kind: "land",
                    agentId: conversationId,
                    ...(finished.title !== undefined ? { title: finished.title } : {}),
                    branch,
                    repos: span,
                };
                // The whole repository's check, off the turn's clock; the reconciler first when node_modules is behind.
                const deps = landed.landed
                    ? await verifyLandedTree(services, (event) => emitWorkspaceEvent(services, event, streamAgent), verifyContext)
                    : undefined;
                yield {
                    kind: "landed",
                    landed: landed.landed,
                    ...(landed.conflicts !== undefined ? { conflicts: landed.conflicts } : {}),
                    ...(landed.held === true ? { held: true } : {}),
                    ...(deps !== undefined ? { deps } : {}),
                };
                if (landed.landed) {
                    // The main tree just changed: give History a turn checkpoint, labeled as usual.
                    services.history
                        .snapshot("turn", input.prompt)
                        .catch((error: unknown) => services.logger.warn({ err: error }, "history: landed snapshot failed"));
                    emitWorkspaceEvent(
                        services,
                        {
                            event: "agent.landed",
                            agentId: conversationId,
                            ...(finished.title !== undefined ? { title: finished.title } : {}),
                            branch,
                            outcome: "landed",
                            repos: span,
                        },
                        streamAgent,
                    );
                }
            }
        }
    } catch (error) {
        if (!(typeof error === "object" && error !== null && (error as { name?: string }).name === "AbortError")) {
            failed = true;
            services.agents.observe(conversationId, {
                kind: "error",
                message: error instanceof Error ? error.message : "agent turn failed",
            });
        }
        throw error;
    } finally {
        // A person-ended turn is settled here instead; an errored one is left as is.
        if (!reconciled && !failed) {
            await settleLandBooks(services, conversationId);
        }
        await services.agents.finish(conversationId, Date.now());
        // Once per turn, whatever the outcome; an empty span means the worktree never came up.
        if (span.length > 0) {
            const settled = services.agents.entry(conversationId);
            emitWorkspaceEvent(
                services,
                {
                    event: "turn.settled",
                    agentId: conversationId,
                    ...(settled?.title !== undefined ? { title: settled.title } : {}),
                    branch,
                    outcome: failed ? "error" : (outcome ?? "idle"),
                    repos: span,
                },
                streamAgent,
            );
        }
    }
}

// Preflight is a few hundred ms plus one throttled fetch; past this it's a defect, not ordinary load.
const SLOW_PREFLIGHT_MS = 5_000;

// How much of a failure's sentence the ledger keeps: enough for any refusal, short enough to stay readable.
const ERROR_MESSAGE_CHARS = 400;

// How much of the check that spoke the ledger keeps; a command is a line, not a script.
const VERIFICATION_CHECK_CHARS = 200;

// Codes with a durable trace elsewhere; logging them at `error` would drown the unclassified failures.
const HANDLED_FAILURE_CODES: ReadonlySet<string> = new Set([
    "rate_limit",
    "provider-outage",
    "claude-token-refused",
    "claude-not-entitled",
    // Filed against the model (model-refusals.json); happens once, since the picker stops offering it after.
    "model-unavailable",
]);

// How fresh a reading must be before a settled turn re-reads it; a fleet costs one sweep.
const SETTLE_MAX_AGE_MS = 10_000;

// Files a turn's plan-limit reading under the account it describes. A native Codex turn names only its subscription, so
// its one auth file gets it, or all are re-read if there are several.
const fileAccountUsage = async (
    services: Services,
    provider: AgentProvider,
    resolvedAccount: string | undefined,
    windows: readonly UsageWindow[],
): Promise<void> => {
    try {
        const routed = KeyedProviderSchema.safeParse(provider);
        if (routed.success) {
            const key = await services.cliProxy.sharedUsageKey(routed.data);
            await (key === undefined
                ? services.headroom.refresh({ scope: { providers: [provider] }, maxAgeMs: 0 })
                : services.headroom.record(provider, key, { windows: [...windows], measuredAt: Date.now() }));
            return;
        }
        if (resolvedAccount !== undefined) {
            await services.headroom.record(provider, resolvedAccount, { windows: [...windows], measuredAt: Date.now() });
        }
    } catch (error) {
        services.logger.warn({ err: error }, "account usage: snapshot write failed");
    }
};

// Dresses a spent-allowance frame with when it reopens, whether it's held, and whether a clock will resume it unasked.
// `autoResume` needs both a held turn and a known instant, read through the same check the resume pass uses later.
const limitFrame = async (
    services: Services,
    event: Extract<AgentEvent, { kind: "error" }>,
    params: {
        readonly conversationId: string | undefined;
        readonly resetsAt: number | undefined;
        readonly held: boolean;
        readonly ran: boolean;
        // What each way on costs and where a policy is taking the turn; absent on an unheld frame.
        readonly way: LimitWay | undefined;
    },
): Promise<Extract<AgentEvent, { kind: "error" }>> => {
    const { conversationId, resetsAt, held, ran, way } = params;
    const schedulable = held && resetsAt !== undefined && conversationId !== undefined;
    const armed = schedulable ? await limitResumeArmed(services, conversationId) : false;
    // A booked move needs no instant to count as scheduled: the card leaves Attention either way.
    const moving = held ? way?.move?.account : undefined;
    const autoResume = autoResumeOf(moving !== undefined, schedulable, armed);
    return {
        ...event,
        ...(held ? { held: heldOf(ran, way, moving) } : {}),
        ...(resetsAt !== undefined ? { resetsAt } : {}),
        ...opt("autoResume", autoResume),
    };
};

// The entry a spent allowance is holding for this conversation, if any; nothing for a turn with no conversation.
const heldTurnOf = (conversationId: string | undefined): LimitFailure | undefined =>
    conversationId === undefined ? undefined : pendingLimitFailure(conversationId);

// The frame's verdict on who brings the turn back: a booked move, the armed appointment, or an offer.
const autoResumeOf = (moving: boolean, schedulable: boolean, armed: boolean): "scheduled" | "available" | undefined => {
    if (moving) {
        return "scheduled";
    }
    if (!schedulable) {
        return undefined;
    }
    return armed ? "scheduled" : "available";
};

// The held turn as the frame states it: whether it ran, what each way on costs, where a policy is taking it.
const heldOf = (ran: boolean, way: LimitWay | undefined, moving: string | undefined): NonNullable<Extract<AgentEvent, { kind: "error" }>["held"]> => ({
    ran,
    ...opt("contextTokens", way?.contextTokens),
    ...opt("handoffTokens", way?.handoffTokens),
    ...opt("moving", moving),
});

// What a fresh session is told beside the transcript: the tree, the proof, the checklist — only for a turn seeded from
// the record.
const handoffNoteFor = async (
    services: Services,
    input: TurnInput,
    history: readonly unknown[],
    held: LimitFailure | undefined,
): Promise<TurnNote | undefined> =>
    history.length === 0 || input.conversationId === undefined
        ? undefined
        : handoffStateNote(services, {
              conversationId: input.conversationId,
              standing: held?.standing,
              checklist: held?.checklist,
              retiredSessionId: held?.sessionId ?? services.agents.entry(input.conversationId)?.sessionId,
          });

// Records why a turn is held: a spent allowance holding it whole, or a carried session a sibling account refused
// outright. The second case's remedy is a fresh session, recorded once and never twice.
const recordSpentAllowance = (params: {
    readonly input: TurnInput;
    readonly sessionId: string | undefined;
    readonly limitHit: boolean;
    readonly limitReopens: number | undefined;
    readonly way: LimitWay | undefined;
    readonly providerAnswered: boolean;
    readonly failure: { readonly code: string | undefined } | undefined;
    readonly standing: LimitWay["standing"];
    readonly checklist: readonly TodoItem[] | undefined;
    readonly contextTokens: number | undefined;
}): void => {
    const { input, sessionId, providerAnswered, failure } = params;
    if (input.conversationId === undefined) {
        return;
    }
    const turn = { ...input, conversationId: input.conversationId };
    if (params.limitHit) {
        recordLimitFailure({
            input: turn,
            ...opt("sessionId", sessionId),
            ran: providerAnswered,
            // The instant the frame already published, carried so the pass can keep the appointment it names.
            ...opt("reopensAt", params.limitReopens),
            ...params.way,
        });
        return;
    }
    const carryRefused = !providerAnswered && failure !== undefined && failure.code === undefined && input.prompt.startsWith(RESUME_NOTES.carried);
    if (carryRefused && input.account !== undefined) {
        recordLimitFailure({
            input: turn,
            ...opt("sessionId", sessionId),
            ran: true,
            carryRefused: true,
            move: { account: input.account, carry: false },
            standing: params.standing,
            ...opt("checklist", params.checklist),
            ...opt("contextTokens", params.contextTokens),
        });
    }
};

// The session to resume, or none if the runtime no longer holds it, which opens a fresh session seeded from the record
// instead. A store that can't be probed is trusted, not doubted.
// The conversation whose Stop the daemon runs, or undefined: a runtime with no Stop hook, a turn that ended well (not
// cancelled, not failed), and not a spawned child, whose parent's Stop answers for it.
const daemonStopConversation = (input: TurnInput, provider: AgentProvider, outcome: "ok" | "error" | "cancelled"): string | undefined =>
    outcome === "ok" &&
    input.conversationId !== undefined &&
    capabilitiesOf(provider, input.harness ?? "native").rulebook !== "hooks" &&
    !isSpawnedChild(input.conversationId)
        ? input.conversationId
        : undefined;

// What the turn.ending command rules found on a daemon-stopped isolated turn, worded for the model; empty when the
// turn is not one, is unisolated (the main tree is everyone's), or the rules passed. Their verdict is recorded through
// `onCheckRun` as it runs, which is what the land decision reads.
const daemonStopFindings = async (
    services: Services,
    turn: {
        readonly conversationId: string | undefined;
        readonly worktree: unknown;
        readonly request: AgentRequest;
        readonly edited: readonly string[];
        readonly cwd: string;
        readonly isolation: TurnPlacement | undefined;
    },
): Promise<string[]> => {
    if (turn.conversationId === undefined || turn.worktree === undefined) {
        return [];
    }
    const { request } = turn;
    try {
        const changed = request.changedPaths === undefined ? [] : await request.changedPaths().catch((): readonly string[] => []);
        const rules = request.turnEndingRules ?? [];
        const paths = [...new Set([...turn.edited.map((path) => workspaceRelative(path, turn.cwd)), ...changed])];
        return await commandRuleFindings(
            rules,
            // Same facts the hook path builds at its own Stop, repositories included, or the same rule would mean two
            // different things depending on which runtime ran the turn.
            { paths, draw: Math.random(), repos: await touchedRepos(rules, paths, { repos: request.turnRepos }) },
            {
                runCommand: request.runRuleCommand,
                onCheckRun: request.onCheckRun,
                onFired: request.onRuleFired,
                installing: request.dependencyInstalling,
                cwd: turn.cwd,
                ...(turn.isolation !== undefined ? { isolation: turn.isolation.plan } : {}),
            },
        );
    } catch (error) {
        services.logger.warn({ err: error, conversationId: turn.conversationId }, "turn-ending checks: could not run after the turn");
        return [];
    }
};

const sessionToResume = async (services: Services, input: AgentTurn, effectiveCwd: string): Promise<string | undefined> => {
    const { sessionId } = input;
    if (sessionId === undefined) {
        return undefined;
    }
    const adapter = adapterFor(input.agent ?? "claude", input.harness ?? "native");
    const held = await services.perf
        .track("turn.preflight.session", {}, () => adapter.holdsSession(services, sessionId, effectiveCwd))
        .catch((error: unknown) => {
            services.logger.warn({ err: error, sessionId }, "session probe failed, resuming as asked");
            return true;
        });
    return held ? sessionId : undefined;
};

// Clears whatever this provider/account last refused, since content on the wire is the only evidence that can settle a
// refusal no poll can re-check.
const settleRefusals = (services: Services, provider: string, account: string | undefined): void => {
    void services.providerRefusals
        .clear(provider, account)
        .catch((error: unknown) => services.logger.warn({ err: error }, "provider refusal: settle failed"));
    // Clears the seat mark too, so a re-enabled account rejoins rotation without a reconnect.
    if (account === undefined) {
        return;
    }
    void services.claudeSeats
        .clear(account)
        .catch((error: unknown) => services.logger.warn({ err: error }, "claude account: could not clear the entitlement mark"));
};

// One agent turn's body, on the main tree or inside an isolated worktree; the cwd override is the one binding point
// every adapter and session store follows.
async function* runTurn(
    services: Services,
    input: TurnInput,
    signal: AbortSignal | undefined,
    worktree:
        | { readonly id: string; readonly cwd: string; readonly synced: readonly RepoSync[]; readonly resync: () => Promise<AgentEvent | undefined> }
        | undefined,
    steering: SteeringQueue | undefined,
    // Which conversation message this turn answers, for its checkpoint; undefined with no conversation.
    turn?: SnapshotTurn,
): AsyncGenerator<AgentEvent> {
    // Read before clearing: a fresh session gets what the dead turn's ledgers measured.
    const heldBefore = heldTurnOf(input.conversationId);
    if (input.conversationId !== undefined) {
        clearPendingResume(input.conversationId);
    }
    // Marks each preflight stage, so a slow start names its own culprit instead of hiding in an undated gap.
    const preflightStart = Date.now();
    const preflightStages: Record<string, number> = {};
    const mark = (stage: string): void => {
        preflightStages[stage] = Date.now() - preflightStart;
    };
    // Shared with the boot-time condition-watch restore, so a drifted second copy can't quietly stop working.
    const cliEnv = await turnCliEnv(services);
    mark("env");
    // Attachments arrive workspace-relative; resolve to absolute paths for the provider and reject escapes.
    const attachmentPaths: string[] = [];
    for (const rel of input.attachments ?? []) {
        const abs = resolveWithin(services.workspace.root, rel);
        if (abs === undefined) {
            yield { kind: "error", message: `invalid attachment path: ${rel}` };
            yield { kind: "done" };
            return;
        }
        attachmentPaths.push(abs);
    }
    // The editor-context chip's file rides workspace-relative too, same escape guard as attachments.
    if (input.editorContext !== undefined && resolveWithin(services.workspace.root, input.editorContext.file) === undefined) {
        yield { kind: "error", message: `invalid editor context path: ${input.editorContext.file}` };
        yield { kind: "done" };
        return;
    }
    // Two paths: `localCwd` is the daemon's tree; `effectiveCwd` is the root as the agent sees it.
    const localCwd = worktree?.cwd ?? services.workspace.root;
    // Built only for the runtime that enters the namespace; others stay cwd'd, told so in the prompt instead.
    const isolation: TurnPlacement | undefined =
        worktree === undefined || !entersNamespace(input)
            ? undefined
            : await services.turnIsolation.planFor(localCwd).then(async (plan) => {
                  if (!(await services.turnIsolation.available())) {
                      return { plan };
                  }
                  return { plan, anchor: await startAnchor(plan) };
              });
    mark("isolation");
    const effectiveCwd = isolation?.anchor?.cwd ?? localCwd;
    // Kicked off early to overlap setup; opposite the pre-turn rebase, into the user's checkout.
    const syncPromise =
        worktree !== undefined
            ? undefined
            : syncWorkspaceRepos(services, 60_000).catch((error: unknown) => {
                  services.logger.warn({ err: error }, "repo sync failed");
                  return [];
              });
    // Editor context attaches to THIS message, so it folds in before the older history preamble wraps it.
    const promptWithEditor = input.editorContext !== undefined ? `${input.prompt}\n\n${editorContextNote(input.editorContext)}` : input.prompt;
    // Asks the runtime's store whether it still holds the named session: a session id is a claim, not a fact.
    const resumed = await sessionToResume(services, input, effectiveCwd);
    // Resuming no session with history behind it is a runtime handoff, read before this turn appends its own.
    const history =
        resumed === undefined && input.conversationId !== undefined
            ? await handoffHistory(services, { ...input, conversationId: input.conversationId })
            : [];
    // What is TRUE beside what was said, measured by the sandbox; rides the request as one more note.
    const handoffNote = await handoffNoteFor(services, input, history, heldBefore);
    mark("history");
    // Judged while the turn is still a request, using the user's own unresolved pick as the ceiling.
    const settings = await services.perf.track("turn.plan.settings", {}, () => services.sandboxSettings.get());
    const tier = await services.perf.track("turn.tier", {}, () =>
        turnTier(services, input, {
            settings,
            provider: input.agent ?? "claude",
            lastTier: input.conversationId === undefined ? undefined : services.agents.entry(input.conversationId)?.tier,
            // The turn's own flag when it says anything, else the conversation's persisted veto.
            hold: input.tierHold ?? (input.conversationId === undefined ? false : (services.agents.entry(input.conversationId)?.tierHold ?? false)),
        }),
    );
    // The turn as the rest of this function must see it: only the model may differ, only downward.
    const tierRouted = tier?.model !== undefined && tier.held !== true;
    const planned: AgentTurn = tier !== undefined && tier.model !== undefined && tierRouted ? { ...input, model: tier.model } : input;
    if (tier !== undefined && input.conversationId !== undefined) {
        // Fire-and-forget: only the next turn's judgement needs this, and a write must never delay this one.
        services.agents
            .recordTier(input.conversationId, tier.verdict.tier)
            .catch((error: unknown) => services.logger.warn({ err: error }, "auto tier: recording the verdict failed"));
    }
    // Reported on every judged turn, even standard, since the composer's preview needs the last verdict.
    if (tier !== undefined) {
        yield {
            kind: "tier",
            tier: tier.verdict.tier,
            score: tier.verdict.score,
            rules: [...tier.verdict.rules],
            ...(tier.model !== undefined ? { model: tier.model } : {}),
            routed: tierRouted,
            ...(tier.held === true ? { held: true } : {}),
        };
    }
    mark("tier");
    const base: AgentRequest = {
        prompt: history.length > 0 ? withRuntimeHistory(promptWithEditor, history) : promptWithEditor,
        cwd: effectiveCwd,
        // Which agent the children this turn spawns belong to; absent for a turn with no conversation.
        ...(input.conversationId !== undefined ? { conversationId: input.conversationId } : {}),
        ...(isolation !== undefined ? { isolation } : {}),
        signal: signal ?? new AbortController().signal,
        ...(Object.keys(cliEnv).length > 0 ? { cliEnv } : {}),
        ...(resumed !== undefined ? { sessionId: resumed } : {}),
        // `planned`, not `input`: a downgraded turn must reach the arms as the model it will actually run.
        ...(planned.model !== undefined ? { model: planned.model } : {}),
        ...(input.permissionMode !== undefined ? { permissionMode: input.permissionMode } : {}),
        ...(input.allowedTools !== undefined ? { allowedTools: input.allowedTools } : {}),
        ...(input.effort !== undefined ? { effort: input.effort } : {}),
        // Rides the same path as `effort`: through turn-plan's own gates, not straight to an adapter.
        ...(input.fast !== undefined ? { fast: input.fast } : {}),
    };
    // Which runtime serves this turn, resolved as a value so every provider's gates live in one place.
    // Built here since a child runs through streamAgent, which only this module hands down without a cycle.
    const spawnParent = input.conversationId;
    const children: ChildSupervisor | undefined =
        spawnParent === undefined || input.outsideWake !== undefined
            ? undefined
            : childSupervisor(services, { conversationId: spawnParent, cwd: localCwd }, streamAgent);
    const plan = await planTurn(services, planned, {
        base,
        attachmentPaths,
        localCwd,
        effectiveCwd,
        cliEnv,
        steering,
        // Read once above for the tier judgement; planTurn accepts it too so this costs no extra read.
        settings,
        ...(worktree !== undefined ? { resync: worktree.resync } : {}),
        ...(children !== undefined ? { children } : {}),
    });
    if (!plan.ok) {
        // The namespace anchor was built before the gates ran, so a refusal must dispose it too.
        isolation?.anchor?.dispose();
        yield { kind: "error", ...(plan.code !== undefined ? { code: plan.code } : {}), message: plan.message };
        yield { kind: "done" };
        return;
    }
    mark("plan");
    const { run } = plan;
    // The account serving this turn, stamped onto every session/usage/rate-limit frame and the activity log.
    const resolvedAccount = plan.account;
    // Spread into every frame that carries attribution, so every site answering 'whose account' can't drift.
    const attribution: { account?: string; actor?: string } = { ...opt("account", resolvedAccount), ...opt("actor", input.actor) };
    let request = plan.request;
    // Fast-forwards repos with a remote before the agent reads them; pulled files count as user-authored.
    const advisory = syncPromise === undefined ? undefined : syncAdvisory(await syncPromise);
    mark("repoSync");
    if (advisory !== undefined) {
        // Added as a typed note, first in the list: it's the first thing a turn should know.
        request = { ...request, notes: [{ title: REPO_SYNC_NOTE_TITLE, text: advisory }, ...(request.notes ?? [])] };
    }
    // What the message grew before reaching the model, said aloud from the same serialized list.
    // The hand-off's measured state goes last, beside the envelope and the words it describes.
    const notes = [...(request.notes ?? []), ...(handoffNote === undefined ? [] : [handoffNote])];
    if (notes.length > 0) {
        yield { kind: "preamble", notes: [...notes] };
    }
    // Where typed notes become the wire prompt, right before the adapter; nothing unpacks it again.
    request = { ...request, prompt: composeWirePrompt(notes, request.prompt) };
    // This turn's before-state, for a rewind or fork to name; fences pending work as user-authored.
    if (worktree === undefined) {
        // This turn's start checkpoint: the fence capture if any, else the newest one.
        const checkpointId = await services.history
            .snapshot("user")
            .then(async (id) => id ?? (await services.history.list())[0]?.id)
            .catch((error: unknown) => {
                services.logger.warn({ err: error }, "history: turn-start snapshot failed");
                return undefined;
            });
        if (checkpointId !== undefined) {
            // Written down as well as streamed: the frame alone reaches only today's browser.
            if (turn !== undefined) {
                await services.turnAnchors
                    .record(turn.conversationId, turn.index, { kind: "tree", snapshot: checkpointId })
                    .catch((error: unknown) => services.logger.warn({ err: error }, "anchors: recording the turn's checkpoint failed"));
            }
            yield { kind: "checkpoint", id: checkpointId, ...(turn !== undefined ? { index: turn.index } : {}) };
        }
    }
    // An isolated turn takes no history capture: history covers only the main tree, which it never touches.
    mark("snapshot");
    // This turn's identity in the activity log, minted here so its events join as one row.
    const turnId = randomUUID();
    // Tees every frame past the activity sniffer: outbound provider calls are only visible here.
    const sniffer = createOutboundSniffer(services, turnId);
    // Turn lifecycle into the durable activity log; full content stays in the SDK transcript.
    const provider = input.agent ?? "claude";
    // The session this turn runs on, not the one asked for; replaced by the stream's own frame.
    let sessionId = resumed;
    // The reset instant the stream last named, so a rate_limit frame can name when the window reopens.
    let limitReset: number | undefined;
    // Set when the API refuses this turn's credential mid-flight; recorded for the resume.
    let authRefused = false;
    // Whether a mid-turn auth refusal would be re-minted and re-run; only a stored Claude account qualifies.
    const resumeArmed =
        input.conversationId !== undefined && resolvedAccount !== undefined && request.oauthToken !== undefined && authResumable(input.prompt);
    // Set when the provider fails transiently; the finally resumes from the turn's last session.
    let outageHit = false;
    // Set when a spent allowance refuses this turn; a press re-run waits on `providerAnswered`.
    let limitHit = false;
    // When the refusing allowance is due back, resolved once and kept, not re-derived later.
    let limitReopens: number | undefined;
    // And the way on from it, decided once at the frame and recorded on the held entry.
    let limitWay: LimitWay | undefined;
    // Whether the provider answered at all; the first real content clears a standing outage fleet-wide.
    let providerAnswered = false;
    let usageExtra: Record<string, unknown> | undefined;
    // The turn's usage, kept typed; summed, not last-wins, since a steer is a second SDK turn.
    let usage: UsageFrame | undefined;
    // Characters of the model's own prose this turn, counted off `delta` frames for silent-ending detection.
    let proseChars = 0;
    // Whether this turn ever addressed the user; the tool count rides along only for the sentence.
    const kinds = new Set<AgentEvent["kind"]>();
    // What the turn did before its first edit, read off one walk through the frame stream.
    const metrics = createTurnMetrics(effectiveCwd);
    // Whether this turn proved its work, fed frames rather than hooks so it works across every runtime.
    const verification = createFrameLedger();
    // Whether the turn looked at what it drew: a separate ledger, browser evidence not code checks.
    const viewing = createViewFrameLedger();
    // The agent's own checklist as last reported; undefined means it kept none, not an empty one.
    let checklist: readonly TodoItem[] | undefined;
    // How many times the window was compacted, and how full it was at the end: whether the turn hit the wall.
    let compactions = 0;
    let context: ContextUsage | undefined;
    // The last error frame this turn emitted, not the first, since a resumed turn can fail twice.
    let failure: { readonly code: string | undefined; readonly message: string } | undefined;
    // This turn's state as `silentEnding` reads it, gathered at the `done` frame where every field is final.
    const endedSilent = (): string | undefined =>
        silentEnding({
            conversationId: input.conversationId,
            signal,
            failed: failure !== undefined,
            answered: providerAnswered,
            kinds,
            proseChars,
            filesEdited: verification.edited().length,
            toolCalls: metrics.calls(),
        });
    const record = (event: Omit<ActivityEvent, "id" | "at" | "provider" | "direction">): void => {
        // Read per event, not captured once: nameAgentTitle runs concurrently, mid-turn.
        const title = input.conversationId === undefined ? undefined : services.agents.entry(input.conversationId)?.title;
        void services.activity
            .append({
                provider,
                direction: "system",
                turnId,
                ...attribution,
                ...(sessionId !== undefined ? { sessionId } : {}),
                ...(input.conversationId !== undefined ? { conversationId: input.conversationId } : {}),
                ...(title !== undefined ? { title } : {}),
                ...(input.origin !== undefined ? { origin: input.origin } : {}),
                ...event,
            })
            .catch((error: unknown) => services.logger.warn({ err: error }, "activity: turn event append failed"));
    };
    const preflightMs = Date.now() - preflightStart;
    if (preflightMs >= SLOW_PREFLIGHT_MS) {
        services.logger.warn(
            { preflightMs, stages: preflightStages },
            "turn preflight slow: the stage marks say which step, and a stalled event loop inflates all of them at once",
        );
    }
    record({ type: "turn.started", content: input.prompt.slice(0, 2_000) });
    // Holds the account for the turn's life, so a proactive refresh waits for a gap instead.
    const releaseAccount = resolvedAccount !== undefined ? holdAccount(resolvedAccount) : undefined;
    try {
        for await (const event of withSilentEnding(run(request), endedSilent)) {
            // An abort is not a failure, said once here: every adapter reports it like a real death.
            if (event.kind === "error" && signal?.aborted === true) {
                continue;
            }
            sniffer.observe(event);
            // Any real content proves the outage over fleet-wide, releasing every stranded turn at once.
            if (ANSWERED_FRAMES.has(event.kind)) {
                // Content after an outage failure means the harness got past it; nothing stranded here.
                outageHit = false;
                // Same for a rate limit the harness rode out: an answering turn isn't held.
                limitHit = false;
                if (!providerAnswered) {
                    providerAnswered = true;
                    recordProviderSuccess(provider);
                    // And settles the refusals this turn just disproved, both the provider's and the seat's.
                    settleRefusals(services, provider, resolvedAccount);
                }
            }
            if (event.kind === "delta") {
                // Includes subagent narration: it runs on the same steered prompt as delegated writing.
                proseChars += event.text.length;
            }
            // And what kinds of frame this turn produced: how the ending knows it addressed the user.
            kinds.add(event.kind);
            // Subagents' calls included, same rule as the prose: sending one looking still counts.
            metrics.note(event);
            // What changed and what proved it, folded here since only this loop knows the frame order.
            if (event.kind === "tool_call" || event.kind === "tool_call_update") {
                verification.note(event);
                viewing.note(event);
            } else if (event.kind === "todos") {
                checklist = event.items;
            } else if (event.kind === "compact") {
                compactions += 1;
            } else if (event.kind === "context_usage") {
                context = event;
            }
            if (event.kind === "session") {
                sessionId = event.sessionId;
                // Whose credential this session is on; an unnamed pick may go to whichever had headroom.
                yield { ...event, ...attribution };
                continue;
            } else if (event.kind === "usage") {
                usage = sumUsage(usage, event);
                const { kind: _kind, ...rest } = usage;
                usageExtra = rest;
                // Attributes per-turn totals to the account that served, keying the client's usage by it.
                yield { ...event, ...attribution };
                continue;
            } else if (event.kind === "rate_limit_info") {
                limitReset = event.resetsAt ?? limitReset;
                yield { ...event, ...attribution };
                continue;
            } else if (event.kind === "account_usage") {
                // Persists the windows, not just streams them, so every open window's rings move too.
                void fileAccountUsage(services, provider, resolvedAccount, event.windows);
                yield { ...event, ...attribution };
                continue;
            } else if (event.kind === "plan") {
                record({ type: "turn.plan", content: event.text, extra: { requestId: event.requestId } });
            } else if (event.kind === "error") {
                record({ type: "turn.error", outcome: "error", error: event.message });
                failure = { code: event.code, message: event.message };
                // An unclassified failure logs at `error`; an already-filed refusal logs at `warn`.
                const failed = event.code === undefined || !HANDLED_FAILURE_CODES.has(event.code);
                services.logger[failed ? "error" : "warn"](
                    {
                        turnId,
                        provider,
                        harness: input.harness ?? "native",
                        ...(event.code !== undefined ? { code: event.code } : {}),
                        ...(request.model !== undefined ? { model: request.model } : {}),
                        ...attribution,
                        ...(input.conversationId !== undefined ? { conversationId: input.conversationId } : {}),
                        ...(sessionId !== undefined ? { sessionId } : {}),
                        // `reason`, not `message`: the logger's own messageKey is `message` already.
                        reason: event.message.slice(0, ERROR_MESSAGE_CHARS),
                    },
                    failed ? "turn failed" : "turn refused",
                );
                // Files a durable refusal; `kind` reads the sentence, not the code, which can disagree.
                if (event.code === "rate_limit" || event.code === "claude-token-refused" || event.code === "claude-not-entitled") {
                    void services.providerRefusals
                        .record(provider, {
                            at: Date.now(),
                            kind:
                                event.code === "claude-not-entitled"
                                    ? "entitlement"
                                    : event.code === "rate_limit" || mentionsSpentAllowance(event.message)
                                      ? "limit"
                                      : "auth",
                            message: event.message,
                            // Routed turns have no account to name: CLIProxyAPI picks the auth file itself.
                            ...attribution,
                            // The model, so refusal reads the pool it spends, not the account's fullest.
                            ...(request.model === undefined || request.model === "" ? {} : { model: request.model }),
                        })
                        .catch((error: unknown) => services.logger.warn({ err: error }, "provider refusal: write failed"));
                    // Re-measures what just refused, at once, while it's still the freshest signal.
                    void services.headroom.refresh({
                        scope: { providers: [provider], ...(resolvedAccount === undefined ? {} : { account: resolvedAccount }) },
                        maxAgeMs: 0,
                    });
                }
                // The plan does not cover this model: file it so the picker stops offering it.
                recordModelRefusal(services, provider, request.model, event);
                // The provider failed, not the workspace; past budget the frame goes out bare.
                const outage = event.code === "provider-outage" && input.conversationId !== undefined ? recordProviderFailure(provider) : undefined;
                if (outage !== undefined && outage.attempt < OUTAGE_MAX_ATTEMPTS && input.conversationId !== undefined) {
                    outageHit = true;
                    // This conversation's own posture, checked the same way the resume pass will.
                    const armed = await outageResumeArmed(services, input.conversationId);
                    yield {
                        ...event,
                        autoResume: armed ? "scheduled" : "available",
                        outage: {
                            retryAt: Math.round(outage.retryAt / 1000),
                            attempt: outage.attempt + 1,
                            maxAttempts: OUTAGE_MAX_ATTEMPTS,
                        },
                    };
                    continue;
                }
                // Says on the frame whether the daemon will re-mint and re-run this credential.
                const tokenRefused = event.code === "claude-token-refused";
                authRefused ||= tokenRefused;
                if (tokenRefused && resumeArmed) {
                    yield { ...event, autoResume: "scheduled" };
                    continue;
                }
                // The seat, not the credential: signs in fine, but the org switched Claude Code off.
                if (event.code === "claude-not-entitled" && resolvedAccount !== undefined) {
                    void services.claudeSeats
                        .refuse(resolvedAccount, event.message)
                        .catch((error: unknown) => services.logger.warn({ err: error }, "claude account: could not record the entitlement refusal"));
                }
                // One precedence for the reset instant: the frame's own, else the account snapshot.
                const rateLimited = event.code === "rate_limit";
                const resetsAt = rateLimited
                    ? (limitReset ?? event.resetsAt ?? (await limitReopensAt({ services, provider, model: request.model, account: resolvedAccount })))
                    : undefined;
                // Says on the frame whether the turn is held, so Continue knows whether to re-run it.
                if (rateLimited) {
                    limitHit = input.conversationId !== undefined;
                    limitReopens = resetsAt;
                    // The way on, decided once here like `ran`, recorded on the held entry.
                    limitWay = await limitWayOf(services, {
                        turn: input,
                        provider,
                        model: request.model,
                        account: resolvedAccount,
                        ran: providerAnswered,
                        standing: verification.standing(),
                        checklist,
                        contextTokens: context?.tokens,
                        sessionId,
                    });
                }
                // Worth dressing for a reset or a hold; with neither, it falls through bare.
                if (rateLimited && (resetsAt !== undefined || limitHit)) {
                    yield await limitFrame(services, event, {
                        conversationId: input.conversationId,
                        resetsAt,
                        held: limitHit,
                        ran: providerAnswered,
                        way: limitWay,
                    });
                    continue;
                }
            }
            yield event;
        }
    } finally {
        // The token this turn snapshotted is free now; a deferred rotation can happen next tick.
        releaseAccount?.();
        // Drops the anchor, not the namespace: a pane the agent left running keeps it alive.
        isolation?.anchor?.dispose();
        // Remembers a mid-turn credential death for the scheduler, on the frame's own promise.
        if (authRefused && resumeArmed && input.conversationId !== undefined && resolvedAccount !== undefined && request.oauthToken !== undefined) {
            recordAuthFailure({
                input: { ...input, conversationId: input.conversationId },
                ...(sessionId !== undefined ? { sessionId } : {}),
                account: resolvedAccount,
                refusedToken: request.oauthToken,
            });
        }
        // Hands the outage a last-session id so its resume continues rather than repeats work.
        if (outageHit && input.conversationId !== undefined) {
            recordOutageFailure({
                input: { ...input, conversationId: input.conversationId },
                ...(sessionId !== undefined ? { sessionId } : {}),
                provider,
            });
        }
        // Holds a spent-allowance turn whole so a press re-runs it, not a fresh message.
        recordSpentAllowance({
            input,
            sessionId,
            limitHit,
            limitReopens,
            way: limitWay,
            providerAnswered,
            failure,
            standing: verification.standing(),
            checklist,
            contextTokens: context?.tokens,
        });
        record({ type: "turn.completed", ...(usageExtra !== undefined ? { extra: usageExtra } : {}) });
        // A routed turn's files are re-read here, since it never learns which auth file served it.
        if (KeyedProviderSchema.safeParse(provider).success) {
            void services.headroom.refresh({ scope: { providers: [provider] }, maxAgeMs: SETTLE_MAX_AGE_MS });
        }
        // The durable ledger every turn lands on now, including unbilled failures, unlike before.
        const outcome = signal?.aborted === true ? "cancelled" : failure !== undefined ? "error" : "ok";
        const billed = usage !== undefined;
        // How the turn ended beyond `outcome`, gated on the provider speaking, not on being billed.
        const proven = verification.standing();
        const ending = providerAnswered
            ? {
                  verification: proven.state,
                  ...(proven.check !== undefined ? { check: proven.check.slice(0, VERIFICATION_CHECK_CHARS) } : {}),
                  filesEdited: verification.edited().length,
                  compactions,
                  ...(checklist !== undefined
                      ? {
                            checklistTotal: checklist.length,
                            // Pending and in-progress both count as work started but not finished.
                            checklistOpen: checklist.filter((item) => item.status !== "completed").length,
                        }
                      : {}),
                  ...(context !== undefined ? { contextTokens: context.tokens, contextWindow: context.contextWindow } : {}),
              }
            : {};
        services.usage
            .record({
                provider,
                ...attribution,
                ...(request.model !== undefined ? { model: request.model } : {}),
                // Empty as well as absent: the wire allows `model: ""`, the catalog default.
                ...(input.model !== undefined && input.model !== "" ? { modelRequested: input.model } : {}),
                harness: input.harness ?? "native",
                outcome,
                ...(failure?.code !== undefined ? { errorCode: failure.code } : {}),
                ...(failure !== undefined ? { errorMessage: failure.message.slice(0, ERROR_MESSAGE_CHARS) } : {}),
                ...(input.conversationId !== undefined ? { conversationId: input.conversationId } : {}),
                turns: usage?.numTurns ?? (billed ? 1 : 0),
                inputTokens: usage?.inputTokens ?? 0,
                outputTokens: usage?.outputTokens ?? 0,
                cacheReadTokens: usage?.cacheReadTokens ?? 0,
                cacheCreationTokens: usage?.cacheCreationTokens ?? 0,
                costUsd: usage?.costUsd ?? 0,
                durationMs: usage?.durationMs ?? 0,
                // How it ended, past its cost: what changed, what proved it, what's left open.
                ...ending,
                ...(billed ? metrics.reading(verification.edited()) : {}),
                // Which turn of its conversation, so a windowed reader can spot an opening turn.
                ...(plan.turnIndex !== undefined ? { turnIndex: plan.turnIndex } : {}),
                ...(plan.searchArm !== undefined ? { iqSearchArm: plan.searchArm } : {}),
                ...(plan.searchCohort !== undefined ? { iqSearchCohort: plan.searchCohort } : {}),
                // Which project-map arm this conversation drew; rides every turn once sent.
                ...(plan.mapArm !== undefined ? { mapArm: plan.mapArm } : {}),
                ...(plan.mapChars !== undefined ? { mapChars: plan.mapChars } : {}),
                // What the tier judge said, if it ran; absent, not zero, when it didn't.
                ...(tier !== undefined
                    ? {
                          tierScore: tier.verdict.score,
                          tierRules: [...tier.verdict.rules],
                          // Written down, not re-derived: the cutoff is an owner setting.
                          tierFast: tier.verdict.tier === "fast",
                          tierCeiling: tier.verdict.ceiling,
                          tierRouted: tier.model !== undefined && tier.held !== true,
                          // The veto, only between a fast verdict and a real substitution.
                          ...(tier.held === true ? { tierDenied: true } : {}),
                      }
                    : {}),
            })
            .catch((error: unknown) => services.logger.warn({ err: error }, "usage: ledger append failed"));
        // The runtimes with no Stop hook get their Stop from the daemon: the command rules Claude runs at its Stop run
        // here once the frames end, awaited, since the land decision reads the verdict they record next; the follow-up
        // carries what they found along with the built-ins' asks.
        const daemonStopped = daemonStopConversation(input, provider, outcome);
        const findings = await daemonStopFindings(services, { conversationId: daemonStopped, worktree, request, edited: verification.edited(), cwd: effectiveCwd, isolation });
        if (daemonStopped !== undefined) {
            void nudgeUnverifiedWork({
                conversationId: daemonStopped,
                seed: input,
                rules: request.turnEndingRules ?? [],
                ledger: verification,
                view: viewing,
                ...(isolation !== undefined ? { isolation: isolation.plan } : {}),
                cwd: effectiveCwd,
                ...(request.onRuleFired !== undefined ? { onFired: request.onRuleFired } : {}),
                ...(request.verifyTests !== undefined ? { tests: request.verifyTests } : {}),
                findings,
            }).catch((error: unknown) => services.logger.warn({ err: error }, "verify nudge: could not be decided"));
        }
        sniffer.flush();
        // Fire-and-forget snapshot at turn end; isolated turns skip it, main tree untouched.
        if (worktree === undefined) {
            services.history
                .snapshot("turn", input.prompt)
                .catch((error: unknown) => services.logger.warn({ err: error }, "history: turn snapshot failed"));
        }
    }
}

export const createAgentRoutes = (services: Services) => {
    const i = implement(agentContract).$context<OrpcContext>();
    return {
        // Starts the turn detached: the ack carries the run id, and it keeps running regardless of this request.
        // CONFLICT means another window is already mid-turn.
        run: i.run.handler(async ({ input, context }) => {
            if (input.conversationId === undefined) {
                throw new ORPCError("BAD_REQUEST", { message: "conversationId required" });
            }
            const conversationId = input.conversationId;
            // Who is asking, from what the middleware verified on this request, never from the body.
            const actor = actorOf(context.identity, context.principal);
            // Push rides the run's own lifecycle, not this request, since a tab may be asleep.
            const run = await startConversationTurn(services, streamAgent, { ...input, conversationId, ...opt("actor", actor) });
            if (run === undefined) {
                throw new ORPCError("CONFLICT", { message: "a turn is already running for this conversation" });
            }
            return { run: run.id };
        }),
        // Re-runs a turn a spent allowance refused, with everything but who serves it, renamed by the press. NOT_FOUND
        // when nothing is held; never CONFLICT, since a running turn already cleared the entry.
        resume: i.resume.handler(async ({ input }) => {
            const run = await fireLimitResume(services, streamAgent, input.conversationId, input.routing);
            if (run === undefined) {
                throw new ORPCError("NOT_FOUND", { message: "no held turn to run again for that conversation" });
            }
            return { run: run.id };
        }),
        // Renders the run: its head, then every change as it lands, `end` when it settles.
        attach: i.attach.handler(async function* ({ input }) {
            const run = turnRunOf(input.conversationId);
            if (run === undefined) {
                throw new ORPCError("NOT_FOUND", { message: "no live or recent turn for that conversation" });
            }
            const { head, entries } = run.attach();
            yield head;
            for await (const entry of entries) {
                yield entry;
            }
            yield { kind: "end" as const };
        }),
        // Un-parks a turn waiting on a card (plan/question/permission) by requestId; NOT_FOUND freezes it as stale. A
        // dismissed question ends the turn here, synchronously, so the board never shows it running again.
        reply: i.reply.handler(async ({ input, context }) => {
            // The decision's own line, written before the reply ends the turn.
            const held = conversationOf(input.requestId);
            const run = held === undefined ? undefined : turnRunOf(held);
            if (input.kind === "question" && input.cancelled === true) {
                run?.note({ role: "notice", text: "Question dismissed." });
            }
            // Who's answering, carried into settlement; the card itself decides who may answer.
            const applied = await applyReply(services, input, context.identity);
            if (typeof applied === "object") {
                // The card is still parked, waiting for somebody who can answer; 403, not 404.
                throw new ORPCError("FORBIDDEN", { message: applied.refused });
            }
            if (applied === "settled") {
                if (input.kind === "plan") {
                    run?.note({ role: "notice", text: input.approve ? "Plan approved." : "Kept planning." });
                    // The rejection's feedback stays visible, or it vanishes though the agent still has it.
                    if (!input.approve && input.feedback !== undefined && input.feedback.trim().length > 0) {
                        // As the user's own row: staged files travel as @-paths inside the one text field.
                        run?.note(userRow(input.feedback, Date.now(), mentionPaths(input.feedback)));
                    }
                }
                return { ok: true } as const;
            }
            // Remote: nothing held here is unusual, the question was minted on the runner instead.
            const remote = remoteRequestOf(input.requestId);
            const client = remote === undefined ? undefined : services.runnerHub.client(remote.runnerId);
            if (remote !== undefined && client !== undefined) {
                if (input.kind === "question" && input.cancelled === true) {
                    services.agents.stopping(remote.conversationId, "dismissed");
                }
                const answered = await client.reply(input).catch((error: unknown) => {
                    services.logger.warn({ err: error, runner: remote.runnerId }, "runner: forwarding an answer failed");
                    return { applied: false };
                });
                if (answered.applied) {
                    forgetRemoteRequest(input.requestId);
                    return { ok: true } as const;
                }
            }
            throw new ORPCError("NOT_FOUND", { message: `no pending ${input.kind} for that request` });
        }),
        // Injects a message into a running turn, between tool calls; NOT_FOUND means the client queues it for later.
        // Composed exactly like a turn's own prompt, so a mid-turn attachment reads like one on a fresh message.
        steer: i.steer.handler(async ({ input }) => {
            // Remote turns get words uncomposed: paths only resolve in the runner's own workspace.
            const runnerId = services.agents.entry(input.conversationId)?.runner;
            if (runnerId !== undefined) {
                const client = services.runnerHub.client(runnerId);
                if (client === undefined) {
                    throw new ORPCError("NOT_FOUND", { message: `the runner "${runnerId}" is offline, so nothing is running to say this to.` });
                }
                const delivered = await client.steer({
                    conversationId: input.conversationId,
                    text: input.text,
                    ...(input.attachments !== undefined ? { attachments: [...input.attachments] } : {}),
                    ...(input.editorContext !== undefined ? { editorContext: input.editorContext } : {}),
                });
                if (delivered.invalid !== undefined) {
                    throw new ORPCError("BAD_REQUEST", { message: delivered.invalid });
                }
                if (!delivered.applied) {
                    throw new ORPCError("NOT_FOUND", { message: "no steerable turn running for that conversation" });
                }
            } else {
                const composed = composeSteerText(services, input);
                if (composed.invalid !== undefined) {
                    throw new ORPCError("BAD_REQUEST", { message: composed.invalid });
                }
                if (!steerTurn(input.conversationId, composed.text)) {
                    throw new ORPCError("NOT_FOUND", { message: "no steerable turn running for that conversation" });
                }
            }
            // Pushed synchronously, after the queue accepts it and before this handler answers.
            turnRunOf(input.conversationId)?.push({
                kind: "steer",
                text: input.text,
                sentAt: Date.now(),
                ...((input.attachments ?? []).length > 0 ? { attachments: [...(input.attachments ?? [])] } : {}),
            });
            // Reserves this steer's rewind slot in the same synchronous breath as the frame.
            await anchorSteeredMessage(services, input.conversationId);
            // Indexed here, since the prompt index reads a session file once and would miss this.
            const sessionId = services.agents.sessionIdOf(input.conversationId);
            recordConversationPrompt(input.conversationId, input.text);
            if (sessionId !== undefined) {
                recordPrompt(sessionId, input.text);
            }
            return { ok: true } as const;
        }),
        // Hard-cancels the conversation's running turn daemon-side; the browser's own fetch abort can't.
        stop: i.stop.handler(async ({ input }) => {
            const run = turnRunOf(input.conversationId);
            const stopped = stopTurn(input.conversationId);
            // A run can look gone while its pump still finishes cleanup; joining it avoids a race.
            if (!stopped && (run === undefined || run.done)) {
                throw new ORPCError("NOT_FOUND", { message: "no running turn for that conversation" });
            }
            // Marked before the join, covering the unwind where the roster still says running.
            services.agents.stopping(input.conversationId, "stopped");
            // abort() only requests; joining the pump means Stop truly frees the lock.
            await run?.waitUntilFinished();
            return { ok: true } as const;
        }),
        // Rewinds a message, its files, transcript and session together. CONFLICT rather than queuing behind a running
        // turn: by the time it finished, the workspace would have moved on from what the user is looking at.
        rewind: i.rewind.handler(async ({ input }) => {
            const outcome = await rewindConversation(services, input.conversationId, input.index);
            if (outcome === "busy") {
                throw new ORPCError("CONFLICT", { message: "This agent is running a turn, stop it before going back." });
            }
            if (outcome === "no-checkpoint") {
                throw new ORPCError("NOT_FOUND", { message: "That message has no saved file state to go back to." });
            }
            return outcome;
        }),
        // The provider's slash commands from its most recent turn; empty (not an error) if never run.
        commands: i.commands.handler(({ input }) => ({ commands: [...commandsOf(input.agent ?? "claude")] })),
        // What each provider last refused a turn with; empty is the common, healthy case.
        refusals: i.refusals.handler(async () => ({ refusals: await services.providerRefusals.read() })),
    };
};
