import {
    type ActivityEvent,
    type AgentEvent,
    type AgentTurn,
    agentContract,
    capabilitiesOf,
    type EditorContext,
    type WorkspaceEvent,
} from "@intentic/sandbox-contract";
import { implement, ORPCError } from "@orpc/server";
import { createOutboundSniffer } from "../activity/outbound.js";
import { emitWorkspaceEvent } from "../automations/workspace-events.js";
import { cliEnvOf } from "../capabilities/cli-env.js";
import { extensionEnvOf } from "../extensions/extension-env.js";
import { extensionBinDirsOf } from "../extensions/installed-extensions.js";
import { landingGate } from "../gate/gate.js";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../context.js";
import { syncAdvisory, syncWorkspaceRepos } from "../workspace/sync-repos.js";
import { resolveWithin } from "../workspace/workspace-files.js";
import { startAnchor, type TurnPlacement } from "../agents/isolation.js";
import { holdAccount } from "../claude/claude-credentials.js";
import { accountLimitReset } from "../usage/account-usage.js";
import { isIsolated } from "../agents/agents-store.js";
import { landAgent } from "../agents/land.js";
import { recordConversationPrompt, recordPrompt } from "../sessions/prompt-index.js";
import type { AgentRequest } from "./agent.js";
import { withAttachmentNote } from "./attachment-note.js";
import { resolveRequest } from "./agent-requests.js";
import { commandsOf } from "./agent-commands.js";
import { registerTurn, SteeringQueue, steerTurn, stopTurn } from "./agent-steering.js";
import { OUTAGE_MAX_ATTEMPTS, recordProviderFailure, recordProviderSuccess } from "./provider-health.js";
import { authResumable, clearPendingResume, recordAuthFailure, recordOutageFailure, startConversationTurn } from "./turn-resume.js";
import { withRuntimeHistory } from "./runtime-history.js";
import { turnRunOf } from "./turn-runs.js";
import { nameAgentTitle } from "./title-namer.js";
import { planTurn } from "./turn-plan.js";
import { sumUsage, type UsageFrame } from "./turn-usage.js";

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

/* Frames that could only exist because a model request SUCCEEDED: the provider's own words, its thinking, or a
 * tool it decided to call. Any one of them clears a standing outage for every conversation stranded on that
 * provider (provider-health.ts).
 *
 * Both exclusions are load-bearing, and each is a way this list could quietly stop working.
 *
 * The frames the harness mints LOCALLY — `init`, `mode`, `commands`, `session` — prove only that the CLI started.
 * A CLI that boots perfectly and then cannot reach the API emits exactly those and nothing else, so counting them
 * would clear the breaker on the strength of a turn that never got an answer, and release the whole stranded fleet
 * into an outage that is still running.
 *
 * The end-of-turn ACCOUNTING frames — `usage`, `account_usage`, `rate_limit_info` — are the subtler trap: a turn
 * killed by a 500 still reports what its failed attempt cost, and those frames arrive AFTER the error. Counting
 * them would mean every outage failure immediately un-did itself. */
const ANSWERED_FRAMES = new Set<AgentEvent["kind"]>(["delta", "thinking", "tool_call"]);

// Run one agent turn, streaming typed AgentEvents. `input.agent` picks the provider adapter (absent =
// claude); each provider's token is the sandbox's own credential, never held by the platform, with the
// container env as fallback. A turn with no stored account and no env fallback surfaces an actionable error
// rather than an opaque CLI failure.
// Exported because it IS "wake the agent" — the automations scheduler drives the same composition headlessly.
// Owns the turn's control surface: the AbortController /agent/stop hard-cancels (closing the /agent fetch
// sends no cancel frame, so the browser alone can't) and, on the Claude Code harness, the SteeringQueue
// /agent/steer injects mid-turn user messages into. Both are registered under the conversationId for the
// life of the turn; the remaining no-id path is reserved for internal one-shot calls that are not conversations.
export async function* streamAgent(services: Services, input: AgentTurn, signal: AbortSignal | undefined): AsyncGenerator<AgentEvent> {
    const controller = new AbortController();
    if (signal?.aborted === true) {
        controller.abort();
    } else {
        signal?.addEventListener("abort", () => controller.abort(), { once: true });
    }
    // Steering needs the SDK's streaming-input mode, so it exists only where the runtime declares it (see
    // capabilitiesOf — which is NOT the same as the harness the client sent). A native codex/grok or an ACP turn
    // registers abort alone — steering it reports NOT_FOUND and the client falls back.
    const steering = capabilitiesOf(input.agent ?? "claude", input.harness ?? "native").steering ? new SteeringQueue() : undefined;
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

// The fleet-registry lifecycle around every conversation turn. `conversationId` is the boundary: workspace and
// isolated conversations both acquire the mutex, publish every frame and finish in a finally. `isolated` only
// chooses the placement-specific worktree/land flow inside that shared lifecycle.
async function* runConversationTurn(
    services: Services,
    input: AgentTurn,
    signal: AbortSignal | undefined,
    steering: SteeringQueue | undefined,
): AsyncGenerator<AgentEvent> {
    if (input.conversationId === undefined) {
        yield* runTurn(services, input, signal, undefined, steering);
        return;
    }
    const conversationId = input.conversationId;
    // Placement is a property of the conversation, not of whichever client happens to send this turn. A fresh
    // conversation takes the request's choice; every later turn follows the registry entry it already owns.
    const existing = services.agents.entry(conversationId);
    const isolated = existing === undefined ? input.isolated === true : existing.branch !== undefined;
    const began = await services.agents.begin(
        {
            conversationId,
            isolated,
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
    /* The entry now exists, wearing the cut sentence deriveTitle made of this prompt — so write it a real name
     * WHILE the turn runs rather than after it. Fire-and-forget in both senses: a title is never worth failing
     * a turn over, and nothing downstream waits on it (the rename broadcasts on its own, like every other
     * card-visible change). The gate inside skips a conversation already carrying a better-than-derived name,
     * which is what keeps this to one model call per conversation rather than one per turn.
     *
     * Placed ABOVE the isolated/workspace fork on purpose: naming is a property of a conversation, and the
     * version of this that lived at the end of the isolated branch's land step left every workspace
     * conversation on the derived cut forever. */
    nameAgentTitle(services, conversationId, input.prompt).catch((error: unknown) =>
        services.logger.debug({ err: error }, "agents: title naming failed"),
    );
    if (!isolated) {
        try {
            for await (const event of runTurn(services, input, signal, undefined, steering)) {
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
        for await (const event of runTurn(services, input, signal, { id: conversationId, cwd: worktree.cwd }, steering)) {
            services.agents.observe(conversationId, event);
            if (event.kind === "error") {
                failed = true;
            }
            yield event;
        }
        // Auto-land at clean turn completion — the Claude Code review model: the delta arrives in the main
        // tree as UNCOMMITTED changes and the user's ordinary Changes-panel commit is the review. Aborted or
        // errored turns accumulate in the worktree; the next clean turn lands the cumulative delta. With
        // auto-land OFF (the sandbox setting, or this agent's own override) the same pass runs in `measure`
        // mode instead: provenance and diffstat happen, the main tree is not touched, and the held delta
        // waits on the branch as a "Ready to land" card until the user lands it deliberately.
        const finished = services.agents.entry(conversationId);
        if (!failed && signal?.aborted !== true && finished !== undefined && isIsolated(finished)) {
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
                    /* The composite just grew — restart the gate's quiet countdown (gate/gate.ts). Deliberately
                     * AFTER the land and not per turn: the artifact worth checking is the main tree with every
                     * agent's delta in it, which is the only thing a push can carry, and a check inside this
                     * turn's worktree would have resolved its cross-package imports against /work's unedited
                     * sources anyway (agents/worktrees.ts). The gate collapses a landing burst into one run. */
                    landingGate(services, streamAgent).arm();
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

// Preflight is a few hundred ms of local work plus one throttled fetch; past this it is a defect worth a line,
// not ordinary load. Well under the browser's 10s liveness watchdog, so a preflight that trips this has usually
// already shown the user a "connecting" flash.
const SLOW_PREFLIGHT_MS = 5_000;

// One agent turn's body, on the main tree (`worktree` undefined) or inside an isolated conversation's
// worktree — the cwd override is the single binding point every provider adapter, the tmux Bash path, and the
// SDK session store follow.
async function* runTurn(
    services: Services,
    input: AgentTurn,
    signal: AbortSignal | undefined,
    worktree: { readonly id: string; readonly cwd: string } | undefined,
    steering: SteeringQueue | undefined,
): AsyncGenerator<AgentEvent> {
    // Whatever turn runs on this conversation supersedes a pending usage-limit resume — the user retrying by
    // hand (or the scheduler's own fire, which comes through here) must not be doubled by the scheduler later.
    if (input.conversationId !== undefined) {
        clearPendingResume(input.conversationId);
    }
    /* Turn preflight is where a slow start hides. Between here and `turn.started` below sit namespace setup, a
     * network git-fetch, the token refresh, the browser-server bring-up and a history snapshot — and not one of
     * them records a duration, so a turn that took a minute to start reads in the log exactly like one that
     * started instantly. These marks make the slow step name itself: a 128s event-loop freeze in this span once
     * left behind nothing but a `turn.started` that happened to be very late, and cost days to attribute. */
    const preflightStart = Date.now();
    const preflightStages: Record<string, number> = {};
    const mark = (stage: string): void => {
        preflightStages[stage] = Date.now() - preflightStart;
    };
    // cli-kind capabilities contribute env vars (their stored credentials) so either agent's shell can run
    // their CLI tools; extension `contributes.settings` with an `env` name inject theirs the same way.
    const cliEnv = { ...(await cliEnvOf(services)), ...(await extensionEnvOf(services)) };
    // Extensions that ship an agent CLI (contributes.bin — e.g. ext-discord's `discord-voice`) get their bin dir
    // prepended to the turn's PATH, so the tool resolves by name in the agent's shell across every runtime.
    const binDirs = await extensionBinDirsOf(services);
    if (binDirs.length > 0) {
        cliEnv["PATH"] = [...binDirs, process.env["PATH"] ?? ""].filter((entry) => entry !== "").join(":");
    }
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
    const localCwd = worktree?.cwd ?? services.workspace.root;
    /* Built before anything else needs it, and torn down in this turn's finally. Undefined for a main-tree
     * turn, which means the shared checkout and says so.
     *
     * Gated on the runtime that actually ENTERS the namespace — the `isolation` field of its declared record,
     * which is "namespace" for exactly one of them. The Claude Code loop enters through the SDK's spawn seam; a
     * native Codex turn drives an in-process SDK with no such seam, and an ACP turn talks to a pooled connection
     * that outlives this turn. Building an anchor for those would be worse than skipping it: `effectiveCwd`
     * below would hand them /work — the SHARED tree — while they sit outside the namespace that makes /work mean
     * the worktree. They keep pointing straight at their worktree instead, and are TOLD so (turn-plan.ts folds
     * the worktree note into their prompt), which is the only enforcement layer left for them.
     *
     * A container with no mount capability keeps the PLAN and loses only the anchor: the turn runs cwd'd in
     * its worktree as before, and the harness applies the same mapping to tool inputs instead
     * (agents/worktree-redirect.ts). That fallback used to be nothing at all, which is how three agents spent
     * a morning writing into the shared tree while their worktrees stayed empty. */
    const isolation: TurnPlacement | undefined =
        worktree === undefined || capabilitiesOf(input.agent ?? "claude", input.harness ?? "native").isolation !== "namespace"
            ? undefined
            : await services.turnIsolation.planFor(localCwd).then(async (plan) => {
                  if (!(await services.turnIsolation.available())) {
                      return { plan };
                  }
                  return { plan, anchor: await startAnchor(plan) };
              });
    mark("isolation");
    const effectiveCwd = isolation?.anchor?.cwd ?? localCwd;
    // Kick the repo sync off now so its network git-fetch overlaps the token refresh, browser-server setup,
    // and config reads below instead of running strictly after them. Throttled to 60s, so it's a no-op on most
    // turns; awaited just before the snapshot, which must see the pulled files (the attribution fence below).
    // A top-level failure degrades to no advisory — per-repo errors already ride inside the outcomes.
    // Isolated turns skip it entirely: the worktree pins a stable base by design, and fast-forwarding the main
    // checkout mid-conversation would only manufacture land conflicts.
    const syncPromise =
        worktree !== undefined
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
        // Which agent the children this turn spawns belong to (agent/subagents.ts). Absent for a turn with no
        // conversation behind it, whose children are not surfaced.
        ...(input.conversationId !== undefined ? { conversationId: input.conversationId } : {}),
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
    mark("plan");
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
    mark("repoSync");
    if (advisory !== undefined) {
        request = { ...request, prompt: `${advisory}\n\n${request.prompt}` };
    }
    // Attribution fence: capture anything pending as user-authored (terminal edits, desktop-sync arrivals,
    // unflushed UI writes) BEFORE the agent runs, so the turn-end snapshot below is purely the agent's work.
    // A no-op skip when the tree is clean; a history failure never blocks a turn. Isolated turns skip BOTH
    // snapshots: history captures the MAIN tree, which an isolated turn never touches — the worktree branch's
    // diff-vs-base is that conversation's review and rollback surface.
    if (worktree === undefined) {
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
    mark("snapshot");
    // Tee every frame past the activity sniffer — outbound provider calls (discord curl) are only visible
    // here, and every turn origin (chat, automation wake, voice wake) flows through this generator.
    const sniffer = createOutboundSniffer(services);
    // Turn lifecycle into the activity log — the durable trail of every turn (start, plan artifacts, errors,
    // completion with usage) that survives rebuilds and the agent's own reach, while full content stays in
    // the SDK transcript. Fire-and-forget: logging must never delay or fail a turn.
    const provider = input.agent ?? "claude";
    let sessionId = input.sessionId;
    // The reset instant the stream last named (rate_limit_event rides ahead of the refusal it explains), so a
    // rate_limit frame can tell the client when the spent window reopens.
    let limitReset: number | undefined;
    // Set when the API refused this turn's credential mid-flight. Acted on in the finally so the resume
    // snapshots the turn's LAST session id — the one holding whatever it had done.
    let authRefused = false;
    /* Whether an auth refusal on THIS turn would be re-minted and re-run. Needs the exact token that was refused
     * (so the rotation supersedes it rather than replaying it) and the account it belongs to, which is why only a
     * turn on a STORED Claude account qualifies: the container-env fallback has no refresh token behind it and
     * nothing to re-mint from. And not a turn that is already a resume — see authResumable.
     *
     * Read twice, from one place: the error FRAME says whether a renewal is coming (the client renders a spinner
     * or a red line off it), and the finally actually records it. Two copies of this condition is two ways for
     * the chat's promise and the daemon's behaviour to disagree. */
    const resumeArmed =
        input.conversationId !== undefined && resolvedAccount !== undefined && request.oauthToken !== undefined && authResumable(input.prompt);
    /* The provider failed this turn transiently and a resume is worth arming. Same finally-time handling as the
     * one above, for the same reason: the resume wants the LAST session id, because a 500 that lands mid-turn
     * leaves real work behind it and the resume should continue from there rather than redo it. */
    let outageHit = false;
    // Whether the provider has answered THIS turn at all. Any real content proves it is serving requests, which
    // is what clears a standing outage for every conversation stranded on it — recovery is detected off ordinary
    // traffic instead of a probe anyone has to pay for. Once per turn: the breaker only needs the first word.
    let providerAnswered = false;
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
    const preflightMs = Date.now() - preflightStart;
    if (preflightMs >= SLOW_PREFLIGHT_MS) {
        services.logger.warn(
            { preflightMs, stages: preflightStages },
            "turn preflight slow — the stage marks say which step, and a stalled event loop inflates all of them at once",
        );
    }
    record({ type: "turn.started", content: input.prompt.slice(0, 2_000) });
    /* Claim that account for as long as this turn holds its token. The token rode into the agent subprocess env
     * at spawn and cannot be replaced there, so a rotation landing now would kill this turn outright — the hold
     * is what makes the proactive refresh wait for a gap instead (claude/claude-credentials.ts). Taken on the
     * very edge of the try whose finally releases it: a hold leaked by a throw in between would block that
     * account's rotation for the rest of the daemon's life. */
    const releaseAccount = resolvedAccount !== undefined ? holdAccount(resolvedAccount) : undefined;
    try {
        for await (const event of run(request)) {
            /* AN ABORT IS NOT A FAILURE, and this is the one place that can say so for every provider.
             *
             * Each of the four adapters reports the unwind of a hard-cancel as an error frame — a thrown
             * AbortError from the SDK, a subprocess killed mid-stream, an ACP connection torn down — because
             * from inside the adapter that is indistinguishable from the provider dying. So a user pressing
             * Stop got the full failure treatment: `turn.error` in the activity log, an error line frozen into
             * the durable transcript, the frame relayed to a client that had already said "Stopped.", and — the
             * one that showed — `errored` on the registry entry, which finish() writes through as status
             * `error`. Every deliberately stopped agent landed on a red card in the Attention lane.
             *
             * Gated on the turn's own signal, which /agent/stop is the only thing that trips (the request
             * signal is deliberately not wired in — see the run route), so a genuine failure is never swallowed
             * by it. Dropped whole rather than downgraded: everything below this line is a reaction to a
             * failure — the outage breaker, the usage-limit resume, the client's error card — and none of them
             * has anything to do for a turn the user chose to end. */
            if (event.kind === "error" && signal?.aborted === true) {
                continue;
            }
            sniffer.observe(event);
            /* The provider spoke. Whatever this turn is — a resume, a fresh message, an automation wake — it has
             * just proved the outage is over for every conversation stranded on this provider, so the whole
             * stranded set is released instead of each waiting out its own backoff (provider-health.ts).
             *
             * Above the routing chain rather than inside it: this is a fact about the provider, not about what the
             * frame means to the client, and the branches below `continue` past each other freely. Once per turn —
             * the breaker only needs the first word. */
            if (ANSWERED_FRAMES.has(event.kind)) {
                // Content AFTER an outage failure means the harness got past it and this turn carried on, so there
                // is nothing stranded here to resume — the pending record would re-run a turn that finished.
                outageHit = false;
                if (!providerAnswered) {
                    providerAnswered = true;
                    recordProviderSuccess(provider);
                }
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
                    services.accountUsage
                        .record(resolvedAccount, { windows: event.windows, measuredAt: Date.now() })
                        .catch((error: unknown) => services.logger.warn({ err: error }, "account usage: snapshot write failed"));
                }
                yield { ...event, ...(resolvedAccount !== undefined ? { account: resolvedAccount } : {}) };
                continue;
            } else if (event.kind === "plan") {
                record({ type: "turn.plan", content: event.text, extra: { requestId: event.requestId } });
            } else if (event.kind === "error") {
                record({ type: "turn.error", outcome: "error", error: event.message });
                /* The provider failed us, not the workspace. Open (or re-observe) its outage and tell the client
                 * where the resume stands: which attempt this is, when the next one is due, and whether it is
                 * armed or merely on offer behind the setting. Past the attempt budget nothing more will fire, so
                 * the frame goes out bare — a promise of a retry that will never come is worse than the red line
                 * it replaced. */
                if (event.code === "provider-outage" && input.conversationId !== undefined) {
                    const outage = recordProviderFailure(provider);
                    if (outage.attempt < OUTAGE_MAX_ATTEMPTS) {
                        outageHit = true;
                        const { resumeAfterOutage } = await services.sandboxSettings.get();
                        yield {
                            ...event,
                            autoResume: resumeAfterOutage ? "scheduled" : "available",
                            outage: {
                                retryAt: Math.round(outage.retryAt / 1000),
                                attempt: outage.attempt + 1,
                                maxAttempts: OUTAGE_MAX_ATTEMPTS,
                            },
                        };
                        continue;
                    }
                }
                /* The credential was refused mid-turn. Say on the frame whether the daemon is going to re-mint
                 * and re-run this turn, because that is the difference between a notice and a red line and the
                 * client cannot work it out: the recording happens in the finally below, after this frame is
                 * long gone. Same condition, named once (see resumeArmed) — a frame promising a renewal that the
                 * finally then declines to arm leaves a spinner turning over a turn that is never coming back. */
                if (event.code === "claude-token-refused") {
                    authRefused = true;
                    if (resumeArmed) {
                        yield { ...event, autoResume: "scheduled" };
                        continue;
                    }
                }
                if (event.code === "rate_limit") {
                    // An api_retry rate limit carries the SDK's own retry instant directly. Older/final refusal
                    // shapes still resolve through the preceding rate_limit_event or the persisted account
                    // snapshot — one precedence, whatever the rate-limit source.
                    const resetsAt = limitReset ?? event.resetsAt ?? (await accountLimitReset(services.accountUsage, resolvedAccount));
                    if (resetsAt !== undefined) {
                        yield { ...event, resetsAt };
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
        // The credential died under this turn — remember it so the next scheduler pass re-mints and re-runs it.
        // Armed on exactly the condition the frame above already promised the client (see resumeArmed); the
        // narrowing repeats because TypeScript cannot carry it across the closure boundary.
        if (authRefused && resumeArmed && input.conversationId !== undefined && resolvedAccount !== undefined && request.oauthToken !== undefined) {
            recordAuthFailure({
                input: { ...input, conversationId: input.conversationId },
                ...(sessionId !== undefined ? { sessionId } : {}),
                account: resolvedAccount,
                refusedToken: request.oauthToken,
            });
        }
        // The provider killed this turn — hand it to the outage pass with the last session the stream reported, so
        // the resume continues from whatever it had already done rather than paying for all of it twice. Recorded
        // whatever the toggle says, so turning resumeAfterOutage on right after the failure arms this very turn.
        if (outageHit && input.conversationId !== undefined) {
            recordOutageFailure({
                input: { ...input, conversationId: input.conversationId },
                ...(sessionId !== undefined ? { sessionId } : {}),
                provider,
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
                    ...(input.conversationId !== undefined ? { conversationId: input.conversationId } : {}),
                    turns: usage.numTurns ?? 1,
                    inputTokens: usage.inputTokens ?? 0,
                    outputTokens: usage.outputTokens ?? 0,
                    cacheReadTokens: usage.cacheReadTokens ?? 0,
                    cacheCreationTokens: usage.cacheCreationTokens ?? 0,
                    costUsd: usage.costUsd ?? 0,
                    durationMs: usage.durationMs ?? 0,
                    // The turn experiments' arms, when this turn was in them — the ledger is the only place they
                    // are recorded, and without them the steer's and the pre-injection's effects are
                    // unmeasurable after the fact.
                    ...(plan.terseArm !== undefined ? { terse: plan.terseArm } : {}),
                    ...(plan.contextArm !== undefined ? { iqContext: plan.contextArm } : {}),
                })
                .catch((error: unknown) => services.logger.warn({ err: error }, "usage: ledger append failed"));
        }
        sniffer.flush();
        // Fire-and-forget workspace snapshot at turn end (aborted turns included) — history must never delay
        // or fail a turn. The raw prompt (not the enriched request) labels the checkpoint in the user's words.
        // Isolated turns skip it (main tree untouched); their registry finish lives in streamAgent's finally.
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
            // goes through notifyIfAway, so a user watching the turn finish is told nothing. The journal entry
            // rides along too — see startConversationTurn.
            const run = startConversationTurn(services, streamAgent, { ...input, conversationId });
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
            recordConversationPrompt(input.conversationId, input.text);
            if (sessionId !== undefined) {
                recordPrompt(sessionId, input.text);
            }
            return { ok: true } as const;
        }),
        // Hard-cancel the conversation's running turn daemon-side (the browser's fetch abort can't).
        stop: i.stop.handler(async ({ input }) => {
            const run = turnRunOf(input.conversationId);
            const stopped = stopTurn(input.conversationId);
            // A run can have unregistered its abort handle while its detached pump is still crossing the final
            // cleanup boundary. That is already stopped for the caller's purposes; join it instead of returning
            // NOT_FOUND and reopening the same send race during this smaller tail window.
            if (!stopped && (run === undefined || run.done)) {
                throw new ORPCError("NOT_FOUND", { message: "no running turn for that conversation" });
            }
            // The press, published. Everything below this line is the unwind — seconds of it, on a turn holding
            // a long tool call — and until it lands the roster would still be saying `running` to every surface
            // watching this agent, spinner and all. Marked before the join, not after, because the whole point
            // is to fill exactly the window the join waits out.
            services.agents.stopping(input.conversationId);
            // abort() is only a request. The detached pump remains the conversation's live run until its
            // generator unwinds (including worktree/registry cleanup), so acknowledging before then lets an
            // immediate next message collide with the old run and get a bogus "another window" conflict.
            // Join the run here: a successful Stop response now means the conversation lock is truly free.
            await run?.waitUntilFinished();
            return { ok: true } as const;
        }),
        // The provider's slash commands from its most recent turn. Empty (not an error) when it has never run
        // one here — the popover simply stays closed until the first turn publishes the list.
        commands: i.commands.handler(({ input }) => ({ commands: [...commandsOf(input.agent ?? "claude")] })),
    };
};
