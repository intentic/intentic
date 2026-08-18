import { randomUUID } from "node:crypto";
import {
    type ActivityEvent,
    type AgentEvent,
    type AgentTurn,
    agentContract,
    capabilitiesOf,
    type EditorContext,
    type SnapshotTurn,
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
import type { DependencyLandOrigin } from "../workspace/dependency-origin.js";
import { queueVerify, type VerifyDeps } from "../workspace/verify-deps.js";
import { syncAdvisory, syncWorkspaceRepos } from "../workspace/sync-repos.js";
import { resolveWithin } from "../workspace/workspace-files.js";
import { startAnchor, type TurnPlacement } from "../agents/isolation.js";
import { holdAccount } from "../claude/claude-credentials.js";
import { accountLimitReset } from "../usage/account-usage.js";
import { isIsolated } from "../agents/agents-store.js";
import { anchorWorktree, forkWorktreeBase } from "./anchor-worktree.js";
import { landAgent } from "../agents/land.js";
import { describeLandingInBackground } from "../agents/landed-subject.js";
import { landingPaths } from "../agents/landing-paths.js";
import { landingVerdict, standing } from "../rules/rules.js";
import { type RepoSync, syncConversation } from "../agents/sync.js";
import { recordConversationPrompt, recordPrompt } from "../sessions/transcript-search.js";
import { handoffHistory, turnStartIndex } from "../sessions/turn-transcript.js";
import type { AgentRequest } from "./agent.js";
import { adapterFor } from "./adapter-registry.js";
import { withAttachmentNote } from "./attachment-note.js";
import { preambleNotes, withTurnPreamble } from "./turn-preamble.js";
import { conversationOf, resolveRequest } from "./agent-requests.js";
import { rewindConversation } from "./rewind.js";
import { commandsOf } from "./agent-commands.js";
import { isFileWorkCall, isSearchCall, searchPrecedesFileWork } from "./tool-calls.js";
import { mentionsSpentAllowance } from "./failure-sentences.js";
import { registerTurn, SteeringQueue, steerTurn, stopTurn } from "./agent-steering.js";
import { OUTAGE_MAX_ATTEMPTS, recordProviderFailure, recordProviderSuccess } from "./provider-health.js";
import {
    authResumable,
    clearPendingResume,
    outageResumeArmed,
    recordAuthFailure,
    recordOutageFailure,
    startConversationTurn,
} from "./turn-resume.js";
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
    let steering: SteeringQueue | undefined;
    let unregister: (() => void) | undefined;
    try {
        // Steering needs the SDK's streaming-input mode, so it exists only where the runtime declares it (see
        // capabilitiesOf — which is NOT the same as the harness the client sent). A native codex/grok or an ACP
        // turn registers abort alone — steering it reports NOT_FOUND and the client falls back.
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

/* THE BOOKS, SETTLED ON A TURN NOBODY LET FINISH — everything the end-of-turn pass does EXCEPT touch the main
 * tree.
 *
 * A dismissed question ends its turn by aborting it (the reply handler below), as does the user's own Stop, and
 * an aborted turn skipped that pass outright. Skipping the LAND is the point and stays — half-finished work does
 * not belong in someone's workspace. But landing is not all that pass does: it is also the only moment a
 * conversation's bookkeeping is reconciled with the world. The worktree's remainder is preserved on the branch,
 * the card's diffstat is refreshed, and a span the main tree has since taken by another road — the user
 * committed what was landed, an agent put its work on the main line itself — is finally marked accounted-for.
 *
 * Unrun, that reconciliation has no other moment: it waits for the next turn, and a conversation the user has
 * finished with never has one. A card sat in Finished offering to land work the workspace already held, and the
 * one press that would have cleared it was the one press that could not be explained. So the pass still runs,
 * in `measure` — the mode that means settle the books, the main tree is not yours to touch. Waving a question
 * away still cannot put a line of code in the user's workspace.
 *
 * Never fatal: this runs on the way out of a turn that has already ended, and a git fault here must not become
 * the ending the user reads. */
const settleLandBooks = async (services: Services, conversationId: string): Promise<void> => {
    const entry = services.agents.entry(conversationId);
    if (entry === undefined || !isIsolated(entry)) {
        return;
    }
    try {
        const measured = await landAgent(services.agentWorktrees, entry, "measure");
        if (measured.changed) {
            await services.agents.recordLanded(conversationId, measured);
        }
    } catch (error) {
        services.logger.warn({ err: error, id: conversationId }, "agents: settling an ended turn's land books failed");
    }
};

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
    /* THE PERSONA NO LONGER GETS A WORD ON PLACEMENT, and taking it away cost nothing: the card's field could
     * say "own copy" — which every caller here already asks for — or "the shared workspace", which was the one
     * way a session could opt OUT of the worktree that lets several of them run at once. The scheduler, the
     * workflow runner, CI, extension updates and a fresh chat all send `isolated: true` of their own accord, so
     * what the field actually bought was a way to make a persona quietly less safe than the surface that ran it.
     *
     * So placement is the conversation's, decided once: the request's own choice on the first turn, and the
     * registry entry it already owns on every turn after. That entry is read before the turn is planned because
     * the worktree has to exist before there is a cwd to plan against. */
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
            ...(input.fast !== undefined ? { fast: input.fast } : {}),
            ...(input.account !== undefined ? { account: input.account } : {}),
            ...(input.origin !== undefined ? { origin: input.origin } : {}),
            /* A fork names its source on its first turn and only then — `forkOf` rides exactly one request, and
             * the entry keeps what it said. `keep` counts the source's record rows above the cut, which IS the
             * index of the message the cut sat above, so the source can put its own mark back in that gap. */
            ...(input.forkOf !== undefined
                ? { forkedFrom: { conversationId: input.forkOf.conversationId, index: input.forkOf.keep, files: input.forkOf.files } }
                : {}),
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
    // WARN, not debug: this pass is invisible by construction — nobody waits on it and its only output is a
    // rename that silently doesn't happen. At debug it sat below the daemon's own level and failed unnoticed
    // for every conversation the sandbox ever ran, which is how a rate-limited quick model went undiagnosed
    // while 240 fleet cards wore the derivation's cut sentence.
    nameAgentTitle(services, conversationId, input.prompt).catch((error: unknown) =>
        services.logger.warn({ err: error }, "agents: title naming failed"),
    );
    /* Where this turn sits in its conversation — read ONCE here, above the isolated/workspace fork, because
     * both arms end in a turn checkpoint and both must file it under the same index. Awaited rather than
     * fire-and-forget: it is one read of an already-open record, and a checkpoint that arrives without its
     * binding is a message the user cannot rewind to. */
    const turn: SnapshotTurn = { conversationId, index: await turnStartIndex(services, { ...input, conversationId }) };
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
    // What THIS turn's land did, for the `turn.settled` chore event below — a historical record of one turn,
    // which is the one thing a verdict is still good for. The CARD's state is no longer read from it: where the
    // work stands is derived per roster from the branch and the main tree (agents/standing.ts).
    let outcome: "landed" | "conflict" | "ready" | undefined;
    // Hoisted out of the try because the chore emit in the finally reads them: the span this turn's workspace
    // event names, the branch it ran on, and whether it ended on an error frame.
    let span: WorkspaceEvent["repos"] = [];
    let branch = "";
    let failed = false;
    // Whether the end-of-turn pass below actually ran. The finally settles the books itself when it did not —
    // which is every turn a person ended early (see settleLandBooks).
    let reconciled = false;
    try {
        // Lazily create (first turn) or repair the conversation's worktree composition, then announce it.
        const entry = services.agents.entry(conversationId);
        /* A FORK THAT ASKED FOR THE FILES AS THEY WERE starts its checkout at the source's own commits for that
         * message, so the two lines of work are genuinely comparable — without this, "try it another way from
         * here" would begin at whatever the workspace had become by the time it was asked, and the comparison
         * it exists for would be against the wrong thing. Undefined wherever that cannot be honoured (see
         * forkWorktreeBase), which falls through to today's files rather than refusing to start.
         *
         * A workflow's own pinned base still wins: it pins every candidate to ONE snapshot on purpose, and a
         * fork inside one must not quietly step off it. */
        const worktreeBase = input.worktreeBase ?? (await forkWorktreeBase(services.turnAnchors, input.forkOf));
        const worktree = await services.agentWorktrees.ensure(conversationId, entry?.repos ?? [], worktreeBase);
        if ((entry?.repos.length ?? 0) === 0) {
            await services.agents.recordWorktree(conversationId, worktree.repos);
        }
        /* Then put the branch on TODAY's main line, before the model reads a line of it (agents/sync.ts). A
         * conversation parked on a question can sit for hours while the user commits around it, and everything
         * downstream of here — what the agent reads, what it edits, what the auto-land tries to apply — is
         * measured against a base that went stale in the meantime. Empty on the ordinary turn whose branch is
         * already up to date, which is one `merge-base` per repo to establish.
         *
         * A CLOSURE rather than a straight call, because the turn's start is not the only moment the ground
         * moves: a turn that parks on a question or a plan approval waits MINUTES for a person (measured
         * median 2.6, p90 9.4), and the main line moves during one park in five. So the same pass runs again
         * each time a card settles — the harness calls it back through `resync` (agent.ts) — and every record
         * that names a base is advanced here, whichever moment took the rebase. */
        const onto = new Map<string, string>();
        // Tracked because it sits on the critical path and its two costs differ by orders of magnitude: one
        // `merge-base` per repo when the branch is current, a whole checkout replay when it is not. runTurn's
        // own preflight marks start after this, so an unmeasured rebase would read as a turn that was simply
        // slow to begin — the exact attribution failure those marks exist to prevent.
        const syncOnto = async (): Promise<RepoSync[]> => {
            // Workflow steps deliberately stay on the run's immutable snapshot. Rebasing candidates here would
            // reintroduce the timing race the snapshot removed: whichever fan-out arm opened last would compare
            // against a newer workspace, and a resumed iteration could change ground halfway through its step.
            if (input.worktreeBase !== undefined) {
                return [];
            }
            const synced = await services.perf.track("agent.sync", { id: conversationId }, () =>
                syncConversation(services.agentWorktrees, conversationId, worktree.repos, services.agents.entry(conversationId)?.title),
            );
            const moved = synced.filter((repo) => repo.blocked !== true);
            if (moved.length === 0) {
                return synced;
            }
            for (const repo of moved) {
                onto.set(repo.repo, repo.onto);
            }
            // `base` is where the branch sits on the main line, so a rebase moves it — and a stale one is not
            // cosmetic: standing.ts reads `tip !== base` as "this agent produced something", and would call a
            // branch that only fast-forwarded a finished piece of work. The land bookkeeping beside it
            // (landedTip/landedHead) is deliberately left alone: those shas are the provenance of a land that
            // really happened, and anchorOf already knows to fall through to the merge-base once a rewrite has
            // orphaned them (agents/agent-changes.ts).
            await services.agents.recordWorktree(
                conversationId,
                // oxlint-disable-next-line oxc/no-map-spread -- these are the registry's own persisted records; a fresh object per repo is the point, not a saving
                (services.agents.entry(conversationId)?.repos ?? worktree.repos).map((composed) => ({
                    ...composed,
                    base: onto.get(composed.repo) ?? composed.base,
                })),
            );
            // The open span below is captured once, at turn start, and a mid-turn rebase ORPHANS the sha it
            // names: diffing a chore from a rewritten commit hands it this agent's work plus every main-line
            // commit underneath it. Everything at or before `onto` is in main by definition, so the repos that
            // just moved restart their span there — the same rung the turn-start capture lands on. Empty on
            // that first call, where the span does not exist yet and the map below reads `onto` directly.
            span = span.map((repo) => ({ repo: repo.repo, from: onto.get(repo.repo) ?? repo.from, dir: repo.dir }));
            return synced;
        };
        // Reported per turn, not once at boot: the capability is a property of how the container was launched,
        // and the only reason anyone noticed it was missing was work turning up in the main tree.
        const enforced = await services.turnIsolation.available();
        /* WHERE THIS TURN IS STANDING — the frame at the top of the turn, and again whenever a sync moves the
         * branch out from under a parked card. `base` is read through `onto` rather than from the composition
         * record, so it names where the branch sits NOW: a rebase is precisely the event that makes the
         * frozen checkout-moment sha the wrong answer, and both emissions have to mean the same thing for the
         * second one to be readable at all.
         *
         * The sync half is the human's (the agent's is a note): present only when the branch was BEHIND, it
         * rides the frame that already announces the standing, so the transcript says why the ground moved at
         * exactly the point it moved — a passive line, never a prompt. */
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
        // Where each repo stood BEFORE this turn — the open span a chore diffs from. Captured up front because
        // the auto-land below advances landedTip; read afterwards, every repo would report as unchanged. A repo
        // the sync moved reads from the main-line sha it moved ONTO instead of its landedTip: the rebase
        // orphaned that sha, and diffing from it would hand the chore this agent's work plus every main-line
        // commit underneath it. Everything at or before `onto` is in main by definition, so it is the honest
        // start — the same rung anchorOf lands on for a rewritten branch, and the rung a mid-turn sync moves
        // this span back to (syncOnto).
        span = worktree.repos.map(({ repo, base }) => ({
            repo,
            from: onto.get(repo) ?? entry?.repos.find((recorded) => recorded.repo === repo)?.landedTip ?? base,
            dir: services.agentWorktrees.worktreeDir(conversationId, repo),
        }));
        yield worktreeFrame(synced);
        /* THIS TURN'S BEFORE-STATE, in the currency an isolated conversation has: its own branch. The main
         * tree's fence capture (runTurn, below) is not available here — history covers /work, which this turn
         * never touches — so the equivalent is to commit whatever is sitting in the checkout and remember the
         * commit per repo. On the ordinary clean checkout it writes nothing and simply reads HEAD.
         *
         * Recorded AFTER the rebase above, deliberately: what the agent is about to read is the rebased branch,
         * so that is the state "before this message" means. An anchor taken before it would send a fork back to
         * a main line the source never worked against.
         *
         * This is what makes an agent's own history reachable at all. Until it existed, an isolated
         * conversation had no per-message state anywhere: rewind had nothing to offer, and a fork could only
         * start from wherever the checkout happened to have got to by the time somebody asked — which is not
         * the point the user pointed at. Best-effort: a repo that will not commit costs its own anchor, never
         * the turn. */
        const anchored = await anchorWorktree(services, conversationId, worktree.repos);
        if (anchored.length > 0) {
            await services.turnAnchors
                .record(turn.conversationId, turn.index, { kind: "worktree", repos: anchored })
                .catch((error: unknown) => services.logger.warn({ err: error }, "anchors: recording the turn's commits failed"));
        }
        /* The rebase the harness takes back whenever a card settles (agent.ts). It answers with the frame the
         * transcript needs, and with undefined on the ordinary answer, where the branch was already on today's
         * main line and there is nothing to report. The MODEL is told nothing either way — see turn-preamble.ts
         * on why the note this used to carry is gone.
         *
         * Only the moments where the model re-derives what to do next get this: a question's picks and an
         * approved plan. NOT a permission card, whose tool call was already computed against the tree as it
         * was — moving the file under an approved Edit is how a "yes" turns into a failure the user authored. */
        const resync = async (): Promise<AgentEvent | undefined> => {
            // A rebase must never cost the user their answer. At turn start a failing sync IS a failing turn —
            // nothing has happened yet and the fault is worth surfacing — but here the person has already
            // clicked, and a git fault that propagated would come back to them as a failed tool call in place
            // of the answer they gave. So this one is best-effort and logged: the branch stays where it is, the
            // turn carries on, and the land-time conflict flow is still behind it.
            try {
                const moved = await syncOnto();
                // An empty answer is a branch that was already current: no movement, so no frame either.
                return moved.length === 0 ? undefined : worktreeFrame(moved);
            } catch (error) {
                services.logger.warn({ err: error, id: conversationId }, "agents: sync on a settled card failed");
                return undefined;
            }
        };
        // Relay the turn while watching for error frames — a failed turn must not auto-land half-done work.
        for await (const event of runTurn(services, input, signal, { id: conversationId, cwd: worktree.cwd, synced, resync }, steering, turn)) {
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
            /* THE `agent.finished` MOMENT — does this work reach the tree by itself? A verdict rather than
             * something that runs, because nothing extra happens here: the pass below runs either way and the
             * rule only picks which way it goes. `measure` is the held form — provenance and diffstat happen,
             * the main tree is untouched, and the delta waits on the branch as a "Ready to land" card.
             *
             * The per-agent override (this turn's, then the card's) still wins over the table: an owner who
             * pressed hold on one card meant that card. With neither, and no rule matching, work is HELD —
             * which is the recoverable mistake, and the default a sandbox with an empty table has. */
            const { rules } = await services.sandboxSettings.get();
            /* The changed paths cost a git pass per repo, so they are read ONLY when a rule here actually
             * narrows by path. The common shapes — an empty table, or "land everything" — never pay for it. */
            const finishedRules = standing(rules, "agent.finished");
            const paths = finishedRules.some((rule) => (rule.when?.paths?.length ?? 0) > 0)
                ? await landingPaths(services, finished, span)
                : undefined;
            const decided = landingVerdict(rules, { repos: span.map(({ repo }) => repo), paths }, input.autoLand ?? finished.autoLand);
            const landed = await landAgent(services.agentWorktrees, finished, decided.land ? "check" : "measure");
            reconciled = true;
            /* A rule that decided a card's fate did something, and the settings list says so. The per-agent
             * override reports no rule, because in that case none decided.
             *
             * Only a HOLD reaches the feed. Landing is self-evident — the work is in the tree — while work that
             * did not arrive is the thing someone goes looking for an explanation of, and "a rule you wrote
             * held it" is that explanation. An empty table holds too, and says nothing: nobody wrote that, so
             * there is no rule to name and nothing was decided that the card does not already show. */
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
                // Nothing NEW to land, but the agent's cumulative output exists and is all accounted for in
                // the main tree — a follow-up turn that only answered a question must not downgrade the card
                // from Landed to Idle. No frame and no chore: nothing moved. (Reachable under measure too —
                // held work the user already landed by hand — and means the same thing there.)
                outcome = "landed";
            }
            if (landed.changed) {
                await services.agents.recordLanded(conversationId, landed);
                outcome = landed.held === true ? "ready" : landed.landed ? "landed" : "conflict";
                if (landed.landed) {
                    // What this turn's work DID, drafted from the diff it just put in the tree, for the
                    // Changes panel's chip to file into the commit box. Not awaited: the turn is over, and the
                    // sentence is for a panel nobody has opened yet.
                    describeLandingInBackground(services, conversationId);
                }
                /* The delta is in the main tree, which is where a package.json change starts costing everyone:
                 * every later isolated turn overlays THIS node_modules, so a dependency that landed uninstalled
                 * is inherited by every conversation after it. Reconciled here rather than left for someone to
                 * notice — this is the moment the tree changed, and the only moment the cause is still obvious.
                 * Awaited because the receipt rides the frame below; the install itself is a detached panel job,
                 * so what is awaited is the decision, not the minutes.
                 *
                 * The verifier is handed along (onInstalled): once the installs this land made necessary have
                 * run, the tree's own checks run and their edges wake the fix chore — with THIS land as the
                 * named cause (verify-deps.ts). */
                const verifyContext: DependencyLandOrigin = {
                    kind: "land",
                    agentId: conversationId,
                    ...(finished.title !== undefined ? { title: finished.title } : {}),
                    branch,
                    repos: span,
                };
                const verifier: VerifyDeps = {
                    workspace: services.workspace,
                    processes: services.processes,
                    logger: services.logger,
                    verifyStore: services.verifyStore,
                    activity: services.activity,
                    emit: (event) => emitWorkspaceEvent(services, event, streamAgent),
                };
                const deps = landed.landed ? await services.dependencies.reconcileLand(verifyContext) : undefined;
                /* THE CLOSURE RE-CHECK: while a project's checks are red, any land that touches it re-runs
                 * them even with no dependency drift — a source-only fix can never turn the light green
                 * otherwise. Skipped when the reconcile deferred: its retry will run the checks with the
                 * installs it is still holding, and a check of the tree before them would misreport the
                 * install's absence as the code's failure. */
                if (landed.landed && deps?.deferred !== true) {
                    const red = await services.verifyStore.red().catch(() => [] as string[]);
                    queueVerify(
                        verifier,
                        verifyContext,
                        red.filter((dir) => dir === "" || span.some(({ repo }) => dir === repo || dir.startsWith(`${repo}/`))),
                    );
                }
                yield {
                    kind: "landed",
                    landed: landed.landed,
                    ...(landed.conflicts !== undefined ? { conflicts: landed.conflicts } : {}),
                    ...(landed.held === true ? { held: true } : {}),
                    ...(deps !== undefined ? { deps } : {}),
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
        /* A turn a PERSON ended — a dismissed question, their own Stop — never reached the pass above, so its
         * books are settled here instead: on the branch only, nothing into the main tree (settleLandBooks).
         * Before `finish`, which re-derives the standing this may just have moved.
         *
         * An ERRORED turn is deliberately left alone. Its worktree is mid-thought and its own failure is the
         * thing the card has to say; the next clean turn reconciles everything, and until then the card reads
         * `error` rather than any standing this could change. */
        if (!reconciled && !failed) {
            await settleLandBooks(services, conversationId);
        }
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

/* The session this turn resumes: the one it named, or none — because the runtime serving it does not have that
 * one any more. Which store answers is the adapter's (adapter.ts holdsSession); what a "no" MEANS is here, and
 * it is the same for all four: the turn opens a fresh session, seeded from the conversation's record by the
 * handoff its caller already runs for every other way a session gets retired.
 *
 * A store that cannot be read at all is trusted rather than doubted — retiring a live session over a failed
 * probe would throw away a conversation's context to answer a question that was never asked. */
const sessionToResume = async (services: Services, input: AgentTurn, effectiveCwd: string): Promise<string | undefined> => {
    const { sessionId } = input;
    if (sessionId === undefined) {
        return undefined;
    }
    const adapter = adapterFor(input.agent ?? "claude", input.harness ?? "native");
    const held = await services.perf
        .track("turn.preflight.session", {}, () => adapter.holdsSession(services, sessionId, effectiveCwd))
        .catch((error: unknown) => {
            services.logger.warn({ err: error, sessionId }, "session probe failed — resuming as asked");
            return true;
        });
    return held ? sessionId : undefined;
};

// One agent turn's body, on the main tree (`worktree` undefined) or inside an isolated conversation's
// worktree — the cwd override is the single binding point every provider adapter, the tmux Bash path, and the
// SDK session store follow.
async function* runTurn(
    services: Services,
    input: AgentTurn,
    signal: AbortSignal | undefined,
    worktree:
        | { readonly id: string; readonly cwd: string; readonly synced: readonly RepoSync[]; readonly resync: () => Promise<AgentEvent | undefined> }
        | undefined,
    steering: SteeringQueue | undefined,
    // Which conversation message this turn answers, for its end-of-turn checkpoint. Undefined on a turn with no
    // conversation behind it (the bench, a one-shot) — there is no transcript for a rewind to address.
    turn?: SnapshotTurn,
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
     * native Codex turn uses an app-server process whose adapter has not been connected to this namespace plan,
     * and an ACP turn talks to a pooled connection that outlives this turn. Building an anchor for those would
     * be worse than skipping it: `effectiveCwd`
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
    // Isolated turns skip it entirely, and this is the OTHER direction from the pre-turn rebase above
    // (agents/sync.ts), not a contradiction of it: that one moves the agent's branch onto the main line the
    // user already has, while this would pull a REMOTE into the user's checkout underneath a conversation
    // nobody asked to move — manufacturing exactly the divergence the rebase just spent a turn-start removing.
    const syncPromise =
        worktree !== undefined
            ? undefined
            : syncWorkspaceRepos(services, 60_000).catch((error: unknown) => {
                  services.logger.warn({ err: error }, "repo sync failed");
                  return [];
              });
    // Editor context attaches to THIS message, so it folds in before the (older) history preamble wraps it.
    const promptWithEditor = input.editorContext !== undefined ? `${input.prompt}\n\n${editorContextNote(input.editorContext)}` : input.prompt;
    /* WHAT THIS TURN CAN ACTUALLY CONTINUE FROM — asked of the runtime's own store before anything is built on
     * the answer, because a session id is a claim about that store rather than a fact.
     *
     * A resume names a session the runtime may no longer hold, and NOT ONLY after the sandbox was rebuilt or the
     * session deleted: a runtime reports its session id in its first frame and writes the session out seconds
     * later, so a turn stopped in its opening seconds leaves an id behind that nothing was ever saved under.
     * That was reported to the user as "this chat's history is gone (the sandbox was rebuilt or the session was
     * deleted)" — two causes, neither of which had happened — and the turn was refused, so the words they had
     * just typed went nowhere and the fix on offer was to send them again.
     *
     * Nothing about that needed the user. The conversation's own record is right here and outlives every
     * session, so a forgotten session is a HANDOFF like any other: drop the dead id and let the fresh session be
     * seeded from the record, which is what the refusal was asking the user to trigger by hand. */
    const resumed = await sessionToResume(services, input, effectiveCwd);
    /* A turn that resumes no session, on a conversation that has already said something, is a runtime handoff:
     * the switch retired the old session and this one has to carry the conversation across. Read at turn start,
     * in the window every caller guarantees — the record is open and adopted (startConversationTurn awaits that
     * before the pump invokes the provider) and this turn's own messages are not appended until it settles. */
    const history =
        resumed === undefined && input.conversationId !== undefined
            ? await handoffHistory(services, { ...input, conversationId: input.conversationId })
            : [];
    mark("history");
    const base: AgentRequest = {
        prompt: history.length > 0 ? withRuntimeHistory(promptWithEditor, history) : promptWithEditor,
        cwd: effectiveCwd,
        // Which agent the children this turn spawns belong to (agent/subagents.ts). Absent for a turn with no
        // conversation behind it, whose children are not surfaced.
        ...(input.conversationId !== undefined ? { conversationId: input.conversationId } : {}),
        ...(isolation !== undefined ? { isolation } : {}),
        signal: signal ?? new AbortController().signal,
        ...(Object.keys(cliEnv).length > 0 ? { cliEnv } : {}),
        ...(resumed !== undefined ? { sessionId: resumed } : {}),
        ...(input.model !== undefined ? { model: input.model } : {}),
        ...(input.permissionMode !== undefined ? { permissionMode: input.permissionMode } : {}),
        ...(input.allowedTools !== undefined ? { allowedTools: input.allowedTools } : {}),
        ...(input.effort !== undefined ? { effort: input.effort } : {}),
        // Rides the same path as `effort`: into the base, then through turn-plan's two gates (the runtime that
        // can ask, the route that may) rather than straight to an adapter.
        ...(input.fast !== undefined ? { fast: input.fast } : {}),
    };
    /* WHICH RUNTIME SERVES THIS TURN AND WHAT IT IS HANDED — resolved as a value (turn-plan.ts), so the four
     * providers' gates and request assembly live together instead of interleaved with the lifecycle below.
     * A refusal is one of them: an ordinary state of a sandbox (a session id that outlived its transcript, a
     * subscription nobody connected, an uninstalled Agent capability), reported as the error frame the
     * composer's connect gate reads. */
    const plan = await planTurn(services, input, {
        base,
        attachmentPaths,
        localCwd,
        effectiveCwd,
        cliEnv,
        steering,
        ...(worktree !== undefined ? { resync: worktree.resync } : {}),
    });
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
        // Through withTurnPreamble like every other note, and not by hand: that is what puts it inside the
        // strip on restore and the disclosure below, both of which key off the openings that function knows.
        // Pasted on directly, as it was, it reached the model and nothing else — invisible in the chat, and
        // redrawn as the user's own words by every reopened tab.
        request = { ...request, prompt: withTurnPreamble([advisory], request.prompt) };
    }
    /* WHAT THE USER'S MESSAGE GREW ON THE WAY TO THE MODEL, said out loud.
     *
     * Everything above this line may have prepended a note to the prompt: a rebase that moved the branch, a
     * dependency tree that is behind, workspace context retrieved for this very message, the repos just pulled.
     * They change what the agent does, and the chat used to show at most a one-line paraphrase of one of them —
     * so an agent acting on instructions the user could not read looked like an agent acting on its own.
     *
     * Emitted from the FINAL prompt rather than from the notes as they were assembled, because that is the
     * string the model actually receives; anything a later pass adds is in it by construction, and a disclosure
     * that has to be remembered separately is one someone eventually forgets to update. */
    const notes = preambleNotes(request.prompt);
    if (notes.length > 0) {
        yield { kind: "preamble", notes };
    }
    /* THE TURN'S BEFORE-STATE, recorded under this message so that going back to it — a rewind, or a fork that
     * wants the files as they were here — has something to name. Both placements record one; what differs is
     * what a "state" IS where the turn runs, which is the distinction agent/turn-anchors.ts exists to carry.
     *
     * MAIN TREE — the attribution fence: capture anything pending as user-authored (terminal edits,
     * desktop-sync arrivals, unflushed UI writes) BEFORE the agent runs, so the turn-end snapshot is purely the
     * agent's work. A no-op skip when the tree is clean; a history failure never blocks a turn. */
    if (worktree === undefined) {
        // The turn-start state's checkpoint id: the fence capture when it recorded something, else the newest
        // visible checkpoint (a clean tree at turn start IS that checkpoint's state — the common case). The
        // client hangs "go back to before this message" on the frame; no id (fresh workspace) ⇒ no offer.
        const checkpointId = await services.history
            .snapshot("user")
            .then(async (id) => id ?? (await services.history.list())[0]?.id)
            .catch((error: unknown) => {
                services.logger.warn({ err: error }, "history: turn-start snapshot failed");
                return undefined;
            });
        if (checkpointId !== undefined) {
            /* Written down as well as streamed. The frame alone reaches only the browser watching THIS turn,
             * and the affordance it powers is wanted most by the tab that comes back tomorrow — see
             * agent/turn-anchors.ts. Awaited, unlike the fence snapshot above: it is one small file write, and
             * a frame promising a state the daemon cannot resolve is worse than a turn that starts a
             * millisecond later. */
            if (turn !== undefined) {
                await services.turnAnchors
                    .record(turn.conversationId, turn.index, { kind: "tree", snapshot: checkpointId })
                    .catch((error: unknown) => services.logger.warn({ err: error }, "anchors: recording the turn's checkpoint failed"));
            }
            yield { kind: "checkpoint", id: checkpointId, ...(turn !== undefined ? { index: turn.index } : {}) };
        }
    }
    // An isolated turn takes no history capture — history covers the MAIN tree, which it never touches. Its
    // before-state is its own branch, and it is anchored by the isolated arm above, which is where the worktree
    // composition (and so the per-repo commits) is known.
    mark("snapshot");
    /* This turn's identity in the activity log, minted here because here is the first moment it exists. Every
     * event the turn writes — the four lifecycle marks below and one per sniffed outbound provider call — carries
     * it, which is what lets the audit feed render a turn as ONE row instead of five. Deliberately not sessionId:
     * the runtime does not report one until the stream's first frame, so turn.started (the event holding the
     * prompt) would be the one row nothing could ever join. */
    const turnId = randomUUID();
    // Tee every frame past the activity sniffer — outbound provider calls (discord curl) are only visible
    // here, and every turn origin (chat, automation wake, voice wake) flows through this generator.
    const sniffer = createOutboundSniffer(services, turnId);
    // Turn lifecycle into the activity log — the durable trail of every turn (start, plan artifacts, errors,
    // completion with usage) that survives rebuilds and the agent's own reach, while full content stays in
    // the SDK transcript. Fire-and-forget: logging must never delay or fail a turn.
    const provider = input.agent ?? "claude";
    // The session the turn is RUNNING on, not the one the client asked for: an id the runtime no longer holds was
    // dropped above, and stamping it on this turn's rows would file them against a session that does not exist.
    // Replaced by the stream's own `session` frame the moment a resume advances it or a fresh one is minted.
    let sessionId = resumed;
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
    /* The model's own prose this turn, in characters — the terse steer's metric, and the only one it can be
     * scored on. The provider bills one output-token total and never says how much of it was narration; a real
     * turn's output is over nine parts tool-call arguments, so the steer's whole effect lives inside a tenth of
     * the number and cannot be seen there. Counted here because `delta` is the only frame that carries prose,
     * and nothing downstream of this loop still knows which bytes were which. */
    let proseChars = 0;
    /* The turn's search work — the search teaching's metric, on exactly the same footing as `proseChars` above:
     * the mechanism changes how the turn searches, so searches are what it has to be scored on, and cost per
     * turn could never see it (UsageTurn.searchCalls says why).
     *
     * `openingSearches` stops at the first file the turn opens or changes, which is the moment orientation ended
     * and the work began. Counted here for the same reason as the prose: the frame stream is the only place that
     * still knows the ORDER things happened in. */
    let searchCalls = 0;
    let openingSearches = 0;
    let reachedTheWork = false;
    const record = (event: Omit<ActivityEvent, "id" | "at" | "provider" | "direction">): void => {
        // Read per event, never captured once: nameAgentTitle runs concurrently with this turn, so turn.started
        // often writes before a fresh conversation has a name and turn.completed writes after. The feed takes the
        // first title among a turn's events, which is why the late one is worth writing down at all.
        const title = input.conversationId === undefined ? undefined : services.agents.entry(input.conversationId)?.title;
        void services.activity
            .append({
                provider,
                direction: "system",
                turnId,
                ...(resolvedAccount !== undefined ? { account: resolvedAccount } : {}),
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
                    /* And it settles whatever this provider last REFUSED, on the account that just proved it
                     * wrong. Content on the wire is the only evidence that exists for the refusal kinds no poll
                     * can answer: an entitlement refusal survives every reading that could contradict it (the
                     * token authenticates and the pools publish all the way through it), so without this an
                     * admin re-enabling a seat would leave the alarm standing for the full week the store keeps
                     * it. Fire-and-forget on the same contract as the writes at settle. */
                    void services.providerRefusals
                        .clear(provider, resolvedAccount)
                        .catch((error: unknown) => services.logger.warn({ err: error }, "provider refusal: settle failed"));
                    // And the seat itself: an account that answers is an account that may serve turns again, so
                    // an admin re-enabling Claude Code puts it back in the rotation with no reconnect.
                    if (resolvedAccount !== undefined) {
                        void services.claudeSeats
                            .clear(resolvedAccount)
                            .catch((error: unknown) => services.logger.warn({ err: error }, "claude account: could not clear the entitlement mark"));
                    }
                }
            }
            if (event.kind === "delta") {
                // Every prose frame, subagent narration included: they run on the same steered system prompt,
                // and a turn that delegates its writing would otherwise read as a turn that wrote nothing.
                proseChars += event.text.length;
            }
            if (event.kind === "tool_call") {
                // Subagents' calls included, on the same rule as the prose above: a turn that sends an Explore
                // agent looking still went looking, and the retrieval it was handed is what it would have used.
                // `tool_call` only — an update is a later state of a call already counted.
                // A compound Bash call may both search and open a file. Count its search against the state at
                // call entry, then independently close orientation after it; making these branches exclusive
                // hid most real file reads (`cat`/`sed`/`head`/`tail`) and inflated openingSearches.
                if (isSearchCall(event)) {
                    searchCalls += 1;
                    if (!reachedTheWork && searchPrecedesFileWork(event)) {
                        openingSearches += 1;
                    }
                }
                if (isFileWorkCall(event)) {
                    reachedTheWork = true;
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
                /* THE PLAN SAID NO — file it, so the account surfaces can say when it last happened.
                 *
                 * The three codes that mean "this provider would not serve the turn", as opposed to the workspace
                 * or the request being at fault. Nothing here changes what the turn DOES about it (the branches
                 * below own that, unchanged); this is the durable trace, and it is the only one: a rate_limit
                 * frame is relayed to whoever is attached and forgotten, so a refusal that landed while nobody
                 * was watching — an automation at 4am, a fleet agent — left no mark anywhere a person could find.
                 *
                 * `kind` is read off the SENTENCE (mentionsSpentAllowance) rather than off the code, because for
                 * every provider but Claude the two disagree — see failure-sentences.ts. Two codes are read
                 * directly instead, and each is a case where the sentence has ALREADY been classified somewhere
                 * that knew more than this line does: the entitlement refusal (isEntitlementRefusalText upstream),
                 * and a rate_limit raised by an adapter that read the refusal itself (grok-agent.ts, off Google's
                 * `RESOURCE_EXHAUSTED` and the bare rate-limit wordings the shared helper deliberately leaves
                 * alone). Without that second one a spent Antigravity allowance filed as an `auth` refusal, and
                 * the account picker told the user to reconnect a credential in perfect health.
                 *
                 * Fire-and-forget, the same contract as every other turn-end write: a refusal must not be able
                 * to fail the turn it is describing. */
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
                            ...(resolvedAccount !== undefined ? { account: resolvedAccount } : {}),
                        })
                        .catch((error: unknown) => services.logger.warn({ err: error }, "provider refusal: write failed"));
                }
                /* The provider failed us, not the workspace. Open (or re-observe) its outage and tell the client
                 * where the resume stands: which attempt this is, when the next one is due, and whether it is
                 * armed or merely on offer behind the setting. Past the attempt budget nothing more will fire, so
                 * the frame goes out bare — a promise of a retry that will never come is worse than the red line
                 * it replaced. */
                if (event.code === "provider-outage" && input.conversationId !== undefined) {
                    const outage = recordProviderFailure(provider);
                    if (outage.attempt < OUTAGE_MAX_ATTEMPTS) {
                        outageHit = true;
                        // THIS conversation's posture, not the sandbox's alone — the same question the resume
                        // pass asks a few seconds later, asked through the same reader so the two can never
                        // disagree. A chat armed on its own says "scheduled" while the board around it, still
                        // on an off default, is honestly told a resume is merely "available".
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
                /* THE SEAT, NOT THE CREDENTIAL. This account signs in perfectly and its organization has Claude
                 * Code switched off, so there is nothing to re-mint and nothing to wait for — the only remedy is
                 * to stop choosing it, which is what the mark does (claude-seats.ts). The turn
                 * that discovered it still fails, with the provider's own sentence; every turn after it is
                 * routed to an account that can answer. */
                if (event.code === "claude-not-entitled" && resolvedAccount !== undefined) {
                    void services.claudeSeats
                        .refuse(resolvedAccount, event.message)
                        .catch((error: unknown) => services.logger.warn({ err: error }, "claude account: could not record the entitlement refusal"));
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
                    // Counted off this turn's own frames rather than taken from the provider, which reports one
                    // output total and no breakdown — see UsageTurn.proseChars.
                    proseChars,
                    // Likewise off the frames, and in their order — see UsageTurn.searchCalls for why the
                    // search-teaching experiment is judged on these and not on what the turn cost.
                    searchCalls,
                    openingSearches,
                    // The turn experiments' arms, when this turn was in them — the ledger is the only place they
                    // are recorded, and without them the steer's and the teaching's effects are unmeasurable
                    // after the fact.
                    ...(plan.terseArm !== undefined ? { terse: plan.terseArm } : {}),
                    ...(plan.searchArm !== undefined ? { iqSearchArm: plan.searchArm } : {}),
                    ...(plan.searchCohort !== undefined ? { iqSearchCohort: plan.searchCohort } : {}),
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
        run: i.run.handler(async ({ input }) => {
            if (input.conversationId === undefined) {
                throw new ORPCError("BAD_REQUEST", { message: "conversationId required" });
            }
            const conversationId = input.conversationId;
            // Push notifications ride the run's lifecycle, not this request's: the point is to reach a user
            // whose tab is asleep or closed, which is exactly when nobody is reading the response. Every send
            // goes through notifyIfAway, so a user watching the turn finish is told nothing. The journal entry
            // rides along too — see startConversationTurn.
            const run = await startConversationTurn(services, streamAgent, { ...input, conversationId });
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
        /* Un-park a turn waiting on an interactive card — a plan approval, question picks, or a per-tool
         * permission prompt, all keyed by the same requestId. NOT_FOUND when nothing holds that id (already
         * answered, or the turn ended), which is what tells the client to freeze the card as stale.
         *
         * A DISMISSED QUESTION ENDS THE TURN, and it ends here rather than in the browser. The rule itself is
         * old: the card was raised because the agent could not choose, so waving it away answers nothing, and
         * letting the turn run on means it guesses at exactly the fork it just said it could not guess at.
         * What changed is where it happens. The browser used to say it in two messages — release the card,
         * then stop — and between them the daemon had a live turn with nothing parked on it, which is the
         * definition of a working agent: the board pulled the card out of Attention, filed it under Active for
         * the length of a round trip, and then moved it a second time when the stop arrived. Said in one step
         * the in-between never exists, and where the card lands stops being a race between two requests.
         *
         * Marked before it is resolved, and the whole handler down to the abort is synchronous, so the tool's
         * own continuation cannot run in between and re-publish the agent as running. */
        reply: i.reply.handler(async ({ input }) => {
            const dismissed = input.kind === "question" && input.cancelled === true ? conversationOf(input.requestId) : undefined;
            if (dismissed !== undefined) {
                services.agents.stopping(dismissed, "dismissed");
            }
            if (!resolveRequest(input)) {
                throw new ORPCError("NOT_FOUND", { message: `no pending ${input.kind} for that request` });
            }
            if (dismissed === undefined) {
                return { ok: true } as const;
            }
            stopTurn(dismissed);
            // Joined like the stop route joins, and for the same reason: the answer to this request is what the
            // browser lets the user type behind, so it must not come back while the run still holds the
            // conversation. The wait is a blink — the turn is parked inside the card being dismissed.
            await turnRunOf(dismissed)?.waitUntilFinished();
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
            /* THE MESSAGE INTO THE RUN'S OWN LOG, at the point in the stream where the turn took it — which is
             * what puts it in front of every window rendering this run, in the right place, and in the record
             * the settled turn is written down from. See the `steer` frame in events.ts for what each of those
             * was doing wrong while this only existed in the sending window.
             *
             * Pushed AFTER the queue accepted it and synchronously, before this handler answers: the poster's
             * 200 therefore cannot arrive ahead of the frame, and a steer the turn refused writes nothing. */
            turnRunOf(input.conversationId)?.push({
                kind: "steer",
                text: input.text,
                sentAt: Date.now(),
                ...((input.attachments ?? []).length > 0 ? { attachments: [...(input.attachments ?? [])] } : {}),
            });
            // A steered message is something the user SAID, so the fleet filter has to find it. Recorded here
            // rather than left to the transcript because the prompt index reads a session's file once and holds
            // it (transcript-search.ts) — a mid-turn message that only ever landed in the file would be invisible to
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
            services.agents.stopping(input.conversationId, "stopped");
            // abort() is only a request. The detached pump remains the conversation's live run until its
            // generator unwinds (including worktree/registry cleanup), so acknowledging before then lets an
            // immediate next message collide with the old run and get a bogus "another window" conflict.
            // Join the run here: a successful Stop response now means the conversation lock is truly free.
            await run?.waitUntilFinished();
            return { ok: true } as const;
        }),
        /* Go back to a message — files, transcript and provider session together (see agent/rewind.ts).
         *
         * CONFLICT rather than a queue-and-wait on a running turn: rewinding is a decision about work the user
         * is looking at, and holding it until a twenty-minute turn finishes would apply it to a workspace that
         * has moved on since they asked. The same code the busy send uses, so the client already knows it. */
        rewind: i.rewind.handler(async ({ input }) => {
            const outcome = await rewindConversation(services, input.conversationId, input.index);
            if (outcome === "busy") {
                throw new ORPCError("CONFLICT", { message: "This agent is running a turn — stop it before going back." });
            }
            if (outcome === "no-checkpoint") {
                throw new ORPCError("NOT_FOUND", { message: "That message has no saved file state to go back to." });
            }
            return outcome;
        }),
        // The provider's slash commands from its most recent turn. Empty (not an error) when it has never run
        // one here — the popover simply stays closed until the first turn publishes the list.
        commands: i.commands.handler(({ input }) => ({ commands: [...commandsOf(input.agent ?? "claude")] })),
        // What each provider last refused a turn with. Empty when none has — which is the common, healthy case,
        // and reads as "nothing to say" on every surface rather than as a failed read.
        refusals: i.refusals.handler(async () => ({ refusals: await services.providerRefusals.read() })),
    };
};
