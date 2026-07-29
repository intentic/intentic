import {
    type ActivityEvent,
    type AgentEvent,
    type AgentTurn,
    agentContract,
    type EditorContext,
    runsClaudeCode,
    type WorkspaceEvent,
} from "@intentic/sandbox-contract";
import { implement, ORPCError } from "@orpc/server";
import { createOutboundSniffer } from "../activity/outbound.js";
import { emitWorkspaceEvent } from "../automations/workspace-events.js";
import { cliEnvOf } from "../capabilities/cli-env.js";
import { extensionEnvOf } from "../extensions/extension-env.js";
import { extensionBinDirsOf } from "../extensions/installed-extensions.js";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../context.js";
import { syncAdvisory, syncWorkspaceRepos } from "../workspace/sync-repos.js";
import { resolveWithin } from "../workspace/workspace-files.js";
import { startAnchor, type TurnPlacement } from "../agents/isolation.js";
import { holdAccount } from "../claude/claude-credentials.js";
import { landAgent } from "../agents/land.js";
import { recordPrompt } from "../sessions/prompt-index.js";
import type { AgentRequest } from "./agent.js";
import { withAttachmentNote } from "./attachment-note.js";
import { resolveRequest } from "./agent-requests.js";
import { commandsOf } from "./agent-commands.js";
import { registerTurn, SteeringQueue, steerTurn, stopTurn } from "./agent-steering.js";
import { accountLimitReset, clearPendingResume, pendingLimitHit, recordAuthFailure, recordLimitHit, resumeTurnOf } from "./turn-resume.js";
import { withRuntimeHistory } from "./runtime-history.js";
import { startTurnRun, turnRunOf } from "./turn-runs.js";
import { summarizeAgentTitle } from "./title-summary.js";
import { planTurn } from "./turn-plan.js";
import { sumUsage, type UsageFrame } from "./turn-usage.js";
import { turnAwaiting, turnFinished } from "../push/notifications.js";

// Fold the opt-in editor context (the composer chip, off by default) into the prompt: the file the user is
// looking at and, when they selected text, the lines themselves — so deictic prompts ("fix this") ground
// without an @-mention. Four-backtick fence so a selection containing ``` doesn't break out.
const editorContextNote = (context: EditorContext): string => {
    if (context.selection === undefined) {
        return `The user has \`${context.file}\` open in the editor — "this file" likely refers to it.`;
    }
    const range = context.startLine !== undefined && context.endLine !== undefined ? ` (lines ${context.startLine}-${context.endLine})` : "";
    return `The user has \`${context.file}\` open in the editor with this text selected${range} — "this" likely refers to it:\n\`\`\`\`\n${context.selection}\n\`\`\`\``;
};

// Run one agent turn, streaming typed AgentEvents. `input.agent` picks the provider adapter (absent =
// claude); each provider's token is the sandbox's own credential, never held by the platform, with the
// container env as fallback. A turn with no stored account and no env fallback surfaces an actionable error
// rather than an opaque CLI failure.
// Exported because it IS "wake the agent" — the automations scheduler drives the same composition headlessly.
// Owns the turn's control surface: the AbortController /agent/stop hard-cancels (closing the /agent fetch
// sends no cancel frame, so the browser alone can't) and, on the Claude Code harness, the SteeringQueue
// /agent/steer injects mid-turn user messages into. Both are registered under the conversationId for the
// life of the turn; a headless wake without one runs unregistered (nothing to steer or stop it by).
export async function* streamAgent(services: Services, input: AgentTurn, signal: AbortSignal | undefined): AsyncGenerator<AgentEvent> {
    const controller = new AbortController();
    if (signal?.aborted === true) {
        controller.abort();
    } else {
        signal?.addEventListener("abort", () => controller.abort(), { once: true });
    }
    // Steering needs the SDK's streaming-input mode, so it exists only where the Claude Code loop runs the turn
    // (see runsClaudeCode — which is NOT the same as the harness the client sent). A native codex/grok or an ACP
    // turn registers abort alone — steering it reports NOT_FOUND and the client falls back.
    const steering = runsClaudeCode(input.agent ?? "claude", input.harness ?? "native") ? new SteeringQueue() : undefined;
    const unregister =
        input.conversationId !== undefined
            ? registerTurn(input.conversationId, { abort: () => controller.abort(), ...(steering !== undefined ? { steering } : {}) })
            : undefined;
    try {
        yield* runConversationTurn(services, input, controller.signal, steering);
    } finally {
        unregister?.();
        steering?.close();
    }
}

// The fleet-registry lifecycle around a turn. An ISOLATED turn (isolated + conversationId) is wrapped here —
// mutex acquire + worktree ensure before the turn, finish (usage flush + mutex release) in a finally — so
// EVERY exit of the turn body (provider gates, stream errors, aborts) releases the conversation. A wake
// carrying an OUTSIDE message comes through here too — automations/scheduler.ts mints its conversation, which
// is what puts a Discord mention on the fleet board as an ordinary agent. Schedule and chore wakes have no
// conversation and run the main-tree body unchanged.
async function* runConversationTurn(
    services: Services,
    input: AgentTurn,
    signal: AbortSignal | undefined,
    steering: SteeringQueue | undefined,
): AsyncGenerator<AgentEvent> {
    if (input.isolated !== true || input.conversationId === undefined) {
        yield* runTurn(services, input, signal, undefined, steering);
        return;
    }
    const conversationId = input.conversationId;
    const began = await services.agents.begin(
        {
            conversationId,
            prompt: input.prompt,
            provider: input.agent ?? "claude",
            harness: input.harness ?? "native",
            ...(input.title !== undefined ? { title: input.title } : {}),
            ...(input.model !== undefined ? { model: input.model } : {}),
            ...(input.effort !== undefined ? { effort: input.effort } : {}),
            ...(input.thinking !== undefined ? { thinking: input.thinking } : {}),
            ...(input.account !== undefined ? { account: input.account } : {}),
            ...(input.origin !== undefined ? { origin: input.origin } : {}),
        },
        Date.now(),
    );
    if (!began) {
        yield { kind: "error", code: "agent-busy", message: "This agent is already running a turn — wait for it to finish." };
        yield { kind: "done" };
        return;
    }
    // What THIS turn's land did, for the `turn.settled` chore event below — a historical record of one turn,
    // which is the one thing a verdict is still good for. The CARD's state is no longer read from it: where the
    // work stands is derived per roster from the branch and the main tree (agents/standing.ts).
    let outcome: "landed" | "conflict" | "ready" | undefined;
    // Hoisted out of the try because the chore emit in the finally reads them: the span this turn's workspace
    // event names, the branch it ran on, and whether it ended on an error frame.
    let span: WorkspaceEvent["repos"] = [];
    let branch = "";
    let failed = false;
    try {
        // Lazily create (first turn) or repair the conversation's worktree composition, then announce it.
        const entry = services.agents.entry(conversationId);
        const worktree = await services.agentWorktrees.ensure(conversationId, entry?.repos ?? []);
        if ((entry?.repos.length ?? 0) === 0) {
            await services.agents.recordWorktree(conversationId, worktree.repos);
        }
        branch = worktree.branch;
        // Where each repo stood BEFORE this turn — the open span a chore diffs from. Captured up front because
        // the auto-land below advances landedTip; read afterwards, every repo would report as unchanged.
        span = worktree.repos.map(({ repo, base }) => ({
            repo,
            from: entry?.repos.find((recorded) => recorded.repo === repo)?.landedTip ?? base,
            dir: services.agentWorktrees.worktreeDir(conversationId, repo),
        }));
        const base = (worktree.repos.find((repo) => repo.repo === "root") ?? worktree.repos[0])?.base.slice(0, 7) ?? "";
        // Reported per turn, not once at boot: the capability is a property of how the container was launched,
        // and the only reason anyone noticed it was missing was work turning up in the main tree.
        const enforced = await services.turnIsolation.available();
        yield { kind: "worktree", branch: worktree.branch, base, ...(enforced ? {} : { unenforced: true }) };
        // Relay the turn while watching for error frames — a failed turn must not auto-land half-done work.
        // The agent's top-level text is accumulated on the way past: the CLOSING block is what the title-
        // summary pass below reads, and collecting it here costs nothing a transcript re-read would.
        let textBlock = "";
        let closing = "";
        for await (const event of runTurn(services, input, signal, { id: conversationId, cwd: worktree.cwd }, steering)) {
            if (event.kind === "error") {
                failed = true;
            }
            if (event.kind === "delta" && event.parentToolUseId === undefined) {
                textBlock += event.text;
            }
            if (event.kind === "text_end" && event.parentToolUseId === undefined && textBlock !== "") {
                closing = textBlock;
                textBlock = "";
            }
            yield event;
        }
        if (textBlock !== "") {
            closing = textBlock;
        }
        // Auto-land at clean turn completion — the Claude Code review model: the delta arrives in the main
        // tree as UNCOMMITTED changes and the user's ordinary Changes-panel commit is the review. Aborted or
        // errored turns accumulate in the worktree; the next clean turn lands the cumulative delta. With
        // auto-land OFF (the sandbox setting, or this agent's own override) the same pass runs in `measure`
        // mode instead: provenance and diffstat happen, the main tree is not touched, and the held delta
        // waits on the branch as a "Ready to land" card until the user lands it deliberately.
        const finished = services.agents.entry(conversationId);
        if (!failed && signal?.aborted !== true && finished !== undefined) {
            const { autoLand } = await services.sandboxSettings.get();
            const landed = await landAgent(services.agentWorktrees, finished, (finished.autoLand ?? autoLand) ? "check" : "measure");
            if (!landed.changed && landed.diff.files > 0) {
                // Nothing NEW to land, but the agent's cumulative output exists and is all accounted for in
                // the main tree — a follow-up turn that only answered a question must not downgrade the card
                // from Landed to Idle. No frame and no chore: nothing moved. (Reachable under measure too —
                // held work the user already landed by hand — and means the same thing there.)
                outcome = "landed";
            }
            if (landed.changed) {
                await services.agents.recordLanded(conversationId, landed);
                outcome = landed.held === true ? "ready" : landed.landed ? "landed" : "conflict";
                yield {
                    kind: "landed",
                    landed: landed.landed,
                    ...(landed.conflicts !== undefined ? { conflicts: landed.conflicts } : {}),
                    ...(landed.held === true ? { held: true } : {}),
                };
                if (landed.landed) {
                    // The main tree just changed — give the History timeline its turn checkpoint, labeled with
                    // the prompt, exactly like a non-isolated turn's snapshot.
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
            // A whole turn is now readable — name the job. Fire-and-forget: a title is never worth failing a
            // turn over, and the gate inside skips conversations already carrying a better-than-derived name.
            summarizeAgentTitle(services, conversationId, { prompt: input.prompt, closing }).catch((error: unknown) =>
                services.logger.debug({ err: error }, "agents: title summary failed"),
            );
        }
    } finally {
        await services.agents.finish(conversationId, Date.now());
        // Once per turn, whatever the outcome — the errored and conflicted ones are the ones most worth a
        // second pair of eyes. An empty span means the worktree never came up, so there is nothing to review.
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

// One agent turn's body, on the main tree (`conversation` undefined) or inside an isolated conversation's
// worktree — the cwd override is the single binding point every provider adapter, the tmux Bash path, and the
// SDK session store follow.
async function* runTurn(
    services: Services,
    input: AgentTurn,
    signal: AbortSignal | undefined,
    conversation: { readonly id: string; readonly cwd: string } | undefined,
    steering: SteeringQueue | undefined,
): AsyncGenerator<AgentEvent> {
    // Whatever turn runs on this conversation supersedes a pending usage-limit resume — the user retrying by
    // hand (or the scheduler's own fire, which comes through here) must not be doubled by the scheduler later.
    if (input.conversationId !== undefined) {
        clearPendingResume(input.conversationId);
    }
    // cli-kind capabilities contribute env vars (their stored credentials) so either agent's shell can run
    // their CLI tools; extension `contributes.settings` with an `env` name inject theirs the same way.
    const cliEnv = { ...(await cliEnvOf(services)), ...(await extensionEnvOf(services)) };
    // Extensions that ship an agent CLI (contributes.bin — e.g. ext-discord's `discord-voice`) get their bin dir
    // prepended to the turn's PATH, so the tool resolves by name in the agent's shell across every runtime.
    const binDirs = await extensionBinDirsOf(services);
    if (binDirs.length > 0) {
        cliEnv["PATH"] = [...binDirs, process.env["PATH"] ?? ""].filter((entry) => entry !== "").join(":");
    }
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
    // The editor-context chip's file rides workspace-relative too — same escape guard as attachments.
    if (input.editorContext !== undefined && resolveWithin(services.workspace.root, input.editorContext.file) === undefined) {
        yield { kind: "error", message: `invalid editor context path: ${input.editorContext.file}` };
        yield { kind: "done" };
        return;
    }
    /* WHERE THIS TURN LIVES — two answers, and conflating them is a whole class of bug.
     *
     * `localCwd` is the tree as the DAEMON reaches it: the conversation's worktree, or /work for a main-tree
     * turn. Everything the daemon itself runs against the files (the dependency-readiness probe, the hashline
     * edit server) uses this, because the daemon is not in the turn's namespace.
     *
     * `effectiveCwd` is the workspace root as the AGENT sees it. Isolated, that is /work — which inside the
     * namespace resolves to `localCwd` — so the agent's own space is at the path every absolute path it
     * inherits already names, and nothing has to be remembered or forbidden. */
    const localCwd = conversation?.cwd ?? services.workspace.root;
    /* Built before anything else needs it, and torn down in this turn's finally. Undefined for a main-tree
     * turn, which means the shared checkout and says so.
     *
     * Gated on the harness that actually ENTERS the namespace. The Claude Code loop does, through the SDK's
     * spawn seam; a native Codex turn drives an in-process SDK with no such seam, and an ACP turn talks to a
     * pooled connection that outlives this turn. Building an anchor for those would be worse than skipping it:
     * `effectiveCwd` below would hand them /work — the SHARED tree — while they sit outside the namespace that
     * makes /work mean the worktree. They keep pointing straight at their worktree instead, as they do today.
     *
     * A container with no mount capability keeps the PLAN and loses only the anchor: the turn runs cwd'd in
     * its worktree as before, and the harness applies the same mapping to tool inputs instead
     * (agents/worktree-redirect.ts). That fallback used to be nothing at all, which is how three agents spent
     * a morning writing into the shared tree while their worktrees stayed empty. */
    const isolation: TurnPlacement | undefined =
        conversation === undefined || !runsClaudeCode(input.agent ?? "claude", input.harness ?? "native")
            ? undefined
            : await services.turnIsolation.planFor(localCwd).then(async (plan) => {
                  if (!(await services.turnIsolation.available())) {
                      return { plan };
                  }
                  return { plan, anchor: await startAnchor(plan) };
              });
    const effectiveCwd = isolation?.anchor?.cwd ?? localCwd;
    // Kick the repo sync off now so its network git-fetch overlaps the token refresh, browser-server setup,
    // and config reads below instead of running strictly after them. Throttled to 60s, so it's a no-op on most
    // turns; awaited just before the snapshot, which must see the pulled files (the attribution fence below).
    // A top-level failure degrades to no advisory — per-repo errors already ride inside the outcomes.
    // Isolated turns skip it entirely: the worktree pins a stable base by design, and fast-forwarding the main
    // checkout mid-conversation would only manufacture land conflicts.
    const syncPromise =
        conversation !== undefined
            ? undefined
            : syncWorkspaceRepos(services, 60_000).catch((error: unknown) => {
                  services.logger.warn({ err: error }, "repo sync failed");
                  return [];
              });
    // Editor context attaches to THIS message, so it folds in before the (older) history preamble wraps it.
    const promptWithEditor = input.editorContext !== undefined ? `${input.prompt}\n\n${editorContextNote(input.editorContext)}` : input.prompt;
    const base: AgentRequest = {
        prompt: input.history !== undefined && input.history.length > 0 ? withRuntimeHistory(promptWithEditor, input.history) : promptWithEditor,
        cwd: effectiveCwd,
        ...(isolation !== undefined ? { isolation } : {}),
        signal: signal ?? new AbortController().signal,
        ...(Object.keys(cliEnv).length > 0 ? { cliEnv } : {}),
        ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
        ...(input.model !== undefined ? { model: input.model } : {}),
        ...(input.permissionMode !== undefined ? { permissionMode: input.permissionMode } : {}),
        ...(input.effort !== undefined ? { effort: input.effort } : {}),
    };
    /* WHICH RUNTIME SERVES THIS TURN AND WHAT IT IS HANDED — resolved as a value (turn-plan.ts), so the four
     * providers' gates and request assembly live together instead of interleaved with the lifecycle below.
     * A refusal is one of them: an ordinary state of a sandbox (a session id that outlived its transcript, a
     * subscription nobody connected, an uninstalled Agent capability), reported as the error frame the
     * composer's connect gate reads. */
    const plan = await planTurn(services, input, { base, attachmentPaths, localCwd, effectiveCwd, cliEnv, steering });
    if (!plan.ok) {
        // The namespace anchor was built before the gates ran, so a refusal has to take it down too — it is a
        // detached `unshare` process that lives until something kills it, and every one of these refusals is a
        // condition the user hits repeatedly (an unconnected subscription answers the same way on every press).
        isolation?.anchor?.dispose();
        yield { kind: "error", ...(plan.code !== undefined ? { code: plan.code } : {}), message: plan.message };
        yield { kind: "done" };
        return;
    }
    const { run } = plan;
    // The provider account that serves this turn — the attribution key stamped onto the usage/rate-limit frames
    // and the activity log below.
    const resolvedAccount = plan.account;
    let request = plan.request;
    // Bring every repo with a remote up to its latest commit before the agent reads the tree, so the turn works
    // on current code. Clean-only fast-forward — a dirty/diverged/detached repo is left as-is and its stale state
    // reported into the prompt so the agent knows. Throttled per repo; a network failure on one repo is isolated
    // into its outcome, never blocking the turn. Runs before the attribution snapshot so pulled files land as
    // user-authored, not attributed to this turn.
    const advisory = syncPromise === undefined ? undefined : syncAdvisory(await syncPromise);
    if (advisory !== undefined) {
        request = { ...request, prompt: `${advisory}\n\n${request.prompt}` };
    }
    // Attribution fence: capture anything pending as user-authored (terminal edits, desktop-sync arrivals,
    // unflushed UI writes) BEFORE the agent runs, so the turn-end snapshot below is purely the agent's work.
    // A no-op skip when the tree is clean; a history failure never blocks a turn. Isolated turns skip BOTH
    // snapshots: history captures the MAIN tree, which an isolated turn never touches — the worktree branch's
    // diff-vs-base is that conversation's review and rollback surface.
    if (conversation === undefined) {
        // The turn-start state's checkpoint id: the fence capture when it recorded something, else the newest
        // visible checkpoint (a clean tree at turn start IS that checkpoint's state — the common case). The
        // client hangs "restore to before this message" on the frame; no id (fresh workspace) ⇒ no button.
        const checkpointId = await services.history
            .snapshot("user")
            .then(async (id) => id ?? (await services.history.list())[0]?.id)
            .catch((error: unknown) => {
                services.logger.warn({ err: error }, "history: turn-start snapshot failed");
                return undefined;
            });
        if (checkpointId !== undefined) {
            yield { kind: "checkpoint", id: checkpointId };
        }
    }
    // Tee every frame past the activity sniffer — outbound provider calls (discord curl) are only visible
    // here, and every turn origin (chat, automation wake, voice wake) flows through this generator.
    const sniffer = createOutboundSniffer(services);
    // Turn lifecycle into the activity log — the durable trail of every turn (start, plan artifacts, errors,
    // completion with usage) that survives rebuilds and the agent's own reach, while full content stays in
    // the SDK transcript. Fire-and-forget: logging must never delay or fail a turn.
    const provider = input.agent ?? "claude";
    let sessionId = input.sessionId;
    // The usage-limit trail for auto-resume: the reset instant the stream last named (rate_limit_event rides
    // ahead of the refusal it explains), and — once a rate_limit error actually ends the turn's work — the
    // instant the pending resume is recorded against in the finally below. Recorded at settle, not at the
    // error frame, so the resume snapshots the turn's LAST session id rather than a mid-turn one.
    let limitReset: number | undefined;
    let limitHitAt: number | undefined;
    // Set when the API refused this turn's credential mid-flight. Like limitHitAt, it is acted on in the
    // finally so the resume snapshots the turn's LAST session id — the one holding whatever it had done.
    let authRefused = false;
    let usageExtra: Record<string, unknown> | undefined;
    // The turn's usage, kept typed (unlike usageExtra, which is the activity log's opaque `extra`) so the spend
    // ledger below appends numbers rather than re-narrowing unknowns. SUMMED, not last-wins: a turn emits one
    // frame per SDK turn, and a steered follow-up or an imp-mode round is a second one — the money is the total.
    let usage: UsageFrame | undefined;
    const record = (event: Omit<ActivityEvent, "id" | "at" | "provider" | "direction">): void => {
        void services.activity
            .append({
                provider,
                direction: "system",
                ...(resolvedAccount !== undefined ? { account: resolvedAccount } : {}),
                ...(sessionId !== undefined ? { sessionId } : {}),
                ...event,
            })
            .catch((error: unknown) => services.logger.warn({ err: error }, "activity: turn event append failed"));
    };
    record({ type: "turn.started", content: input.prompt.slice(0, 2_000) });
    /* Claim that account for as long as this turn holds its token. The token rode into the agent subprocess env
     * at spawn and cannot be replaced there, so a rotation landing now would kill this turn outright — the hold
     * is what makes the proactive refresh wait for a gap instead (claude/claude-credentials.ts). Taken on the
     * very edge of the try whose finally releases it: a hold leaked by a throw in between would block that
     * account's rotation for the rest of the daemon's life. */
    const releaseAccount = resolvedAccount !== undefined ? holdAccount(resolvedAccount) : undefined;
    try {
        for await (const event of run(request)) {
            sniffer.observe(event);
            // Fold every frame into the fleet registry so the card shows live status/activity/cost.
            if (conversation !== undefined) {
                services.agents.observe(conversation.id, event);
            }
            if (event.kind === "session") {
                sessionId = event.sessionId;
            } else if (event.kind === "usage") {
                usage = sumUsage(usage, event);
                const { kind: _kind, ...rest } = usage;
                usageExtra = rest;
                // Attribute the per-turn totals (and the account-wide rate-limit snapshot) to the account that
                // served the turn, so the client keys its usage displays by account.
                yield { ...event, ...(resolvedAccount !== undefined ? { account: resolvedAccount } : {}) };
                continue;
            } else if (event.kind === "rate_limit_info") {
                limitReset = event.resetsAt ?? limitReset;
                yield { ...event, ...(resolvedAccount !== undefined ? { account: resolvedAccount } : {}) };
                continue;
            } else if (event.kind === "account_usage") {
                // Persist the windows as well as streaming them, so the account picker can report this
                // account's headroom on the next page load instead of only for as long as this tab stays open.
                // Attributed turns only — an env-token turn has no account to key it by. Fire-and-forget: a
                // usage write must never delay or fail a turn (same contract as the activity append below).
                if (resolvedAccount !== undefined) {
                    services.claudeUsage
                        .record(resolvedAccount, { windows: event.windows, measuredAt: Date.now() })
                        .catch((error: unknown) => services.logger.warn({ err: error }, "claude usage: snapshot write failed"));
                }
                yield { ...event, ...(resolvedAccount !== undefined ? { account: resolvedAccount } : {}) };
                continue;
            } else if (event.kind === "plan") {
                record({ type: "turn.plan", content: event.text, extra: { requestId: event.requestId } });
            } else if (event.kind === "error") {
                record({ type: "turn.error", outcome: "error", error: event.message });
                // A spent Claude allowance: resolve when the window reopens (the stream's own rate_limit_event,
                // else the account's persisted binding window) and tell the client where the resume stands, so
                // the chat can say "continues automatically at …" or offer the toggle at the moment it would
                // have helped. No reset instant ⇒ nothing to schedule against ⇒ the plain frame, as before.
                authRefused ||= event.code === "claude-token-refused";
                if (event.code === "rate_limit" && input.conversationId !== undefined) {
                    limitHitAt = limitReset ?? (await accountLimitReset(services, resolvedAccount));
                    if (limitHitAt !== undefined) {
                        const { autoResumeOnLimit } = await services.sandboxSettings.get();
                        // The account is the daemon-resolved one, not the client's selection (which can be
                        // empty): it names whose allowance is spent, so the client can offer the provider's
                        // OTHER accounts as a resume-now (/agent/resume-limit) instead of only the wait.
                        yield {
                            ...event,
                            resetsAt: limitHitAt,
                            autoResume: autoResumeOnLimit ? "scheduled" : "available",
                            ...(resolvedAccount !== undefined ? { account: resolvedAccount } : {}),
                        };
                        continue;
                    }
                }
            }
            yield event;
        }
    } finally {
        // The token this turn snapshotted is nobody's constraint any more — a rotation deferred while it ran
        // can happen on the next tick.
        releaseAccount?.();
        // Drop the namespace anchor. Not a kill of the namespace itself: a pane the agent left running (a dev
        // server it started) is still in there and keeps it alive until it exits, which is exactly the
        // behaviour a user watching that terminal expects.
        isolation?.anchor?.dispose();
        // The limit killed this turn's work — remember it for the resume scheduler, with the last session the
        // stream reported (the one holding any partial progress). Recorded whatever the toggle says: enabling
        // autoResumeOnLimit right after the failure arms exactly this resume.
        if (limitHitAt !== undefined && input.conversationId !== undefined) {
            recordLimitHit({
                input: { ...input, conversationId: input.conversationId },
                ...(sessionId !== undefined ? { sessionId } : {}),
                resetsAt: limitHitAt,
            });
        }
        /* The credential died under this turn — remember it so the next scheduler pass re-mints and re-runs it.
         * Needs the exact token that was refused (so the rotation supersedes it rather than replaying it) and
         * the account it belongs to, which is why only a turn on a STORED Claude account qualifies: the
         * container-env fallback has no refresh token behind it and nothing to re-mint from. */
        if (authRefused && input.conversationId !== undefined && resolvedAccount !== undefined && request.oauthToken !== undefined) {
            recordAuthFailure({
                input: { ...input, conversationId: input.conversationId },
                ...(sessionId !== undefined ? { sessionId } : {}),
                account: resolvedAccount,
                refusedToken: request.oauthToken,
            });
        }
        record({ type: "turn.completed", ...(usageExtra !== undefined ? { extra: usageExtra } : {}) });
        // The spend ledger — the durable, never-pruned record the cost dashboard reads. Only turns the provider
        // actually billed land here: no usage frame means no spend to attribute, and a zero row would inflate
        // the turn count with turns that cost nothing (the activity log already carries those for the audit
        // trail). Aborted turns DO land — a cancelled turn still spent what it spent before the stop.
        // `request.model` is the model resolved past the client's pick and every provider default, which is the
        // one the money was spent on; `harness` and the conversation make cost-by-model and cost-by-agent
        // answerable without a second source. Fire-and-forget, same contract as every other turn-end write.
        if (usage !== undefined) {
            services.usage
                .record({
                    provider,
                    ...(resolvedAccount !== undefined ? { account: resolvedAccount } : {}),
                    ...(request.model !== undefined ? { model: request.model } : {}),
                    harness: input.harness ?? "native",
                    ...(conversation !== undefined ? { conversationId: conversation.id } : {}),
                    turns: usage.numTurns ?? 1,
                    inputTokens: usage.inputTokens ?? 0,
                    outputTokens: usage.outputTokens ?? 0,
                    cacheReadTokens: usage.cacheReadTokens ?? 0,
                    cacheCreationTokens: usage.cacheCreationTokens ?? 0,
                    costUsd: usage.costUsd ?? 0,
                    durationMs: usage.durationMs ?? 0,
                    // The terse experiment's arm, when this turn was in it — the ledger is the only place it is
                    // recorded, and without it the steer's effect is unmeasurable after the fact.
                    ...(plan.terseArm !== undefined ? { terse: plan.terseArm } : {}),
                })
                .catch((error: unknown) => services.logger.warn({ err: error }, "usage: ledger append failed"));
        }
        sniffer.flush();
        // Fire-and-forget workspace snapshot at turn end (aborted turns included) — history must never delay
        // or fail a turn. The raw prompt (not the enriched request) labels the checkpoint in the user's words.
        // Isolated turns skip it (main tree untouched); their registry finish lives in streamAgent's finally.
        if (conversation === undefined) {
            services.history
                .snapshot("turn", input.prompt)
                .catch((error: unknown) => services.logger.warn({ err: error }, "history: turn snapshot failed"));
        }
    }
}

export const createAgentRoutes = (services: Services) => {
    const i = implement(agentContract).$context<OrpcContext>();
    return {
        // Start the conversation's turn as a detached run — the ack carries the run id and the turn executes
        // regardless of what happens to this request (the request signal is deliberately not wired in; the
        // only cancel is /agent/stop). CONFLICT = another window/device is mid-turn on this conversation.
        run: i.run.handler(({ input }) => {
            if (input.conversationId === undefined) {
                throw new ORPCError("BAD_REQUEST", { message: "conversationId required" });
            }
            const conversationId = input.conversationId;
            // Push notifications ride the run's lifecycle, not this request's: the point is to reach a user
            // whose tab is asleep or closed, which is exactly when nobody is reading the response. Every send
            // goes through notifyIfAway, so a user watching the turn finish is told nothing.
            const run = startTurnRun(
                (turn, signal) => streamAgent(services, turn, signal),
                { ...input, conversationId },
                {
                    awaiting: (kind) => void services.pushSender.notifyIfAway(turnAwaiting(conversationId, kind)),
                    settled: (outcome) => void services.pushSender.notifyIfAway(turnFinished(conversationId, input.prompt, outcome)),
                },
            );
            if (run === undefined) {
                throw new ORPCError("CONFLICT", { message: "a turn is already running for this conversation" });
            }
            return { run: run.id };
        }),
        // Render the conversation's run: head (identity + replay/live boundary), frames from the client's
        // cursor, `end` when the run settles. A cursor naming a superseded run replays the current one from
        // its first frame — the head's run id tells the client which world it's in.
        attach: i.attach.handler(async function* ({ input }) {
            const run = turnRunOf(input.conversationId);
            if (run === undefined) {
                throw new ORPCError("NOT_FOUND", { message: "no live or recent turn for that conversation" });
            }
            yield { kind: "attached" as const, run: run.id, prompt: run.prompt, startedAt: run.startedAt, seq: run.seq };
            const after = input.run === run.id ? (input.after ?? 0) : 0;
            for await (const frame of run.follow(after)) {
                yield { kind: "frame" as const, ...frame };
            }
            yield { kind: "end" as const };
        }),
        // Un-park a turn waiting on an interactive card — a plan approval, question picks, or a per-tool
        // permission prompt, all keyed by the same requestId. NOT_FOUND when nothing holds that id (already
        // answered, or the turn ended), which is what tells the client to freeze the card as stale.
        reply: i.reply.handler(({ input }) => {
            if (!resolveRequest(input)) {
                throw new ORPCError("NOT_FOUND", { message: `no pending ${input.kind} for that request` });
            }
            return { ok: true } as const;
        }),
        // Inject a user message into the conversation's running turn (delivered between tool calls);
        // NOT_FOUND when no steerable turn is live — the client then keeps it queued for the next turn.
        // The message is composed exactly like a turn's own prompt (editor-context note, then the attachment
        // note over workspace-resolved paths), so adding a file mid-turn reads the same to the agent as
        // attaching it to a fresh message.
        steer: i.steer.handler(({ input }) => {
            const paths: string[] = [];
            for (const rel of input.attachments ?? []) {
                const abs = resolveWithin(services.workspace.root, rel);
                if (abs === undefined) {
                    throw new ORPCError("BAD_REQUEST", { message: `invalid attachment path: ${rel}` });
                }
                paths.push(abs);
            }
            if (input.editorContext !== undefined && resolveWithin(services.workspace.root, input.editorContext.file) === undefined) {
                throw new ORPCError("BAD_REQUEST", { message: `invalid editor context path: ${input.editorContext.file}` });
            }
            const withEditor = [input.text, ...(input.editorContext !== undefined ? [editorContextNote(input.editorContext)] : [])]
                .filter((part) => part !== "")
                .join("\n\n");
            if (!steerTurn(input.conversationId, paths.length > 0 ? withAttachmentNote(withEditor, paths) : withEditor)) {
                throw new ORPCError("NOT_FOUND", { message: "no steerable turn running for that conversation" });
            }
            // A steered message is something the user SAID, so the fleet filter has to find it. Recorded here
            // rather than left to the transcript because the prompt index reads a session's file once and holds
            // it (prompt-index.ts) — a mid-turn message that only ever landed in the file would be invisible to
            // every search until the daemon restarted. `input.text`, not the composed prompt: the editor-context
            // note and the attachment note are protocol, and matching them would hit every steered turn at once.
            const sessionId = services.agents.sessionIdOf(input.conversationId);
            if (sessionId !== undefined) {
                recordPrompt(sessionId, input.text);
            }
            return { ok: true } as const;
        }),
        // Hard-cancel the conversation's running turn daemon-side (the browser's fetch abort can't).
        stop: i.stop.handler(({ input }) => {
            if (!stopTurn(input.conversationId)) {
                throw new ORPCError("NOT_FOUND", { message: "no running turn for that conversation" });
            }
            return { ok: true } as const;
        }),
        // Fire the conversation's remembered usage-limit resume NOW, on `account` when the user picked one of
        // the provider's other accounts — a spent allowance on one account is no reason to wait when a second
        // has headroom. The same detached-run shape as `run`/the scheduler's own fire, so every window can
        // attach to the resumed turn. NOT_FOUND = nothing pending (a fresh turn superseded the failure, or the
        // daemon restarted and the in-memory entry died with it) — the client retires its offer on it.
        resumeLimit: i.resumeLimit.handler(({ input }) => {
            const hit = pendingLimitHit(input.conversationId);
            if (hit === undefined) {
                throw new ORPCError("NOT_FOUND", { message: "no usage-limit resume is pending for that conversation" });
            }
            const conversationId = input.conversationId;
            // Cleared before firing, like the scheduler's own fire — the turn this starts supersedes the
            // entry (and clears it again at its own start; a resume that re-hits the limit records afresh).
            clearPendingResume(conversationId);
            const turn = resumeTurnOf(hit, input.account);
            const run = startTurnRun((resumed, signal) => streamAgent(services, resumed, signal), turn, {
                awaiting: (kind) => void services.pushSender.notifyIfAway(turnAwaiting(conversationId, kind)),
                settled: (outcome) => void services.pushSender.notifyIfAway(turnFinished(conversationId, turn.prompt, outcome)),
            });
            if (run === undefined) {
                throw new ORPCError("CONFLICT", { message: "a turn is already running for this conversation" });
            }
            services.logger.info({ conversationId, account: input.account }, "usage-limit resume fired by hand");
            return { run: run.id };
        }),
        // The provider's slash commands from its most recent turn. Empty (not an error) when it has never run
        // one here — the popover simply stays closed until the first turn publishes the list.
        commands: i.commands.handler(({ input }) => ({ commands: [...commandsOf(input.agent ?? "claude")] })),
    };
};
