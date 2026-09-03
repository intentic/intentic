import { queueWhole } from "./agent-terminals.js";
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
    type SnapshotTurn,
    type TodoItem,
    type UsageWindow,
    type WorkspaceEvent,
} from "@intentic/sandbox-contract";
import { implement, ORPCError } from "@orpc/server";
import { createOutboundSniffer } from "../activity/outbound.js";
import { emitWorkspaceEvent } from "../automations/workspace-events.js";
import { turnCliEnv } from "../capabilities/turn-env.js";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../context.js";
import type { DependencyLandOrigin } from "../workspace/dependency-origin.js";
import { queueVerify, type VerifyDeps } from "../workspace/verify-deps.js";
import { REPO_SYNC_NOTE_TITLE, syncAdvisory, syncWorkspaceRepos } from "../workspace/sync-repos.js";
import { resolveWithin } from "../workspace/workspace-files.js";
import { startAnchor, type TurnPlacement } from "../agents/isolation.js";
import { holdAccount } from "../claude/claude-credentials.js";
import { isIsolated } from "../agents/agents-store.js";
import { anchorWorktree, forkWorktreeBase } from "./anchor-worktree.js";
import { anchorSteeredMessage } from "./steer-anchors.js";
import { landAgent } from "../agents/land.js";
import { describeLandingInBackground } from "../agents/landed-subject.js";
import { landingPaths } from "../agents/landing-paths.js";
import { landingVerdict, standing } from "../rules/rules.js";
import { landingOutcome, takeCheckVerdict } from "./turn-checks.js";
import { type RepoSync, syncConversation } from "../agents/sync.js";
import { recordConversationPrompt, recordPrompt } from "../sessions/transcript-search.js";
import { handoffHistory, turnStartIndex } from "../sessions/turn-transcript.js";
import { type ChildSupervisor, childSupervisor, isSpawnedChild } from "../children/children.js";
import type { AgentRequest } from "./agent.js";
import { adapterFor } from "./adapter-registry.js";
import { composeWirePrompt } from "./turn-preamble.js";
import { rewindConversation } from "./rewind.js";
import { commandsOf } from "./agent-commands.js";
import { limitReopensAt } from "./limit-reset.js";
import { createFrameLedger } from "./agent-verification.js";
import { createViewFrameLedger } from "./agent-viewing.js";
import { nudgeUnverifiedWork } from "./verify-nudge.js";
import { isFileWorkCall, isSearchCall, searchPrecedesFileWork } from "./tool-calls.js";
import { mentionsSpentAllowance } from "./failure-sentences.js";
import { conversationOf } from "./agent-requests.js";
import { registerTurn, SteeringQueue, steerTurn, stopTurn } from "./agent-steering.js";
import { OUTAGE_MAX_ATTEMPTS, recordProviderFailure, recordProviderSuccess } from "./provider-health.js";
import {
    authResumable,
    clearPendingResume,
    fireLimitResume,
    limitResumeArmed,
    outageResumeArmed,
    recordAuthFailure,
    recordLimitFailure,
    recordOutageFailure,
    startConversationTurn,
} from "./turn-resume.js";
import { dispatchRemoteTurn } from "../runners/runner-dispatch.js";
import { forgetRemoteRequest, remoteRequestOf } from "../runners/runner-requests.js";
import { applyReply, composeSteerText } from "./turn-interactions.js";
import { withRuntimeHistory } from "./runtime-history.js";
import { turnRunOf } from "./turn-runs.js";
import { nameAgentTitle } from "./title-namer.js";
import { planTurn } from "./turn-plan.js";
import { turnTier } from "./turn-tier.js";
import { sumUsage, type UsageFrame } from "./turn-usage.js";

// Fold the opt-in editor context (the composer chip, off by default) into the prompt: the file the user is
// looking at and, when they selected text, the lines themselves, so deictic prompts ("fix this") ground
// without an @-mention. Four-backtick fence so a selection containing ``` doesn't break out.
const editorContextNote = (context: EditorContext): string => {
    if (context.selection === undefined) {
        return `The user has \`${context.file}\` open in the editor: "this file" likely refers to it.`;
    }
    const range = context.startLine !== undefined && context.endLine !== undefined ? ` (lines ${context.startLine}-${context.endLine})` : "";
    return `The user has \`${context.file}\` open in the editor with this text selected${range}: "this" likely refers to it:\n\`\`\`\`\n${context.selection}\n\`\`\`\``;
};

/* Frames that could only exist because a model request SUCCEEDED: the provider's own words, its thinking, or a
 * tool it decided to call. Any one of them clears a standing outage for every conversation stranded on that
 * provider (provider-health.ts).
 *
 * Both exclusions matter, and each is a way this list could quietly stop working.
 *
 * The frames the harness mints LOCALLY, `init`, `mode`, `commands`, `session`, prove only that the CLI started.
 * A CLI that boots perfectly and then cannot reach the API emits exactly those and nothing else, so counting them
 * would clear the breaker on the strength of a turn that never got an answer, and release the whole stranded fleet
 * into an outage that is still running.
 *
 * The end-of-turn ACCOUNTING frames, `usage`, `account_usage`, `rate_limit_info`, are the subtler trap: a turn
 * killed by a 500 still reports what its failed attempt cost, and those frames arrive AFTER the error. Counting
 * them would mean every outage failure immediately un-did itself. */
const ANSWERED_FRAMES = new Set<AgentEvent["kind"]>(["delta", "thinking", "tool_call"]);

/* THE FRAMES THAT PUT SOMETHING IN FRONT OF THE USER, which is a different question from the one above and the
 * one `silentEnding` turns on. `ANSWERED_FRAMES` asks whether the provider is alive; this asks whether the turn
 * left the conversation anywhere to go.
 *
 * Every card a turn can park on is here, because a turn holding one has addressed the user as squarely as prose
 * does: it asked them something. Prose itself is NOT in the list and is counted separately (`proseChars`, which
 * the turn loop already keeps), so an adapter emitting an empty `delta` cannot pass for an answer.
 *
 * A TOOL CALL IS DELIBERATELY ABSENT, and that absence is the whole point. Fifty-nine reads and greps prove the
 * model was working; not one of them says anything to the person who asked. */
const ADDRESSED_FRAMES: readonly AgentEvent["kind"][] = [
    "plan",
    "question",
    "permission",
    "service_offer",
    "capability_offer",
    "payment_offer",
    "browser_help",
    "terminal_help",
];

// What the turn loop has to remember to answer the question below. Every field is something it already knew;
// they are gathered into one argument so the reading stays out of `runTurn`, which is complex enough that the
// agent lint ratchets on it.
interface TurnSilence {
    readonly conversationId: string | undefined;
    readonly signal: AbortSignal | undefined;
    readonly failed: boolean;
    // Whether the provider spoke at all this turn, the loop's own `providerAnswered`. It is the difference
    // between a turn that worked and told nobody and a turn that never got started, and only the first is this.
    readonly answered: boolean;
    // Every frame kind this turn emitted. A set rather than a flag per condition: the loop adds one entry per
    // frame with no branch of its own, and what counts as addressing the user is then decided in one place.
    readonly kinds: ReadonlySet<AgentEvent["kind"]>;
    readonly proseChars: number;
    readonly filesEdited: number;
    readonly toolCalls: number;
}

// Did this turn put anything in front of the person who asked: prose, or a card it parked on. See
// ADDRESSED_FRAMES for what is on the list and what is deliberately not.
const addressedUser = (turn: TurnSilence): boolean => turn.proseChars > 0 || ADDRESSED_FRAMES.some((kind) => turn.kinds.has(kind));

/* A TURN THAT ENDED WITH NOTHING TO SHOW FOR ITSELF, in the sentence to say about it, because from every surface
 * downstream of this line such a turn is indistinguishable from one that finished.
 *
 * That is not a hypothetical. A Gemini turn on the OpenCode runtime made 59 tool calls, changed no file, wrote
 * not one word, and was ended by an ordinary `session.idle`: no error frame, so the daemon recorded
 * `outcome: "ok"`, the registry wrote the resting `idle`, and the card settled into the board's Finished lane
 * with an empty assistant bubble behind it. Nothing anywhere said the turn had stopped rather than finished, and
 * the one person who could tell the difference was looking at the lane that means "nothing to do here".
 *
 * A TURN THAT EDITED SOMETHING IS NOT THIS, however quiet it went, and the exclusion is the whole reason this
 * reads `filesEdited` at all. That turn left a diff, a diffstat on its card and a standing to land, so there is
 * something to come back to; and it is a shape this daemon already has an honest answer for, `outcome: "ok"`
 * with `verification: "unproven"` and its own checklist left open (see the ledger's `ending` below). Calling it
 * a failure as well would overwrite a considered answer with a blunter one.
 *
 * NOR IS A TURN THE PROVIDER NEVER ANSWERED, and that exclusion is the same one the ledger already makes one
 * screen down: "it said nothing" is arithmetic when the model never read a word, not a fact about behaviour.
 * Such a turn was refused, or gated, or served by something that produced no frames at all, and every one of
 * those is reported by whatever refused it rather than by this.
 *
 * THREE OTHER ENDINGS ARE ALSO NOT THIS, each already reported somewhere better. A turn the user STOPPED is
 * silent by their own decision, and its dismissed-question twin ends the same way (both abort, which is what the
 * signal reads). A turn that already FAILED has its own sentence, and a second one after it would bury the
 * first. And a turn with no conversation behind it is an internal one-shot: no card, no lane, nobody to address.
 *
 * The sentence says the session is intact because that is the whole recovery: the client draws an uncoded
 * failure with a Continue press, and the press resumes the very session this turn stopped in. */
const silentEnding = (turn: TurnSilence): string | undefined => {
    if (turn.conversationId === undefined || turn.signal?.aborted === true || turn.failed || !turn.answered) {
        return undefined;
    }
    if (turn.filesEdited > 0 || addressedUser(turn)) {
        return undefined;
    }
    // The two halves of "it worked and told nobody", which send a reader to two different places: a turn with
    // tool calls behind it got somewhere, and one with none never got past its own first thought.
    const did =
        turn.toolCalls === 0
            ? "the model started and then stopped"
            : `${turn.toolCalls} tool call${turn.toolCalls === 1 ? "" : "s"} and then a stop`;
    return `The turn ended with nothing to show for it: ${did}, no reply and no change to a file. Nothing failed: the session is intact, so carrying on continues from where it stopped.`;
};

/* WILL THIS TURN ACTUALLY ENTER A NAMESPACE, in one place because three callers ask it and a fourth answer
 * would be a way for them to disagree: the checkout's mirror form (agents/worktrees.ts linkMirrors, reached
 * through `ensure`) and the anchor itself have to be ONE decision, or a turn is handed an empty mount point
 * nothing will ever fill and resolves no import in its own tree.
 *
 * A property of the RUNTIME rather than of the container: only the Claude Code loop enters the namespace
 * (AgentCapabilities.isolation "namespace"), while a native Codex, ACP or Pi turn is cwd'd into its worktree
 * and reaches it by working directory alone. The defaults are the ones the turn resolves for itself. */
const entersNamespace = (input: AgentTurn): boolean =>
    capabilitiesOf(input.agent ?? "claude", input.harness ?? "native").isolation === "namespace";

/* …and where the frame for it goes: injected ahead of `done`, so it runs the same path a provider's own failure
 * does, the activity record, the daemon log line, the ledger's outcome, the registry's `errored`, and with it
 * the Attention lane. A second way of ending a turn badly is a second thing for each of those readers to learn,
 * and none of them has to learn it.
 *
 * `silent` is a callback rather than a value because the state it reads is only final when the stream is. */
async function* withSilentEnding(frames: AsyncIterable<AgentEvent>, silent: () => string | undefined): AsyncGenerator<AgentEvent> {
    for await (const event of frames) {
        if (event.kind === "done") {
            const message = silent();
            if (message !== undefined) {
                /* UNCODED ON PURPOSE, which is the difference between a red dead end and a way on. An uncoded
                 * failure is the one shape the chat answers with a Continue press (client turnFailures.ts:
                 * "nothing is broken that the user could go and fix, the session is intact, and the only thing
                 * between the work and its finish is somebody saying carry on"). That is exactly this condition,
                 * so giving it a code of its own would take away the press it most deserves. */
                yield { kind: "error", message };
            }
        }
        yield event;
    }
}

// Run one agent turn, streaming typed AgentEvents. `input.agent` picks the provider adapter (absent =
// claude); each provider's token is the sandbox's own credential, never held by the platform, with the
// container env as fallback. A turn with no stored account and no env fallback surfaces an actionable error
// rather than an opaque CLI failure.
// Exported because it IS "wake the agent", the automations scheduler drives the same composition headlessly.
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
        // capabilitiesOf, which is NOT the same as the harness the client sent). A native codex/grok or an ACP
        // turn registers abort alone, steering it reports NOT_FOUND and the client falls back.
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

/* THE BOOKS, SETTLED ON A TURN NOBODY LET FINISH, everything the end-of-turn pass does EXCEPT touch the main
 * tree.
 *
 * A dismissed question ends its turn by aborting it (the reply handler below), as does the user's own Stop, and
 * an aborted turn skipped that pass outright. Skipping the LAND is the point and stays, half-finished work does
 * not belong in someone's workspace. But landing is not all that pass does: it is also the only moment a
 * conversation's bookkeeping is reconciled with the world. The worktree's remainder is preserved on the branch,
 * the card's diffstat is refreshed, and a span the main tree has since taken by another road, the user
 * committed what was landed, an agent put its work on the main line itself, is finally marked accounted-for.
 *
 * Unrun, that reconciliation has no other moment: it waits for the next turn, and a conversation the user has
 * finished with never has one. A card sat in Finished offering to land work the workspace already held, and the
 * one press that would have cleared it was the one press that could not be explained. So the pass still runs,
 * in `measure`, the mode that means settle the books, the main tree is not yours to touch. Waving a question
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

/* THIS TURN'S BEFORE-STATE, in the currency an isolated conversation has: its own branch. Pinned, filed under
 * the message, and SAID OUT LOUD, which is the part that has to happen in one place for the two isolated arms
 * (local worktree, runner mirror) to behave the same.
 *
 * Both halves matter and they reach different readers. The record is what a tab coming back tomorrow reads,
 * through the anchor stamp on a restored transcript (sessions/agent-transcript.ts). The FRAME is what the tab
 * watching this turn reads: the client hangs "go back to before this message" on it, so without it an isolated
 * conversation offered the pencil, the rewind and the files-as-they-were fork on every turn it had reloaded and
 * on none it had just watched — the affordance appearing at random rather than by any rule.
 *
 * `worktree:index` is not a second naming of anything: it is exactly the id agent-transcript.ts synthesises for
 * this anchor, so the live frame and the reopened tab put the same string on the same message. The client never
 * opens it — it reads it as "there is a state here" and hands the index back — which is why a placement's
 * commits need no wire representation of their own, and why a client cannot address a commit the daemon did not
 * choose.
 *
 * Best-effort throughout: a repo that will not commit costs its own anchor (anchorWorktree), and nothing here
 * costs the turn. Nothing pinned ⇒ nothing claimed, no frame. */
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
        // A runner needs a conversation: its branch is the unit that moves between machines, and a
        // conversationless one-shot has no branch to move. Refused as a frame, never silently run here.
        if (input.placement?.kind === "runner") {
            yield { kind: "error", message: "Running on a runner needs a conversation id — the conversation's branch is what travels." };
            yield { kind: "done" };
            return;
        }
        yield* runTurn(services, input, signal, undefined, steering);
        return;
    }
    const conversationId = input.conversationId;
    // Placement is a property of the conversation, not of whichever client happens to send this turn. A fresh
    // conversation takes the request's choice; every later turn follows the registry entry it already owns.
    const existing = services.agents.entry(conversationId);
    /* THE PERSONA NO LONGER GETS A WORD ON PLACEMENT, and taking it away cost nothing: the card's field could
     * say "own copy", which every caller here already asks for, or "the shared workspace", which was the one
     * way a session could opt OUT of the worktree that lets several of them run at once. The scheduler, the
     * workflow runner, CI, extension updates and a fresh chat all send `isolated: true` of their own accord, so
     * what the field actually bought was a way to make a persona quietly less safe than the surface that ran it.
     *
     * So placement is the conversation's, decided once: the request's own choice on the first turn, and the
     * registry entry it already owns on every turn after. That entry is read before the turn is planned because
     * the worktree has to exist before there is a cwd to plan against. */
    /* WHERE it executes latches by the same rule (docs/remote-runners-plan.md at the workspace root): the
     * first turn's request chooses the runner, every later turn follows the entry, and a remote conversation
     * is isolated by construction — its branch is what moves between machines. A FRESH conversation naming a
     * runner this sandbox never enrolled is refused before begin() could latch the typo forever. */
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
            /* A fork names its source on its first turn and only then, `forkOf` rides exactly one request, and
             * the entry keeps what it said. `keep` counts the source's record rows above the cut, which IS the
             * index of the message the cut sat above, so the source can put its own mark back in that gap. */
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
    /* The entry now exists, wearing the cut sentence deriveTitle made of this prompt, so write it a real name
     * WHILE the turn runs rather than after it. Fire-and-forget in both senses: a title is never worth failing
     * a turn over, and nothing downstream waits on it (the rename broadcasts on its own, like every other
     * card-visible change). The gate inside skips a conversation already carrying a better-than-derived name,
     * which is what keeps this to one model call per conversation rather than one per turn.
     *
     * Placed ABOVE the isolated/workspace fork on purpose: naming is a property of a conversation, and the
     * version of this that lived at the end of the isolated branch's land step left every workspace
     * conversation on the derived cut forever. */
    // WARN, not debug: this pass is invisible by construction, nobody waits on it and its only output is a
    // rename that silently doesn't happen. At debug it sat below the daemon's own level and failed unnoticed
    // for every conversation the sandbox ever ran, which is how a rate-limited quick model went undiagnosed
    // while 240 fleet cards wore the derivation's cut sentence.
    nameAgentTitle(services, conversationId, input.prompt).catch((error: unknown) =>
        services.logger.warn({ err: error }, "agents: title naming failed"),
    );
    /* Where this turn sits in its conversation, read ONCE here, above the isolated/workspace fork, because
     * both arms end in a turn checkpoint and both must file it under the same index. Awaited rather than
     * fire-and-forget: it is one read of an already-open record, and a checkpoint that arrives without its
     * binding is a message the user cannot rewind to. */
    const turn: SnapshotTurn = { conversationId, index: await turnStartIndex(services, { ...input, conversationId }) };
    /* THE REMOTE ARM (runners/runner-dispatch.ts). The parent's stations only: the worktree here is a MIRROR
     * — ensured so diff, standing and land read the conversation exactly as a local isolated one, never
     * REBASED here, because that runs on the runner, whose CPU the placement bought. The finally settles the
     * books in `measure` (the same pass an ended local turn takes), which is what turns the pushed branch into
     * the card's diffstat and its "Ready to land" standing.
     *
     * ANCHORED here though, and that one is not the runner's to keep. The runner records anchors in its own
     * store; `/agent/rewind` reads THIS daemon's, so a conversation placed on a runner had every way back to
     * every one of its messages silently withdrawn — no pencil, no rewind, no fork on the old files — for no
     * reason a user could see, since nothing else about a remote card reads differently from a local one.
     *
     * The mirror is the right thing to anchor, not a stand-in for the runner's checkout: the turn opens with a
     * sync PULL, the runner bringing its copy up to this branch, so the mirror at this moment IS the state the
     * turn starts from, and a rewind that resets the mirror is picked up by the next turn's pull. */
    if (runnerId !== undefined) {
        let remoteFailed = false;
        try {
            const entry = services.agents.entry(conversationId);
            const worktree = await services.agentWorktrees.ensure(conversationId, entry?.repos ?? [], input.worktreeBase, entersNamespace(input));
            if ((entry?.repos.length ?? 0) === 0) {
                await services.agents.recordWorktree(conversationId, worktree.repos);
            }
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
        // Referenced so the two arms report symmetrically if a chore emit is added here later; today the
        // error frame the user saw is the record.
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
    // What THIS turn's land did, for the `turn.settled` chore event below, a historical record of one turn,
    // which is the one thing a verdict is still good for. The CARD's state is no longer read from it: where the
    // work stands is derived per roster from the branch and the main tree (agents/standing.ts).
    let outcome: "landed" | "conflict" | "ready" | undefined;
    // Hoisted out of the try because the chore emit in the finally reads them: the span this turn's workspace
    // event names, the branch it ran on, and whether it ended on an error frame.
    let span: WorkspaceEvent["repos"] = [];
    let branch = "";
    let failed = false;
    // Whether the end-of-turn pass below actually ran. The finally settles the books itself when it did not,
    // which is every turn a person ended early (see settleLandBooks).
    let reconciled = false;
    try {
        // Lazily create (first turn) or repair the conversation's worktree composition, then announce it.
        const entry = services.agents.entry(conversationId);
        /* A FORK THAT ASKED FOR THE FILES AS THEY WERE starts its checkout at the source's own commits for that
         * message, so the two lines of work are genuinely comparable, without this, "try it another way from
         * here" would begin at whatever the workspace had become by the time it was asked, and the comparison
         * it exists for would be against the wrong thing. Undefined wherever that cannot be honoured (see
         * forkWorktreeBase), which falls through to today's files rather than refusing to start.
         *
         * A workflow's own pinned base still wins: it pins every candidate to ONE snapshot on purpose, and a
         * fork inside one must not quietly step off it. */
        const worktreeBase = input.worktreeBase ?? (await forkWorktreeBase(services.turnAnchors, input.forkOf));
        const worktree = await services.agentWorktrees.ensure(conversationId, entry?.repos ?? [], worktreeBase, entersNamespace(input));
        if ((entry?.repos.length ?? 0) === 0) {
            await services.agents.recordWorktree(conversationId, worktree.repos);
        }
        /* Then put the branch on TODAY's main line, before the model reads a line of it (agents/sync.ts). A
         * conversation parked on a question can sit for hours while the user commits around it, and everything
         * downstream of here, what the agent reads, what it edits, what the auto-land tries to apply, is
         * measured against a base that went stale in the meantime. Empty on the ordinary turn whose branch is
         * already up to date, which is one `merge-base` per repo to establish.
         *
         * A CLOSURE rather than a straight call, because the turn's start is not the only moment the ground
         * moves: a turn that parks on a question or a plan approval waits MINUTES for a person (measured
         * median 2.6, p90 9.4), and the main line moves during one park in five. So the same pass runs again
         * each time a card settles, the harness calls it back through `resync` (agent.ts), and every record
         * that names a base is advanced here, whichever moment took the rebase. */
        const onto = new Map<string, string>();
        // Tracked because it sits on the critical path and its two costs differ by orders of magnitude: one
        // `merge-base` per repo when the branch is current, a whole checkout replay when it is not. runTurn's
        // own preflight marks start after this, so an unmeasured rebase would read as a turn that was simply
        // slow to begin, the exact attribution failure those marks exist to prevent.
        const syncOnto = async (): Promise<RepoSync[]> => {
            // Workflow steps deliberately stay on the run's immutable snapshot. Rebasing candidates here would
            // reintroduce the timing race the snapshot removed: whichever fan-out arm opened last would compare
            // against a newer workspace, and a resumed iteration could change ground halfway through its step.
            if (input.worktreeBase !== undefined) {
                return [];
            }
            /* Read fresh on every call, not captured once: this closure runs again at each card settle, and a
             * land in between is exactly what moves `landedTip`. The composition comes from the worktree record
             * (which repos this conversation spans) and the rung from the registry (how far each one's work has
             * reached the main tree), because the sync drops a delivered prefix rather than replaying it into a
             * conflict, and the worktree record does not carry that sha. */
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
            // `base` is where the branch sits on the main line, so a rebase moves it, and a stale one is not
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
            // just moved restart their span there, the same rung the turn-start capture lands on. Empty on
            // that first call, where the span does not exist yet and the map below reads `onto` directly.
            span = span.map((repo) => ({ repo: repo.repo, from: onto.get(repo.repo) ?? repo.from, dir: repo.dir }));
            return synced;
        };
        // Reported per turn, not once at boot: the capability is a property of how the container was launched,
        // and the only reason anyone noticed it was missing was work turning up in the main tree.
        const enforced = await services.turnIsolation.available();
        /* WHERE THIS TURN IS STANDING, the frame at the top of the turn, and again whenever a sync moves the
         * branch out from under a parked card. `base` is read through `onto` rather than from the composition
         * record, so it names where the branch sits NOW: a rebase is precisely the event that makes the
         * frozen checkout-moment sha the wrong answer, and both emissions have to mean the same thing for the
         * second one to be readable at all.
         *
         * The sync half is the human's (the agent's is a note): present only when the branch was BEHIND, it
         * rides the frame that already announces the standing, so the transcript says why the ground moved at
         * exactly the point it moved, a passive line, never a prompt. */
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
        // Where each repo stood BEFORE this turn, the open span a chore diffs from. Captured up front because
        // the auto-land below advances landedTip; read afterwards, every repo would report as unchanged. A repo
        // the sync moved reads from the main-line sha it moved ONTO instead of its landedTip: the rebase
        // orphaned that sha, and diffing from it would hand the chore this agent's work plus every main-line
        // commit underneath it. Everything at or before `onto` is in main by definition, so it is the honest
        // start, the same rung anchorOf lands on for a rewritten branch, and the rung a mid-turn sync moves
        // this span back to (syncOnto).
        span = worktree.repos.map(({ repo, base }) => ({
            repo,
            from: onto.get(repo) ?? entry?.repos.find((recorded) => recorded.repo === repo)?.landedTip ?? base,
            dir: services.agentWorktrees.worktreeDir(conversationId, repo),
        }));
        yield worktreeFrame(synced);
        /* THIS TURN'S BEFORE-STATE, in the currency an isolated conversation has: its own branch. The main
         * tree's fence capture (runTurn, below) is not available here, history covers /work, which this turn
         * never touches, so the equivalent is to commit whatever is sitting in the checkout and remember the
         * commit per repo. On the ordinary clean checkout it writes nothing and simply reads HEAD.
         *
         * Recorded AFTER the rebase above, deliberately: what the agent is about to read is the rebased branch,
         * so that is the state "before this message" means. An anchor taken before it would send a fork back to
         * a main line the source never worked against.
         *
         * This is what makes an agent's own history reachable at all. Until it existed, an isolated
         * conversation had no per-message state anywhere: rewind had nothing to offer, and a fork could only
         * start from wherever the checkout happened to have got to by the time somebody asked, which is not
         * the point the user pointed at. Pinned, filed and ANNOUNCED by anchorIsolatedTurn, which the runner
         * arm above shares: the two isolated placements have to offer the same ways back, or which turns wear a
         * pencil comes down to where the work happened to run. */
        yield* anchorIsolatedTurn(services, conversationId, worktree.repos, turn);
        /* The rebase the harness takes back whenever a card settles (agent.ts). It answers with the frame the
         * transcript needs, and with undefined on the ordinary answer, where the branch was already on today's
         * main line and there is nothing to report. The MODEL is told nothing either way, see turn-preamble.ts
         * on why the note this used to carry is gone.
         *
         * Only the moments where the model re-derives what to do next get this: a question's picks and an
         * approved plan. NOT a permission card, whose tool call was already computed against the tree as it
         * was, moving the file under an approved Edit is how a "yes" turns into a failure the user authored. */
        const resync = async (): Promise<AgentEvent | undefined> => {
            // A rebase must never cost the user their answer. At turn start a failing sync IS a failing turn,
            // nothing has happened yet and the fault is worth surfacing, but here the person has already
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
        // Relay the turn while watching for error frames, a failed turn must not auto-land half-done work.
        for await (const event of runTurn(services, input, signal, { id: conversationId, cwd: worktree.cwd, synced, resync }, steering, turn)) {
            services.agents.observe(conversationId, event);
            if (event.kind === "error") {
                failed = true;
            }
            yield event;
        }
        // Auto-land at clean turn completion, the Claude Code review model: the delta arrives in the main
        // tree as UNCOMMITTED changes and the user's ordinary Changes-panel commit is the review. Aborted or
        // errored turns accumulate in the worktree; the next clean turn lands the cumulative delta. With
        // auto-land OFF (the sandbox setting, or this agent's own override) the same pass runs in `measure`
        // mode instead: provenance and diffstat happen, the main tree is not touched, and the held delta
        // waits on the branch as a "Ready to land" card until the user lands it deliberately.
        // The turn's own check, taken whether or not anything lands: a verdict left behind would speak about
        // the next turn's work (turn-checks.ts).
        const check = takeCheckVerdict(conversationId);
        const finished = services.agents.entry(conversationId);
        if (!failed && signal?.aborted !== true && finished !== undefined && isIsolated(finished)) {
            /* THE `agent.finished` MOMENT, does this work reach the tree by itself? A verdict rather than
             * something that runs, because nothing extra happens here: the pass below runs either way and the
             * rule only picks which way it goes. `measure` is the held form, provenance and diffstat happen,
             * the main tree is untouched, and the delta waits on the branch as a "Ready to land" card.
             *
             * The per-agent override (this turn's, then the card's) still wins over the table: an owner who
             * pressed hold on one card meant that card. With neither, and no rule matching, work is HELD,
             * which is the recoverable mistake, and the default a sandbox with an empty table has. */
            const { rules } = await services.sandboxSettings.get();
            /* The changed paths cost a git pass per repo, so they are read ONLY when a rule here actually
             * narrows by path. The common shapes, an empty table, or "land everything", never pay for it. */
            const finishedRules = standing(rules, "agent.finished");
            const paths = finishedRules.some((rule) => (rule.when?.paths?.length ?? 0) > 0)
                ? await landingPaths(services, finished, span)
                : undefined;
            const decided = landingVerdict(
                rules,
                { repos: span.map(({ repo }) => repo), paths, outcome: landingOutcome(check) },
                input.autoLand ?? finished.autoLand,
            );
            /* ONE LAST REBASE, because the sync at the top of this turn is already stale by the time we get
             * here. The branch was put on today's main line before the model read a line of it, and then the
             * turn RAN: two hundred tool calls and half an hour, during which the user lands other agents and
             * commits them. The land below is a patch applied against main's working tree, so every main-line
             * commit that arrived inside that window is a chance for `git apply --check` to refuse over work
             * this agent never touched. That refusal costs the conflict errand, the user's click, and a whole
             * model turn re-resolving a merge the daemon could have avoided for the price of a merge-base.
             *
             * The window is widest exactly where it hurts most, a fleet landing in parallel, which is what
             * left the merge-conflict errand firing several times a day on a sandbox that already rebases
             * before every turn.
             *
             * Best-effort, like the settle-time resync above and NOT like the one at turn start: the work is
             * finished and sitting on the branch, so a git fault here must cost the rebase and never the land.
             * A sync that cannot move the branch leaves it exactly where it was, and the land-time conflict
             * flow behind this is untouched. `syncOnto` carries its own no-op guard for workflow steps, and
             * re-points `span` for any repo it moves, which the chore below diffs from. */
            try {
                await syncOnto();
            } catch (error) {
                services.logger.warn({ err: error, id: conversationId }, "agents: pre-land sync failed, landing on the old base");
            }
            // Re-read after the sync: `syncOnto` persists the new base per repo it moved, and landing from the
            // frozen pre-sync composition would hand anchorOf a base the rebase has just orphaned.
            const resynced = services.agents.entry(conversationId);
            const landing = resynced !== undefined && isIsolated(resynced) ? resynced : finished;
            const landed = await landAgent(services.agentWorktrees, landing, decided.land ? "check" : "measure");
            reconciled = true;
            /* A rule that decided a card's fate did something, and the settings list says so. The per-agent
             * override reports no rule, because in that case none decided.
             *
             * Only a HOLD reaches the feed. Landing is self-evident, the work is in the tree, while work that
             * did not arrive is the thing someone goes looking for an explanation of, and "a rule you wrote
             * held it" is that explanation. An empty table holds too, and says nothing: nobody wrote that, so
             * there is no rule to name and nothing was decided that the card does not already show. */
            /* HELD BY THE TURN'S OWN CHECK: the one hold no rule decided, and the one a person most needs
             * explained, since the work is finished, the model said so, and it is not in the tree. Named with the
             * check that failed and what it ran, so the card's "Ready to land" reads as a verdict, not a stall. */
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
                // Nothing NEW to land, but the agent's cumulative output exists and is all accounted for in
                // the main tree, a follow-up turn that only answered a question must not downgrade the card
                // from Landed to Idle. No frame and no chore: nothing moved. (Reachable under measure too,
                // held work the user already landed by hand, and means the same thing there.)
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
                 * notice, this is the moment the tree changed, and the only moment the cause is still obvious.
                 * Awaited because the receipt rides the frame below; the install itself is a detached panel job,
                 * so what is awaited is the decision, not the minutes.
                 *
                 * The verifier is handed along (onInstalled): once the installs this land made necessary have
                 * run, the tree's own checks run and their edges wake the fix chore, with THIS land as the
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
                    queue: queueWhole(services.heavyCommands.read),
                };
                const deps = landed.landed ? await services.dependencies.reconcileLand(verifyContext) : undefined;
                /* THE WHOLE REPOSITORY, AFTER EVERY LAND, on the main tree, off every model's clock. This is the
                 * one moment that legitimately needs the whole suite against a tree nobody else is moving: the
                 * turn's own check measured its diff against the affected closure (verify-turn.mjs), and what it
                 * could not answer for, another package's fixture naming a shape this turn just changed, main
                 * having moved under it, a turn on a runtime with no Stop hook at all, is answered here, once,
                 * serialized through the heavy-command pool (verify-deps.ts). A red verdict is an edge the fix
                 * chore wakes on with THIS land as the named cause; a green one is recorded against the tree so
                 * the push gate that follows replays it and runs only the build (_tools/scripts/verify.mjs).
                 *
                 * Every landed repo that carries a check, not only the ones already red: the closure re-check
                 * this replaces ran only while a project's light was red, which is exactly the arrangement under
                 * which the light goes red an hour late, at the push, or at CI. Skipped when the reconcile
                 * deferred: its retry will run the checks with the installs it is still holding, and a check of
                 * the tree before them would misreport the install's absence as the code's failure. */
                if (landed.landed && deps?.deferred !== true) {
                    queueVerify(
                        verifier,
                        verifyContext,
                        span.map(({ repo }) => (repo === "root" ? "" : repo)),
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
                    // The main tree just changed, give the History timeline its turn checkpoint, labeled with
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
        /* A turn a PERSON ended, a dismissed question, their own Stop, never reached the pass above, so its
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
        // Once per turn, whatever the outcome, the errored and conflicted ones are the ones most worth a
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

/* How much of a failure's own sentence the spend ledger keeps (UsageTurn.errorMessage).
 *
 * Enough to hold any real provider refusal whole; short enough that a run of failures cannot turn a
 * never-pruned file into something too big to read in one pass, which is the one property that makes this
 * ledger worth having over the activity log. */
const ERROR_MESSAGE_CHARS = 400;

// How much of the check that spoke the ledger keeps (UsageTurn.check). A command is a line, not a script: long
// enough for `pnpm -C _sandbox/sandbox test src/agent/x.test.ts`, which is the shape these actually take.
const VERIFICATION_CHECK_CHARS = 200;

/* The four codes that already own a durable trace of their own, and the reason a failed turn is not
 * automatically an `error` line.
 *
 * A spent allowance, a provider outage, a refused token and a disabled seat are all operational facts about
 * somewhere else. Each is filed where the surfaces that care actually read it (provider-refusals.json, the
 * outage breaker, the auth-resume record, claude-seats.ts), each is expected to happen, and logging them at
 * `error` would restore exactly the problem the level exists to solve: 5,465 warnings in one log file, of which
 * 4,700 were routine, and six real errors nobody could find among them.
 *
 * Anything NOT in this set is an unclassified turn failure, which is the case nothing downstream knows how to
 * handle and the one worth waking up for. */
const HANDLED_FAILURE_CODES: ReadonlySet<string> = new Set(["rate_limit", "provider-outage", "claude-token-refused", "claude-not-entitled"]);

// How fresh a routed provider's readings must be before a settled turn re-reads them. Ten seconds: a fleet of
// parallel routed turns settling together costs one sweep, and a lone turn's ring is current by the time the
// user looks at it.
const SETTLE_MAX_AGE_MS = 10_000;

/* File a turn's own plan-limit reading (the `account_usage` frame) under the account it describes. A native
 * Claude turn names its account. A native Codex turn names the subscription marker ("codex-subscription"),
 * which is nobody: the app-server pushed the plan's rate limits for whichever auth file CLIProxyAPI served the
 * turn on, so the reading is filed under that provider's ONE file when it has one, and the provider's files
 * are re-read precisely when it has several. An env-token turn names nothing and files nothing. */
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

/* A SPENT-ALLOWANCE FRAME, DRESSED WITH EVERYTHING THE CLIENT CANNOT WORK OUT FOR ITSELF: when the window
 * reopens, whether the turn is held whole for a re-run, and whether a clock is going to perform that re-run
 * without anybody pressing anything.
 *
 * `autoResume` needs BOTH halves to be true, a held turn to run and an instant to run it at, and stays absent
 * otherwise: a frame saying "available" about a fire that could never be scheduled is the same broken promise
 * the outage branch avoids by going bare once its attempts are spent. Absent is what leaves the client with the
 * honest offer it already had, a press, on its own timing.
 *
 * Read through `limitResumeArmed`, the same reader the resume pass consults when the window actually opens
 * hours later, so a frame that promised "scheduled" and a pass that then declines cannot disagree. That is the
 * identical argument `resumeArmed` makes for the credential path inside runTurn, and it is why the posture is
 * never snapshotted anywhere: arming a card AFTER its turn died has to arm that turn. */
const limitFrame = async (
    services: Services,
    event: Extract<AgentEvent, { kind: "error" }>,
    params: { readonly conversationId: string | undefined; readonly resetsAt: number | undefined; readonly held: boolean; readonly ran: boolean },
): Promise<Extract<AgentEvent, { kind: "error" }>> => {
    const { conversationId, resetsAt, held, ran } = params;
    const schedulable = held && resetsAt !== undefined && conversationId !== undefined;
    const armed = schedulable ? await limitResumeArmed(services, conversationId) : false;
    return {
        ...event,
        ...(held ? { held: { ran } } : {}),
        ...(resetsAt !== undefined ? { resetsAt } : {}),
        ...(schedulable ? { autoResume: armed ? ("scheduled" as const) : ("available" as const) } : {}),
    };
};

/* The session this turn resumes: the one it named, or none, because the runtime serving it does not have that
 * one any more. Which store answers is the adapter's (adapter.ts holdsSession); what a "no" MEANS is here, and
 * it is the same for all four: the turn opens a fresh session, seeded from the conversation's record by the
 * handoff its caller already runs for every other way a session gets retired.
 *
 * A store that cannot be read at all is trusted rather than doubted, retiring a live session over a failed
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
            services.logger.warn({ err: error, sessionId }, "session probe failed, resuming as asked");
            return true;
        });
    return held ? sessionId : undefined;
};

/* The provider spoke, so it settles whatever it last REFUSED, on the account that just proved it wrong.
 * Content on the wire is the only evidence that exists for the refusal kinds no poll can answer: an
 * entitlement refusal survives every reading that could contradict it (the token authenticates and the pools
 * publish all the way through it), so without this an admin re-enabling a seat would leave the alarm standing
 * for the full week the store keeps it. Fire-and-forget on the same contract as the writes at settle. */
const settleRefusals = (services: Services, provider: string, account: string | undefined): void => {
    void services.providerRefusals
        .clear(provider, account)
        .catch((error: unknown) => services.logger.warn({ err: error }, "provider refusal: settle failed"));
    // And the seat itself: an account that answers is an account that may serve turns again, so an admin
    // re-enabling Claude Code puts it back in the rotation with no reconnect. A routed turn names no account,
    // and CLIProxyAPI's own auth files are not seats this store knows.
    if (account === undefined) {
        return;
    }
    void services.claudeSeats
        .clear(account)
        .catch((error: unknown) => services.logger.warn({ err: error }, "claude account: could not clear the entitlement mark"));
};

// One agent turn's body, on the main tree (`worktree` undefined) or inside an isolated conversation's
// worktree, the cwd override is the single binding point every provider adapter, the tmux Bash path, and the
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
    // conversation behind it (the bench, a one-shot), there is no transcript for a rewind to address.
    turn?: SnapshotTurn,
): AsyncGenerator<AgentEvent> {
    // Whatever turn runs on this conversation supersedes a pending usage-limit resume, the user retrying by
    // hand (or the scheduler's own fire, which comes through here) must not be doubled by the scheduler later.
    if (input.conversationId !== undefined) {
        clearPendingResume(input.conversationId);
    }
    /* Turn preflight is where a slow start hides. Between here and `turn.started` below sit namespace setup, a
     * network git-fetch, the token refresh, the browser-server bring-up and a history snapshot, and not one of
     * them records a duration, so a turn that took a minute to start reads in the log exactly like one that
     * started instantly. These marks make the slow step name itself: a 128s event-loop freeze in this span once
     * left behind nothing but a `turn.started` that happened to be very late, and cost days to attribute. */
    const preflightStart = Date.now();
    const preflightStages: Record<string, number> = {};
    const mark = (stage: string): void => {
        preflightStages[stage] = Date.now() - preflightStart;
    };
    /* The shell environment this turn's capabilities and extensions contribute (capabilities/turn-env.ts).
     * A shared function rather than three awaits inline, because restoring an armed condition watch at boot
     * has to reproduce exactly this environment (agent/watchers.ts), and a second copy that drifted would
     * only show itself hours after a restart, in a check that quietly stopped working. */
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
    /* WHERE THIS TURN LIVES, two answers, and conflating them is a whole class of bug.
     *
     * `localCwd` is the tree as the DAEMON reaches it: the conversation's worktree, or /work for a main-tree
     * turn. Everything the daemon itself runs against the files (the dependency-readiness probe, the hashline
     * edit server) uses this, because the daemon is not in the turn's namespace.
     *
     * `effectiveCwd` is the workspace root as the AGENT sees it. Isolated, that is /work, which inside the
     * namespace resolves to `localCwd`, so the agent's own space is at the path every absolute path it
     * inherits already names, and nothing has to be remembered or forbidden. */
    const localCwd = worktree?.cwd ?? services.workspace.root;
    /* Built before anything else needs it, and torn down in this turn's finally. Undefined for a main-tree
     * turn, which means the shared checkout and says so.
     *
     * Gated on the runtime that actually ENTERS the namespace, the `isolation` field of its declared record,
     * which is "namespace" for exactly one of them. The Claude Code loop enters through the SDK's spawn seam; a
     * native Codex turn uses an app-server process whose adapter has not been connected to this namespace plan,
     * and an ACP turn talks to a pooled connection that outlives this turn. Building an anchor for those would
     * be worse than skipping it: `effectiveCwd`
     * below would hand them /work, the SHARED tree, while they sit outside the namespace that makes /work mean
     * the worktree. They keep pointing straight at their worktree instead, and are TOLD so (turn-plan.ts folds
     * the worktree note into their prompt), which is the only enforcement layer left for them.
     *
     * A container with no mount capability keeps the PLAN and loses only the anchor: the turn runs cwd'd in
     * its worktree as before, and the harness applies the same mapping to tool inputs instead
     * (agents/worktree-redirect.ts). That fallback used to be nothing at all, which is how three agents spent
     * a morning writing into the shared tree while their worktrees stayed empty. */
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
    // Kick the repo sync off now so its network git-fetch overlaps the token refresh, browser-server setup,
    // and config reads below instead of running strictly after them. Throttled to 60s, so it's a no-op on most
    // turns; awaited just before the snapshot, which must see the pulled files (the attribution fence below).
    // A top-level failure degrades to no advisory, per-repo errors already ride inside the outcomes.
    // Isolated turns skip it entirely, and this is the OTHER direction from the pre-turn rebase above
    // (agents/sync.ts), not a contradiction of it: that one moves the agent's branch onto the main line the
    // user already has, while this would pull a REMOTE into the user's checkout underneath a conversation
    // nobody asked to move, manufacturing exactly the divergence the rebase just spent a turn-start removing.
    const syncPromise =
        worktree !== undefined
            ? undefined
            : syncWorkspaceRepos(services, 60_000).catch((error: unknown) => {
                  services.logger.warn({ err: error }, "repo sync failed");
                  return [];
              });
    // Editor context attaches to THIS message, so it folds in before the (older) history preamble wraps it.
    const promptWithEditor = input.editorContext !== undefined ? `${input.prompt}\n\n${editorContextNote(input.editorContext)}` : input.prompt;
    /* WHAT THIS TURN CAN ACTUALLY CONTINUE FROM, asked of the runtime's own store before anything is built on
     * the answer, because a session id is a claim about that store rather than a fact.
     *
     * A resume names a session the runtime may no longer hold, and NOT ONLY after the sandbox was rebuilt or the
     * session deleted: a runtime reports its session id in its first frame and writes the session out seconds
     * later, so a turn stopped in its opening seconds leaves an id behind that nothing was ever saved under.
     * That was reported to the user as "this chat's history is gone (the sandbox was rebuilt or the session was
     * deleted)", two causes, neither of which had happened, and the turn was refused, so the words they had
     * just typed went nowhere and the fix on offer was to send them again.
     *
     * Nothing about that needed the user. The conversation's own record is right here and outlives every
     * session, so a forgotten session is a HANDOFF like any other: drop the dead id and let the fresh session be
     * seeded from the record, which is what the refusal was asking the user to trigger by hand. */
    const resumed = await sessionToResume(services, input, effectiveCwd);
    /* A turn that resumes no session, on a conversation that has already said something, is a runtime handoff:
     * the switch retired the old session and this one has to carry the conversation across. Read at turn start,
     * in the window every caller guarantees, the record is open and adopted (startConversationTurn awaits that
     * before the pump invokes the provider) and this turn's own messages are not appended until it settles. */
    const history =
        resumed === undefined && input.conversationId !== undefined
            ? await handoffHistory(services, { ...input, conversationId: input.conversationId })
            : [];
    mark("history");
    /* AUTOMATIC TIER SELECTION, judged here because this is where the turn is still a request rather than a
     * plan: `input.model` is the user's own pick, unresolved, which is exactly the ceiling the judge needs, and
     * everything below this line (the base request, planTurn, the arms' catalog validation) then treats the
     * answer as though it had been sent that way.
     *
     * Settings are read once and handed to planTurn as well, which already accepts them for this reason, so
     * the feature costs no extra read on a turn it does nothing to. In the default mode ("shadow") it does
     * nothing to any turn: it records what it WOULD have done beside what the turn really cost, and that ledger
     * is the only thing that can turn its weights into a measurement (see prompt-complexity.ts).
     *
     * The previous turn's verdict is the one input that cannot come from the request. It is read from the
     * conversation's own entry, which `begin` has already carried forward for exactly this. */
    const settings = await services.perf.track("turn.plan.settings", {}, () => services.sandboxSettings.get());
    const tier = await services.perf.track("turn.tier", {}, () =>
        turnTier(services, input, {
            settings,
            provider: input.agent ?? "claude",
            lastTier: input.conversationId === undefined ? undefined : services.agents.entry(input.conversationId)?.tier,
            // The turn's own flag when it says anything, else the conversation's persisted veto: `begin` has
            // already merged the two onto the entry by this point, but a one-shot turn has no entry to read.
            hold: input.tierHold ?? (input.conversationId === undefined ? false : (services.agents.entry(input.conversationId)?.tierHold ?? false)),
        }),
    );
    // The turn as the rest of this function must see it. Only the model can differ, and only downward, and
    // never over the user's veto (turn-tier.ts `held`).
    const tierRouted = tier?.model !== undefined && tier.held !== true;
    const planned: AgentTurn = tier !== undefined && tier.model !== undefined && tierRouted ? { ...input, model: tier.model } : input;
    if (tier !== undefined && input.conversationId !== undefined) {
        // Fire-and-forget: the next turn's judgement wants it, this one does not, and a registry write must
        // never be the thing that delays a turn the user is waiting on.
        services.agents
            .recordTier(input.conversationId, tier.verdict.tier)
            .catch((error: unknown) => services.logger.warn({ err: error }, "auto tier: recording the verdict failed"));
    }
    /* SAY WHAT THE JUDGE DECIDED, on every judged turn, for the reason the fast_mode frame exists: a mechanism
     * that can change what a turn runs on fails silently unless the daemon reports its own answer. The standard
     * verdicts ride too — one tiny frame — because the composer's pre-send preview needs the conversation's
     * last verdict to judge a follow-up the way this file will (prompt-complexity.ts `afterHardTurn`). */
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
        // Which agent the children this turn spawns belong to (agent/subagents.ts). Absent for a turn with no
        // conversation behind it, whose children are not surfaced.
        ...(input.conversationId !== undefined ? { conversationId: input.conversationId } : {}),
        ...(isolation !== undefined ? { isolation } : {}),
        signal: signal ?? new AbortController().signal,
        ...(Object.keys(cliEnv).length > 0 ? { cliEnv } : {}),
        ...(resumed !== undefined ? { sessionId: resumed } : {}),
        // `planned`, not `input`: a downgraded turn has to reach the arms as the model it will actually run,
        // so their catalog validation and their fallbacks apply to that id rather than to the one it replaced.
        ...(planned.model !== undefined ? { model: planned.model } : {}),
        ...(input.permissionMode !== undefined ? { permissionMode: input.permissionMode } : {}),
        ...(input.allowedTools !== undefined ? { allowedTools: input.allowedTools } : {}),
        ...(input.effort !== undefined ? { effort: input.effort } : {}),
        // Rides the same path as `effort`: into the base, then through turn-plan's two gates (the runtime that
        // can ask, the route that may) rather than straight to an adapter.
        ...(input.fast !== undefined ? { fast: input.fast } : {}),
    };
    /* WHICH RUNTIME SERVES THIS TURN AND WHAT IT IS HANDED, resolved as a value (turn-plan.ts), so the four
     * providers' gates and request assembly live together instead of interleaved with the lifecycle below.
     * A refusal is one of them: an ordinary state of a sandbox (a session id that outlived its transcript, a
     * subscription nobody connected, an uninstalled Agent capability), reported as the error frame the
     * composer's connect gate reads. */
    // The child-agent supervision surface: spawn on any connected provider, steer or follow-up a child, answer
    // its questions (children/children.ts). Built HERE because a child runs through streamAgent, which only
    // this module can hand down without a cycle — the same argument as `resync`. Withheld from a
    // conversationless turn (a child files under its parent on the roster, and a turn with no conversation has
    // nowhere to file one) and from a turn OUTSIDE CONTENT caused: a stranger's message must not start turns
    // that spend the owner's accounts, whatever tools its prompt talked it into — the same reasoning as the
    // outside-wake taint floor.
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
        // Read once above, for the tier judgement; planTurn accepts it precisely so the resolution happens once
        // per turn rather than once per thing that needs it.
        settings,
        ...(worktree !== undefined ? { resync: worktree.resync } : {}),
        ...(children !== undefined ? { children } : {}),
    });
    if (!plan.ok) {
        // The namespace anchor was built before the gates ran, so a refusal has to take it down too, it is a
        // detached `unshare` process that lives until something kills it, and every one of these refusals is a
        // condition the user hits repeatedly (an unconnected subscription answers the same way on every press).
        isolation?.anchor?.dispose();
        yield { kind: "error", ...(plan.code !== undefined ? { code: plan.code } : {}), message: plan.message };
        yield { kind: "done" };
        return;
    }
    mark("plan");
    const { run } = plan;
    // The provider account that serves this turn, the attribution key stamped onto the session/usage/rate-limit
    // frames and the activity log below.
    const resolvedAccount = plan.account;
    // The stamp itself, spread into every frame that carries the attribution, so the four sites that answer
    // "whose account was this" cannot drift into answering it three different ways.
    const attribution: { account?: string } = resolvedAccount !== undefined ? { account: resolvedAccount } : {};
    let request = plan.request;
    // Bring every repo with a remote up to its latest commit before the agent reads the tree, so the turn works
    // on current code. Clean-only fast-forward, a dirty/diverged/detached repo is left as-is and its stale state
    // reported into the prompt so the agent knows. Throttled per repo; a network failure on one repo is isolated
    // into its outcome, never blocking the turn. Runs before the attribution snapshot so pulled files land as
    // user-authored, not attributed to this turn.
    const advisory = syncPromise === undefined ? undefined : syncAdvisory(await syncPromise);
    mark("repoSync");
    if (advisory !== undefined) {
        // Onto the TYPED list like every other note, and not stapled by hand: the list is what feeds the
        // disclosure below, the transcript record, and the wire alike. Pasted on directly, as it once was, it
        // reached the model and nothing else, invisible in the chat, and redrawn as the user's own words by
        // every reopened tab. First of the notes, where the staple used to land it: what just moved on disk
        // is the first thing a turn should know.
        request = { ...request, notes: [{ title: REPO_SYNC_NOTE_TITLE, text: advisory }, ...(request.notes ?? [])] };
    }
    /* WHAT THE USER'S MESSAGE GREW ON THE WAY TO THE MODEL, said out loud.
     *
     * Everything above this line may have added a note: a rebase that moved the branch, a dependency tree that
     * is behind, the repos just pulled. They change what the agent does, and the chat used to show at most a
     * one-line paraphrase of one of them, so an agent acting on instructions the user could not read looked
     * like an agent acting on its own.
     *
     * Emitted from the SAME list the wire prompt is serialized from, two lines down, so the disclosure and
     * what the model receives cannot drift: a note is in both or in neither. The frame is also how the notes
     * reach the durable record, the transcript fold picks it out of the turn's own frame log
     * (sessions/turn-transcript.ts), which is what fixed the reopened tab losing every note the live tab had
     * shown. */
    const notes = request.notes ?? [];
    if (notes.length > 0) {
        yield { kind: "preamble", notes: [...notes] };
    }
    /* THE ONE SERIALIZATION of the typed notes into the wire prompt, immediately before the request reaches
     * its adapter and nowhere else (turn-preamble.ts, composeWirePrompt). Downstream of this line the composed
     * string is what every adapter and the provider's own session store see, byte-for-byte what the old
     * per-layer staples produced; upstream of it, nothing ever has to take the string apart again. */
    request = { ...request, prompt: composeWirePrompt(notes, request.prompt) };
    /* THE TURN'S BEFORE-STATE, recorded under this message so that going back to it, a rewind, or a fork that
     * wants the files as they were here, has something to name. Both placements record one; what differs is
     * what a "state" IS where the turn runs, which is the distinction agent/turn-anchors.ts exists to carry.
     *
     * MAIN TREE, the attribution fence: capture anything pending as user-authored (terminal edits,
     * desktop-sync arrivals, unflushed UI writes) BEFORE the agent runs, so the turn-end snapshot is purely the
     * agent's work. A no-op skip when the tree is clean; a history failure never blocks a turn. */
    if (worktree === undefined) {
        // The turn-start state's checkpoint id: the fence capture when it recorded something, else the newest
        // visible checkpoint (a clean tree at turn start IS that checkpoint's state, the common case). The
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
             * and the affordance it powers is wanted most by the tab that comes back tomorrow, see
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
    // An isolated turn takes no history capture, history covers the MAIN tree, which it never touches. Its
    // before-state is its own branch, and it is anchored by the isolated arm above, which is where the worktree
    // composition (and so the per-repo commits) is known.
    mark("snapshot");
    /* This turn's identity in the activity log, minted here because here is the first moment it exists. Every
     * event the turn writes, the four lifecycle marks below and one per sniffed outbound provider call, carries
     * it, which is what lets the audit feed render a turn as ONE row instead of five. Deliberately not sessionId:
     * the runtime does not report one until the stream's first frame, so turn.started (the event holding the
     * prompt) would be the one row nothing could ever join. */
    const turnId = randomUUID();
    // Tee every frame past the activity sniffer, outbound provider calls (discord curl) are only visible
    // here, and every turn origin (chat, automation wake, voice wake) flows through this generator.
    const sniffer = createOutboundSniffer(services, turnId);
    // Turn lifecycle into the activity log, the durable trail of every turn (start, plan artifacts, errors,
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
    // snapshots the turn's LAST session id, the one holding whatever it had done.
    let authRefused = false;
    /* Whether an auth refusal on THIS turn would be re-minted and re-run. Needs the exact token that was refused
     * (so the rotation supersedes it rather than replaying it) and the account it belongs to, which is why only a
     * turn on a STORED Claude account qualifies: the container-env fallback has no refresh token behind it and
     * nothing to re-mint from. And not a turn that is already a resume, see authResumable.
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
    /* A spent allowance refused this turn, so it is HELD for a press rather than for a poll (turn-resume.ts's
     * pendingLimit says why the allowance is the one failure nothing re-runs on its own). Same finally-time
     * handling as its two neighbours, and for one reason they do not share: the record needs `providerAnswered`
     * below, which is only final once the stream is, and it is what decides whether the press re-runs this turn
     * from the beginning or resumes the session it got partway through. */
    let limitHit = false;
    /* WHEN THE ALLOWANCE THAT REFUSED THIS TURN IS DUE BACK, resolved once inside the frame loop (the
     * precedence is stated where it is computed) and read again in the finally, because the held turn is
     * recorded there and the scheduled fire has nothing else to aim at. Kept rather than re-derived: the second
     * derivation would ask a snapshot that has since moved, so the card would count down to one instant while
     * the fire waited for another. */
    let limitReopens: number | undefined;
    // Whether the provider has answered THIS turn at all. Any real content proves it is serving requests, which
    // is what clears a standing outage for every conversation stranded on it, recovery is detected off ordinary
    // traffic instead of a probe anyone has to pay for. Once per turn: the breaker only needs the first word.
    // It is also what a held turn's re-run branches on, see `limitHit`.
    let providerAnswered = false;
    let usageExtra: Record<string, unknown> | undefined;
    // The turn's usage, kept typed (unlike usageExtra, which is the activity log's opaque `extra`) so the spend
    // ledger below appends numbers rather than re-narrowing unknowns. SUMMED, not last-wins: a turn emits one
    // frame per SDK turn, and a steered follow-up or an imp-mode round is a second one, the money is the total.
    let usage: UsageFrame | undefined;
    /* The model's own prose this turn, in characters, the terse steer's metric, and the only one it can be
     * scored on. The provider bills one output-token total and never says how much of it was narration; a real
     * turn's output is over nine parts tool-call arguments, so the steer's whole effect lives inside a tenth of
     * the number and cannot be seen there. Counted here because `delta` is the only frame that carries prose,
     * and nothing downstream of this loop still knows which bytes were which. */
    let proseChars = 0;
    /* WHETHER THIS TURN EVER ADDRESSED THE USER, and how much work it did without doing so. The pair
     * `silentEnding` reads at the `done` frame; ADDRESSED_FRAMES says what counts as addressing and why.
     *
     * The tool count is carried for the SENTENCE rather than the verdict: "the model stopped mid-turn" and "the
     * model stopped after 59 tool calls" send a reader to two different places, and this loop is the last thing
     * that knows which one happened. */
    const kinds = new Set<AgentEvent["kind"]>();
    let toolCalls = 0;
    /* The turn's search work, the search teaching's metric, on exactly the same footing as `proseChars` above:
     * the mechanism changes how the turn searches, so searches are what it has to be scored on, and cost per
     * turn could never see it (UsageTurn.searchCalls says why).
     *
     * `openingSearches` stops at the first file the turn opens or changes, which is the moment orientation ended
     * and the work began. Counted here for the same reason as the prose: the frame stream is the only place that
     * still knows the ORDER things happened in. */
    let searchCalls = 0;
    let openingSearches = 0;
    let reachedTheWork = false;
    /* DID THIS TURN PROVE ANYTHING, kept as the turn runs so the ledger can say at the end. The same ledger the
     * Stop nudge is built on (agent-verification.ts) and the same feeder a child's verdict comes off
     * (child-verification.ts), fed here from the PARENT turn's frames.
     *
     * FED FRAMES RATHER THAN HOOKS, which is what makes it universal: the hook version is Claude Agent SDK
     * PostToolUse and exists on one of six runtimes, while every runtime normalizes its stream into the
     * `tool_call` vocabulary before it reaches this loop.
     *
     * SUBAGENTS' CALLS COUNT, on exactly the rule the prose and the searches below already follow: a turn that
     * sent a child to make its edits still edited, and a verdict that ignored delegated work would report the
     * most careful turns as having done nothing. The child's own report carries its own verdict separately. */
    const verification = createFrameLedger();
    /* AND DID IT LOOK AT WHAT IT DREW, the same trick on the other half of the turn (agent-viewing.ts). A
     * separate ledger rather than a third reader on the one above, because it counts a different population
     * against a different kind of evidence: rendered surfaces against browser observations, where the proof
     * ledger counts code against checks. A passing suite is structurally unable to speak to a clipped label,
     * and folding the two would let one clear the other. */
    const viewing = createViewFrameLedger();
    /* THE AGENT'S OWN CHECKLIST as it last stood, the `todos` frames every runtime that keeps one emits. Last
     * wins: the frame is a whole snapshot, not a delta. Undefined ⇒ this turn kept no checklist, which is not
     * an empty one and must not be recorded as though it were. */
    let checklist: readonly TodoItem[] | undefined;
    // How many times the window was compacted under this turn, and how full it was when the turn ended. The
    // two facts nothing kept, and the ones that say whether a turn ended against the wall.
    let compactions = 0;
    let context: ContextUsage | undefined;
    /* THE LAST ERROR FRAME THIS TURN EMITTED, for the ledger's `outcome` and the one `error` line the log was
     * missing. LAST, not first: a turn that fails, resumes past an outage and then fails again ended on the
     * second failure, and the second is what a reader asking "why did this turn die" needs.
     *
     * A frame reached here at all means it was not an abort, the branch above drops those before anything sees
     * them, so a user pressing Stop can never be recorded as a failure. */
    let failure: { readonly code: string | undefined; readonly message: string } | undefined;
    // This turn's state as `silentEnding` reads it, gathered at the `done` frame where every field is final. The
    // judgement itself lives outside this function; here it is one call (see TurnSilence).
    const endedSilent = (): string | undefined =>
        silentEnding({
            conversationId: input.conversationId,
            signal,
            failed: failure !== undefined,
            answered: providerAnswered,
            kinds,
            proseChars,
            filesEdited: verification.edited().length,
            toolCalls,
        });
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
    /* Claim that account for as long as this turn holds its token. The token rode into the agent subprocess env
     * at spawn and cannot be replaced there, so a rotation landing now would kill this turn outright, the hold
     * is what makes the proactive refresh wait for a gap instead (claude/claude-credentials.ts). Taken on the
     * very edge of the try whose finally releases it: a hold leaked by a throw in between would block that
     * account's rotation for the rest of the daemon's life. */
    const releaseAccount = resolvedAccount !== undefined ? holdAccount(resolvedAccount) : undefined;
    try {
        for await (const event of withSilentEnding(run(request), endedSilent)) {
            /* AN ABORT IS NOT A FAILURE, and this is the one place that can say so for every provider.
             *
             * Each of the four adapters reports the unwind of a hard-cancel as an error frame, a thrown
             * AbortError from the SDK, a subprocess killed mid-stream, an ACP connection torn down, because
             * from inside the adapter that is indistinguishable from the provider dying. So a user pressing
             * Stop got the full failure treatment: `turn.error` in the activity log, an error line frozen into
             * the durable transcript, the frame relayed to a client that had already said "Stopped.", and, the
             * one that showed, `errored` on the registry entry, which finish() writes through as status
             * `error`. Every deliberately stopped agent landed on a red card in the Attention lane.
             *
             * Gated on the turn's own signal, which /agent/stop is the only thing that trips (the request
             * signal is deliberately not wired in, see the run route), so a genuine failure is never swallowed
             * by it. Dropped whole rather than downgraded: everything below this line is a reaction to a
             * failure, the outage breaker, the usage-limit resume, the client's error card, and none of them
             * has anything to do for a turn the user chose to end. */
            if (event.kind === "error" && signal?.aborted === true) {
                continue;
            }
            sniffer.observe(event);
            /* The provider spoke. Whatever this turn is, a resume, a fresh message, an automation wake, it has
             * just proved the outage is over for every conversation stranded on this provider, so the whole
             * stranded set is released instead of each waiting out its own backoff (provider-health.ts).
             *
             * Above the routing chain rather than inside it: this is a fact about the provider, not about what the
             * frame means to the client, and the branches below `continue` past each other freely. Once per turn,
             * the breaker only needs the first word. */
            if (ANSWERED_FRAMES.has(event.kind)) {
                // Content AFTER an outage failure means the harness got past it and this turn carried on, so there
                // is nothing stranded here to resume, the pending record would re-run a turn that finished.
                outageHit = false;
                // The same for a rate limit the harness rode out (its own in-turn retry outlasted the window):
                // this turn is answering, so it is not held, and offering to re-run it would re-run a turn that
                // is on its way to finishing.
                limitHit = false;
                if (!providerAnswered) {
                    providerAnswered = true;
                    recordProviderSuccess(provider);
                    // And it settles the refusals this turn just disproved, both the provider's and the seat's.
                    settleRefusals(services, provider, resolvedAccount);
                }
            }
            if (event.kind === "delta") {
                // Every prose frame, subagent narration included: they run on the same steered system prompt,
                // and a turn that delegates its writing would otherwise read as a turn that wrote nothing.
                proseChars += event.text.length;
            }
            // …and what KINDS of frame this turn produced at all, which is how the ending below knows whether
            // anything was ever put in front of the user (silentEnding, and TurnSilence on why it is a set).
            kinds.add(event.kind);
            if (event.kind === "tool_call") {
                // Counted for the silent ending's sentence alone (silentEnding). `tool_call` only, on the same
                // rule the search counters below follow: an update is a later state of a call already counted.
                toolCalls += 1;
                // Subagents' calls included, on the same rule as the prose above: a turn that sends an Explore
                // agent looking still went looking, and the retrieval it was handed is what it would have used.
                // `tool_call` only, an update is a later state of a call already counted.
                // A compound Bash call may both search and open a file. Count its search against the state at
                // call entry, then independently close orientation after it; making these branches exclusive
                // hid most real file reads (`cat`/`sed`/`head`/`tail`) and inflated openingSearches.
                const searched = isSearchCall(event);
                if (searched) {
                    searchCalls += 1;
                }
                if (searched && !reachedTheWork && searchPrecedesFileWork(event)) {
                    openingSearches += 1;
                }
                if (isFileWorkCall(event)) {
                    reachedTheWork = true;
                }
            }
            /* WHAT THIS TURN CHANGED AND WHAT PROVED IT, and the two facts that say whether it ended against
             * the wall. Frames the loop already carries, folded here because nothing downstream of it still
             * knows the ORDER they arrived in, which is the whole of the verification question: `pnpm test`
             * then three edits is a turn with no evidence for those edits. */
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
                /* WHOSE CREDENTIAL THIS SESSION IS ON, said by the only party that knows. A turn naming no
                 * account is served by whichever connected one has the most headroom (harness-credentials.ts),
                 * so the client's pick answers a different question, and a client that stamped it onto the
                 * session would then announce a fresh session for the account actually holding it, and retire a
                 * resumable one on the next send. Both readers of this stamp take it from here: the registry
                 * files it beside the session id (agents-registry's `session` case, which is what the reopened
                 * tab reads back), and the browser binds its live session ref with it. */
                yield { ...event, ...attribution };
                continue;
            } else if (event.kind === "usage") {
                usage = sumUsage(usage, event);
                const { kind: _kind, ...rest } = usage;
                usageExtra = rest;
                // Attribute the per-turn totals (and the account-wide rate-limit snapshot) to the account that
                // served the turn, so the client keys its usage displays by account.
                yield { ...event, ...attribution };
                continue;
            } else if (event.kind === "rate_limit_info") {
                limitReset = event.resetsAt ?? limitReset;
                yield { ...event, ...attribution };
                continue;
            } else if (event.kind === "account_usage") {
                /* Persist the windows as well as streaming them, so the account picker can report this
                 * account's headroom on the next page load instead of only for as long as this tab stays open,
                 * and announce them, so every other open window's rings move too (usage/headroom.ts).
                 *
                 * WHICH ACCOUNT. A native Claude turn names the one it ran on. A native Codex turn's reading
                 * arrives on its own stream too (the app-server pushes the plan's rate limits), but the turn
                 * names only the subscription, CLIProxyAPI picked the auth file, so it is filed under the one
                 * file the provider holds, or, with several, the provider's files are re-read precisely instead
                 * of guessing. Fire-and-forget: a usage write must never delay or fail a turn (same contract
                 * as the activity append below). */
                void fileAccountUsage(services, provider, resolvedAccount, event.windows);
                yield { ...event, ...attribution };
                continue;
            } else if (event.kind === "plan") {
                record({ type: "turn.plan", content: event.text, extra: { requestId: event.requestId } });
            } else if (event.kind === "error") {
                record({ type: "turn.error", outcome: "error", error: event.message });
                failure = { code: event.code, message: event.message };
                /* AND THE LOG SAYS SO. The daemon's own log carried no record of a failed turn at all: the
                 * trace went to the activity feed, which prunes, and to the client's stream, which exists only
                 * while a browser is attached. So the most common failure in the product was also the one least
                 * likely to leave a mark, and a log holding 6 errors across 3.5MB was describing its own
                 * instrumentation rather than the system's health.
                 *
                 * Split by whether anything downstream already handles this code (HANDLED_FAILURE_CODES says
                 * why): an unclassified failure is an `error`, a refusal that is already filed somewhere a
                 * surface reads is a `warn`. Both are durable, which was the whole gap; the level is what keeps
                 * `error` worth grepping for.
                 *
                 * The fields are the join keys, not the story: whoever reads this line next wants to pull the
                 * turn out of the transcript and the ledger, and these are what let them. */
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
                        // `reason`, not `message`: the logger's messageKey IS `message` (see logger.ts), so a
                        // field of that name would overwrite the line's own text and the level would be all a
                        // reader had left.
                        reason: event.message.slice(0, ERROR_MESSAGE_CHARS),
                    },
                    failed ? "turn failed" : "turn refused",
                );
                /* THE PLAN SAID NO, file it, so the account surfaces can say when it last happened.
                 *
                 * The three codes that mean "this provider would not serve the turn", as opposed to the workspace
                 * or the request being at fault. Nothing here changes what the turn DOES about it (the branches
                 * below own that, unchanged); this is the durable trace, and it is the only one: a rate_limit
                 * frame is relayed to whoever is attached and forgotten, so a refusal that landed while nobody
                 * was watching, an automation at 4am, a fleet agent, left no mark anywhere a person could find.
                 *
                 * `kind` is read off the SENTENCE (mentionsSpentAllowance) rather than off the code, because for
                 * every provider but Claude the two disagree, see failure-sentences.ts. Two codes are read
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
                            ...attribution,
                            // The model, so the refusal is read against the pool that model spends rather than
                            // the account's fullest one (UsageWindow.gates).
                            ...(request.model === undefined || request.model === "" ? {} : { model: request.model }),
                        })
                        .catch((error: unknown) => services.logger.warn({ err: error }, "provider refusal: write failed"));
                    /* AND RE-MEASURE WHAT REFUSED, NOW. A refusal is the strongest live signal a plan gives and
                     * the moment the reading matters most, so the account that said no (or, for a routed turn,
                     * the provider's files) is read again at once rather than on the next screen open: the
                     * ring turns red while the sentence is still on screen, and the picker stops offering it. */
                    void services.headroom.refresh({
                        scope: { providers: [provider], ...(resolvedAccount === undefined ? {} : { account: resolvedAccount }) },
                        maxAgeMs: 0,
                    });
                }
                /* The provider failed us, not the workspace. Open (or re-observe) its outage and tell the client
                 * where the resume stands: which attempt this is, when the next one is due, and whether it is
                 * armed or merely on offer behind the setting. Past the attempt budget nothing more will fire, so
                 * the frame goes out bare, a promise of a retry that will never come is worse than the red line
                 * it replaced. */
                const outage = event.code === "provider-outage" && input.conversationId !== undefined ? recordProviderFailure(provider) : undefined;
                if (outage !== undefined && outage.attempt < OUTAGE_MAX_ATTEMPTS && input.conversationId !== undefined) {
                    outageHit = true;
                    // THIS conversation's posture, not the sandbox's alone, the same question the resume
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
                /* The credential was refused mid-turn. Say on the frame whether the daemon is going to re-mint
                 * and re-run this turn, because that is the difference between a notice and a red line and the
                 * client cannot work it out: the recording happens in the finally below, after this frame is
                 * long gone. Same condition, named once (see resumeArmed), a frame promising a renewal that the
                 * finally then declines to arm leaves a spinner turning over a turn that is never coming back. */
                const tokenRefused = event.code === "claude-token-refused";
                authRefused ||= tokenRefused;
                if (tokenRefused && resumeArmed) {
                    yield { ...event, autoResume: "scheduled" };
                    continue;
                }
                /* THE SEAT, NOT THE CREDENTIAL. This account signs in perfectly and its organization has Claude
                 * Code switched off, so there is nothing to re-mint and nothing to wait for, the only remedy is
                 * to stop choosing it, which is what the mark does (claude-seats.ts). The turn
                 * that discovered it still fails, with the provider's own sentence; every turn after it is
                 * routed to an account that can answer. */
                if (event.code === "claude-not-entitled" && resolvedAccount !== undefined) {
                    void services.claudeSeats
                        .refuse(resolvedAccount, event.message)
                        .catch((error: unknown) => services.logger.warn({ err: error }, "claude account: could not record the entitlement refusal"));
                }
                /* WHEN THIS ALLOWANCE COMES BACK, one precedence for every runtime and every provider, because a
                 * limit that can name its reset and one that cannot are what separate a scheduled continuation
                 * from three five-second retries into a closed window.
                 *
                 * An api_retry rate limit carries the SDK's own retry instant directly, and a refusal the
                 * harness dressed itself already carries the allowance's (error-frames.ts). Everything else, the
                 * final refusal shapes, and every frame raised by a NATIVE runtime that has no allowance object
                 * to ask, resolves through limitReopensAt, which reads the account snapshot and the translator's
                 * pool alike. That last arm is the one this used to be missing: Codex, the two OpenCode loops and
                 * Cursor all emit a bare `rate_limit`, and the per-account fallback could never answer for them.
                 *
                 * Frame first, snapshot second, throughout: a failure that named its own instant read it off the
                 * provider's live scheduler, while a snapshot can be minutes old. */
                const rateLimited = event.code === "rate_limit";
                const resetsAt = rateLimited
                    ? (limitReset ?? event.resetsAt ?? (await limitReopensAt({ services, provider, model: request.model, account: resolvedAccount })))
                    : undefined;
                /* THE TURN IS BEING HELD, said on the frame, because the client's whole answer to this
                 * failure hangs off it: a held turn makes Continue a re-run of this turn, and an unheld one
                 * leaves it what it always was, a new message saying "carry on". The frame goes out while the
                 * turn is still unwinding, well before the finally records anything, so the condition is
                 * named once here and read twice, exactly as `resumeArmed` is one branch up: a frame
                 * promising a re-run the finally then declines to arm is a press that does nothing.
                 *
                 * `ran` is read at frame time on purpose. Content arriving AFTER this would mean the harness
                 * got past the limit, which clears the hold entirely (see the reset beside `outageHit`), so
                 * there is no case where the finally's answer differs from this one on a turn still held. */
                if (rateLimited) {
                    limitHit = input.conversationId !== undefined;
                    limitReopens = resetsAt;
                }
                // A limit frame is worth dressing for either reason on its own, an instant to count down to or a
                // turn being held for the press; a limit with neither says nothing more than the bare frame does,
                // and falls through to it.
                if (rateLimited && (resetsAt !== undefined || limitHit)) {
                    yield await limitFrame(services, event, {
                        conversationId: input.conversationId,
                        resetsAt,
                        held: limitHit,
                        ran: providerAnswered,
                    });
                    continue;
                }
            }
            yield event;
        }
    } finally {
        // The token this turn snapshotted is nobody's constraint any more, a rotation deferred while it ran
        // can happen on the next tick.
        releaseAccount?.();
        // Drop the namespace anchor. Not a kill of the namespace itself: a pane the agent left running (a dev
        // server it started) is still in there and keeps it alive until it exits, which is exactly the
        // behaviour a user watching that terminal expects.
        isolation?.anchor?.dispose();
        // The credential died under this turn, remember it so the next scheduler pass re-mints and re-runs it.
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
        // The provider killed this turn, hand it to the outage pass with the last session the stream reported, so
        // the resume continues from whatever it had already done rather than paying for all of it twice. Recorded
        // whatever the toggle says, so turning resumeAfterOutage on right after the failure arms this very turn.
        if (outageHit && input.conversationId !== undefined) {
            recordOutageFailure({
                input: { ...input, conversationId: input.conversationId },
                ...(sessionId !== undefined ? { sessionId } : {}),
                provider,
            });
        }
        /* A spent allowance refused this turn: hold it whole, so the user's press re-runs THIS turn instead of
         * sending a fresh "Continue" after it. Nothing polls this entry, which is the difference between it and
         * the two above and the reason the allowance argument in turn-resume.ts survives intact: the budget is
         * still the user's to spend, and this only decides what their spending it means.
         *
         * `ran` off `providerAnswered`, which is now final: false says the provider refused before the model read
         * a word, which is the ordinary shape of an already-spent allowance and the case where the session left
         * behind holds nothing but an unanswered message. */
        if (limitHit && input.conversationId !== undefined) {
            recordLimitFailure({
                input: { ...input, conversationId: input.conversationId },
                ...(sessionId !== undefined ? { sessionId } : {}),
                ran: providerAnswered,
                // The instant the frame already published, carried so the pass can keep the appointment the
                // card is counting down to. Absent for a provider that names none, which leaves the entry
                // press-only however the posture is set (runLimitPass says why a guess would be worse).
                ...(limitReopens !== undefined ? { reopensAt: limitReopens } : {}),
            });
        }
        record({ type: "turn.completed", ...(usageExtra !== undefined ? { extra: usageExtra } : {}) });
        /* A ROUTED TURN JUST SPENT SOMETHING, and the only reading of what it spent is the one this re-read
         * takes. A Claude turn reads its own account's pools at settle (sdk-stream's account_usage frame); a
         * turn through the translator never learns which auth file served it, so the provider's readable files
         * are refreshed instead, freshness-bounded so a fleet of parallel turns costs one sweep between them.
         * Fire-and-forget like every other turn-end write. */
        if (KeyedProviderSchema.safeParse(provider).success) {
            void services.headroom.refresh({ scope: { providers: [provider] }, maxAgeMs: SETTLE_MAX_AGE_MS });
        }
        /* The spend ledger, the durable, never-pruned record the cost dashboard reads, and now the only place a
         * turn's FATE survives longer than the feed that prunes it.
         *
         * EVERY TURN LANDS, which is the change. It used to be billed turns only, on the reasoning that a
         * zero-cost row would inflate the turn count with turns that cost nothing. That reasoning was right
         * about the money and it is what made an incident unreadable: a turn refused before the provider
         * charged a token, which is what an auth refusal, a spent allowance and a dead seat all are, produced no
         * usage frame and therefore no row, so the failures likeliest to arrive in a burst were exactly the ones
         * that left nothing behind. The count is protected where it belongs instead, in the rollup, which sums
         * money and skips rows that carry none (usage-store.ts).
         *
         * `outcome` is read off what the stream actually did: the abort signal (a user pressing Stop, never a
         * failure), then the last error frame, then success. `model` is resolved past the client's pick and
         * every provider default, which is the one the money was spent on; `modelRequested` is the pick itself,
         * and the pair is what makes a routing surprise a diff.
         *
         * The EXPERIMENT metrics ride only on a turn that ran. A turn that died before the provider spoke has
         * `proseChars: 0` and `searchCalls: 0` as a matter of arithmetic, not of behaviour, and feeding those
         * zeros to the arms would let a burst of auth refusals read as a treatment that silenced the model.
         * Omitted rather than zeroed, because absent is the one value those readers already discard.
         *
         * Fire-and-forget, same contract as every other turn-end write. */
        const outcome = signal?.aborted === true ? "cancelled" : failure !== undefined ? "error" : "ok";
        const billed = usage !== undefined;
        /* HOW THE TURN ENDED, past the three words `outcome` has for it. A turn that proved its work and a turn
         * that went quiet halfway through its own checklist are both "ok", and until now the ledger wrote the
         * same row for each (UsageTurn.verification says why that is the question worth answering).
         *
         * GATED ON THE PROVIDER HAVING SPOKEN, not on the turn having been billed. `no-code` on a turn the
         * provider refused before the model read a word is arithmetic rather than behaviour, exactly the trap
         * the experiment metrics avoid one line down; `no-code` on a turn that ran is a real answer about a
         * real turn. A CANCELLED turn keeps its verdict too, and deliberately: work abandoned mid-flight with
         * nothing proving it is precisely what a reader coming back to a stopped turn needs told. */
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
                            // Pending and in-progress alike: both are work the agent said it would do and did
                            // not, and a turn ending on either is a turn that stopped rather than finished.
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
                // Empty as well as absent: the wire allows `model: ""` and the Codex path treats it as "the
                // catalog default", so recording it would write a pick nobody made (turn-plan.ts line 545).
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
                // How it ended, past what it cost: what the turn changed, what proved it, what it left open.
                ...ending,
                ...(billed
                    ? {
                          // Counted off this turn's own frames rather than taken from the provider, which reports
                          // one output total and no breakdown, see UsageTurn.proseChars.
                          proseChars,
                          // Likewise off the frames, and in their order, see UsageTurn.searchCalls for why the
                          // search-teaching experiment is judged on these and not on what the turn cost.
                          searchCalls,
                          openingSearches,
                      }
                    : {}),
                // The turn experiments' arms, when this turn was in them, the ledger is the only place they
                // are recorded, and without them the steer's and the teaching's effects are unmeasurable
                // after the fact.
                ...(plan.terseArm !== undefined ? { terse: plan.terseArm } : {}),
                ...(plan.searchArm !== undefined ? { iqSearchArm: plan.searchArm } : {}),
                ...(plan.searchCohort !== undefined ? { iqSearchCohort: plan.searchCohort } : {}),
                /* What the complexity judge said, and whether anything came of it. Absent together when
                 * the judge did not run (settings.autoTier "off"), which the ledger must be able to tell
                 * apart from a turn that scored zero, see UsageTurn.tierScore.
                 *
                 * `tierRouted` is not implied by the score: in shadow mode every turn is judged and none is
                 * moved, and even switched on, a turn judged fast still runs standard when the provider
                 * publishes nothing cheaper than the pick. Reading the score as the decision would report
                 * savings that were never made. */
                ...(tier !== undefined
                    ? {
                          tierScore: tier.verdict.score,
                          tierRules: [...tier.verdict.rules],
                          // The verdict and the cutoff behind it, written down rather than re-derived: with the
                          // cutoff an owner setting, a score alone no longer says which side of it a row fell.
                          tierFast: tier.verdict.tier === "fast",
                          tierCeiling: tier.verdict.ceiling,
                          tierRouted: tier.model !== undefined && tier.held !== true,
                          // The veto, only when it stood between a fast verdict and a real substitution: the
                          // strongest negative label the calibration read gets (UsageTurn.tierDenied).
                          ...(tier.held === true ? { tierDenied: true } : {}),
                      }
                    : {}),
            })
            .catch((error: unknown) => services.logger.warn({ err: error }, "usage: ledger append failed"));
        /* AND THE PROOF FOLLOW-UP, for the runtimes that cannot get one from a Stop hook.
         *
         * The `verify-edits` rule reaches a Claude turn through the SDK's hooks, mid-turn, which is cheaper
         * than anything this can do and keeps the context the work happened in — so where those run, this
         * stands aside and the gate on `rulebook` is what keeps a turn from being told twice. Everywhere else
         * the rule was armed and inert, and the follow-up arrives as its own turn instead (verify-nudge.ts).
         *
         * FOUR GATES, because this spends a turn on the user's behalf. It ended WELL: a failed turn has a
         * failure to report rather than an unproven edit, and a CANCELLED one must never be answered by the
         * daemon starting another, which is the same turn coming back after the user stopped it. It is not a
         * spawned child: that conversation's reader is its parent, and the parent has already been told what
         * the child proved. It has a conversation to run on at all. And the rule itself, with its conditions,
         * is checked inside. */
        if (
            outcome === "ok" &&
            input.conversationId !== undefined &&
            capabilitiesOf(provider, input.harness ?? "native").rulebook !== "hooks" &&
            !isSpawnedChild(input.conversationId)
        ) {
            void nudgeUnverifiedWork({
                conversationId: input.conversationId,
                seed: input,
                rules: request.turnEndingRules ?? [],
                ledger: verification,
                view: viewing,
                ...(isolation !== undefined ? { isolation: isolation.plan } : {}),
                cwd: effectiveCwd,
                ...(request.onRuleFired !== undefined ? { onFired: request.onRuleFired } : {}),
                ...(request.verifyTests !== undefined ? { tests: request.verifyTests } : {}),
            }).catch((error: unknown) => services.logger.warn({ err: error }, "verify nudge: could not be decided"));
        }
        sniffer.flush();
        // Fire-and-forget workspace snapshot at turn end (aborted turns included), history must never delay
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
        // Start the conversation's turn as a detached run, the ack carries the run id and the turn executes
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
            // rides along too, see startConversationTurn.
            const run = await startConversationTurn(services, streamAgent, { ...input, conversationId });
            if (run === undefined) {
                throw new ORPCError("CONFLICT", { message: "a turn is already running for this conversation" });
            }
            return { run: run.id };
        }),
        /* Run the turn a spent allowance refused, AGAIN, with everything it originally carried EXCEPT who serves
         * it, which the press names because the press is usually the second half of an account switch
         * (ResumeRoutingSchema). NOT_FOUND when nothing is held, which is the answer to every way that happens
         * (the failure was something else, a later turn superseded it, the daemon restarted) and tells the client
         * to fall back to saying something itself. CONFLICT is deliberately absent: a turn already running on this
         * conversation IS the press having landed, so a second press answers NOT_FOUND on the entry that turn's
         * start cleared, and a user pressing twice is told nothing happened twice rather than shown an error the
         * first press caused.
         *
         * The re-run is a turn like any other (startConversationTurn), so it journals, notifies and records
         * identically; what makes it a repeat rather than a new message is the resume note on its prompt, which
         * every reader of a stored prompt already knows how to strip and to show as a notice. */
        resume: i.resume.handler(async ({ input }) => {
            const run = await fireLimitResume(services, streamAgent, input.conversationId, input.routing);
            if (run === undefined) {
                throw new ORPCError("NOT_FOUND", { message: "no held turn to run again for that conversation" });
            }
            return { run: run.id };
        }),
        // Render the conversation's run: the head (its identity and its rows so far), then every change and
        // every fact as it lands, `end` when the run settles. A client that named a superseded run gets the
        // current one's head, whose run id tells it which world it's in.
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
        /* Un-park a turn waiting on an interactive card, a plan approval, question picks, or a per-tool
         * permission prompt, all keyed by the same requestId. NOT_FOUND when nothing holds that id (already
         * answered, or the turn ended), which is what tells the client to freeze the card as stale.
         *
         * A DISMISSED QUESTION ENDS THE TURN, and it ends here rather than in the browser. The rule itself is
         * old: the card was raised because the agent could not choose, so waving it away answers nothing, and
         * letting the turn run on means it guesses at exactly the fork it just said it could not guess at.
         * What changed is where it happens. The browser used to say it in two messages, release the card,
         * then stop, and between them the daemon had a live turn with nothing parked on it, which is the
         * definition of a working agent: the board pulled the card out of Attention, filed it under Active for
         * the length of a round trip, and then moved it a second time when the stop arrived. Said in one step
         * the in-between never exists, and where the card lands stops being a race between two requests.
         *
         * Marked before it is resolved, and the whole handler down to the abort is synchronous, so the tool's
         * own continuation cannot run in between and re-publish the agent as running. */
        reply: i.reply.handler(async ({ input }) => {
            /* WHAT THE DECISION SAYS IN THE TRANSCRIPT, written by the daemon into the run's own rows, so every
             * window and the record read it the same: the dismissal's line goes down BEFORE the reply ends the
             * turn (the stop that follows writes its own), a plan's verdict and the feedback that came with it
             * go down once the reply has landed. A request nothing holds writes nothing. */
            const held = conversationOf(input.requestId);
            const run = held === undefined ? undefined : turnRunOf(held);
            if (input.kind === "question" && input.cancelled === true) {
                run?.note({ role: "notice", text: "Question dismissed." });
            }
            if (await applyReply(services, input)) {
                if (input.kind === "plan") {
                    run?.note({ role: "notice", text: input.approve ? "Plan approved." : "Kept planning." });
                    // The rejection's feedback is the user's turn: kept visible, otherwise the typed text (and
                    // the files it went with) vanish from the transcript even though the agent has them.
                    if (!input.approve && input.feedback !== undefined && input.feedback.trim().length > 0) {
                        run?.note({ role: "user", text: input.feedback, sentAt: Date.now() });
                    }
                }
                return { ok: true } as const;
            }
            /* NOTHING HELD THAT ID HERE, which for a REMOTE conversation is the ordinary case rather than a
             * stale card: the question was minted on the runner, and this daemon only relayed the frame that
             * drew it (runners/runner-requests.ts remembers which machine). So the answer travels, and the
             * runner applies it with the very same function this handler just tried.
             *
             * The dismissal marker is set HERE as well as there, because the two daemons own different halves
             * of the same card: the runner ends the turn, and this side is what the board is drawing. */
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
        // Inject a user message into the conversation's running turn (delivered between tool calls);
        // NOT_FOUND when no steerable turn is live, the client then keeps it queued for the next turn.
        // The message is composed exactly like a turn's own prompt (editor-context note, then the attachment
        // note over workspace-resolved paths), so adding a file mid-turn reads the same to the agent as
        // attaching it to a fresh message.
        steer: i.steer.handler(async ({ input }) => {
            /* A REMOTE CONVERSATION'S TURN IS RUNNING ON ANOTHER MACHINE, so the words go there, UNCOMPOSED:
             * the attachment note names absolute paths, and the only workspace those mean anything in is the
             * runner's (turn-interactions.ts). What stays here is the RECORD below, because the parent owns
             * the transcript wherever the turn ran. */
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
            /* THE MESSAGE INTO THE RUN'S OWN LOG, at the point in the stream where the turn took it, which is
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
            /* AND ITS PLACE IN THE QUEUE OF WAYS BACK, taken in the same synchronous breath as the frame so the
             * Nth box belongs to the Nth steered row however the captures below interleave (see
             * agent/steer-anchors.ts). The state itself is pinned after: mid-answer is the only moment it
             * exists, and its INDEX is not known until the turn settles and the fold says how many rows it
             * wrote first. Awaited so the poster's 200 means the bookmark is really there, and never fatal:
             * this message has already been accepted by the turn. */
            await anchorSteeredMessage(services, input.conversationId);
            // A steered message is something the user SAID, so the fleet filter has to find it. Recorded here
            // rather than left to the transcript because the prompt index reads a session's file once and holds
            // it (transcript-search.ts), a mid-turn message that only ever landed in the file would be invisible to
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
            // The press, published. Everything below this line is the unwind, seconds of it, on a turn holding
            // a long tool call, and until it lands the roster would still be saying `running` to every surface
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
        /* Go back to a message, files, transcript and provider session together (see agent/rewind.ts).
         *
         * CONFLICT rather than a queue-and-wait on a running turn: rewinding is a decision about work the user
         * is looking at, and holding it until a twenty-minute turn finishes would apply it to a workspace that
         * has moved on since they asked. The same code the busy send uses, so the client already knows it. */
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
        // The provider's slash commands from its most recent turn. Empty (not an error) when it has never run
        // one here, the popover simply stays closed until the first turn publishes the list.
        commands: i.commands.handler(({ input }) => ({ commands: [...commandsOf(input.agent ?? "claude")] })),
        // What each provider last refused a turn with. Empty when none has, which is the common, healthy case,
        // and reads as "nothing to say" on every surface rather than as a failed read.
        refusals: i.refusals.handler(async () => ({ refusals: await services.providerRefusals.read() })),
    };
};
