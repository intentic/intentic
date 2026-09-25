import { randomUUID } from "node:crypto";
import {
    type AgentEvent,
    type AgentReply,
    type AgentTurn,
    capabilitiesOf,
    type ContextTrim,
    type PromptFingerprint,
    type SnapshotTurn,
    type TranscriptRow,
    type TurnNote,
    mentionPaths,
    withRuntimeDefaults,
} from "@intentic/sandbox-contract";
import { userRow } from "@intentic/sandbox-contract/transcript-fold";
import type { Logger } from "pino";
import { createOutboundSniffer } from "../../activity/outbound.js";
import { turnCliEnv } from "../../capabilities/turn-env.js";
import type { Services } from "../../composition.js";
import { REPO_SYNC_NOTE_TITLE, type RepoSync, syncAdvisory, syncWorkspaceRepos } from "../../workspace/layout/sync-repos.js";
import { resolveExistingWithin, resolveWithin } from "../../workspace/files/workspace-files-paths.js";
import { startAnchor, type TurnPlacement } from "../../conversations/worktrees/isolation.js";
import { type PersistedAgent, worktreeOf } from "../../conversations/registry/agents-store.js";
import { holdAccount } from "../../runtimes/claude/claude-credentials.js";
import { ensureComposedWorktree } from "../context/conversation-context.js";
import { settleLandingInBackground, versionMainTree } from "../../conversations/land/version-landed.js";
import { handoffHistory, turnStartIndex } from "../../sessions/turn-transcript.js";
import { type ChildSupervisor, childSupervisor, isSpawnedChild, spawnDepthOf } from "../subagents/children.js";
import type { AgentRequest, TurnBase, TurnHooks, TurnSpec } from "../providers/agent-request.js";
import { composeWirePrompt } from "../prompt/turn-preamble.js";
import { applyTrim, trimFrame, type TurnTrimState } from "../prompt/window/context-trim.js";
import { promptDisclosure } from "../prompt/prompt-disclosure.js";
import type { TurnBriefing } from "../prompt/turn-briefing.js";
import { limitReopensAt } from "../models/limit-reset.js";
import type { RoutedTurn, TurnInput } from "../../seams/turn-starter.js";
import { type LiveRun } from "../../conversations/actor/conversation-holdings.js";
import { opt } from "../../opt.js";
import { SteeringQueue } from "../checkpoints/agent-steering.js";
import { recordProviderFailure } from "../providers/provider-health.js";
import { breakPolicyFor, type HeldTurn, stopResumeAt } from "./turn/turn-resume.js";
import { noteReplay, replayOf } from "./turn/cache-keepwarm.js";
import { dispatchRemoteTurn } from "../../runners/runner-dispatch.js";
import { editorContextNote } from "./turn/turn-interactions.js";
import { withRuntimeHistory } from "../providers/runtime-history.js";
import { handoffStateNote } from "../prompt/handoff-state.js";
import { limitWayOf } from "../models/limit-way.js";
import { nameAgentTitle } from "../models/title-namer.js";
import { planTurn, type TurnPlan } from "./turn/turn-plan.js";
import { classifyFailure, type ErrorFrame, type FailureContext, type FailureQueries } from "./frames/classify-failure.js";
import { abortSuppresses, type Attribution, decorateFrame, silenceOf, silentEnding, withSilentEnding } from "./frames/frame-decorators.js";
import { performFailureWrites, providerAnswered, recordFrame, turnActivity } from "./frames/frame-effects.js";
import { createTurnFrames, type TurnFrames } from "./frames/frame-reducers.js";
import { performSettlement } from "./settle/settle-turn.js";
import { settleTurn } from "./settle/turn-settlement.js";
import { conversationIdentity, mainTreePlacement, type Placement, placedTurn, refusedBegin, runnerPlacement } from "./placement/turn-placement.js";
import { type WorktreeRun, worktreePlacement } from "./placement/worktree-placement.js";
import { resolveTurnJobs } from "../tools/jobs/job-fates.js";

// One turn from placement to settlement (streamAgent): placed, prepared, run on its provider, folded, settled.

// Whether this turn enters the namespace, asked in one place so three callers can't disagree. A property of the
// runtime: only the Claude Code loop enters it.
const entersNamespace = (input: RoutedTurn): boolean => capabilitiesOf(input.agent, input.harness).isolation === "namespace";

// What the turn was told before the user's own words, filed for the chat to show. The preamble's notes ride the
// message and land in the transcript; the system prompt reaches the model and nothing else, so this file is the only
// place it can be read back. Composed from the request the adapter is about to be handed, and never awaited: a reader
// opens it minutes later, and a turn must not wait on a file to start.
const recordSystemPrompt = (services: Services, input: RoutedTurn, request: AgentRequest): void => {
    const conversationId = input.conversationId;
    // A spawned child files nothing: no chat draws its opening, and the conversation purge only names registry
    // entries, so its record would be written and never reclaimed.
    if (conversationId === undefined || isSpawnedChild(services.conversations, conversationId)) {
        return;
    }
    const capabilities = capabilitiesOf(input.agent, input.harness);
    void services.promptRecord
        .record(conversationId, promptDisclosure({ capabilities, request, at: Date.now() }))
        .catch((error: unknown) => services.logger.warn({ err: error }, "prompt: recording what this turn was told failed"));
};

// Runs one agent turn, streaming AgentEvents; `input.agent` picks the provider adapter. Owns the turn's control
// surface: the AbortController /agent/stop cancels, and the SteeringQueue /agent/steer injects into.
export async function* streamAgent(services: Services, sent: TurnInput, signal: AbortSignal | undefined): AsyncGenerator<AgentEvent> {
    // Routed as it comes in, for a caller that reached the body without the port (a suite, a runner's mirror).
    const input = withRuntimeDefaults(sent);
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
        steering = capabilitiesOf(input.agent, input.harness).steering ? new SteeringQueue() : undefined;
        unregister =
            input.conversationId !== undefined
                ? services.conversations.registerTurn(input.conversationId, {
                      abort: () => controller.abort(),
                      ...(steering !== undefined ? { steering } : {}),
                  })
                : undefined;
        yield* runConversationTurn(services, input, controller.signal, steering);
    } finally {
        unregister?.();
        steering?.close();
    }
}

// The runner a conversation runs on: the first request picks it, and later turns follow the registry.
const runnerOf = (existing: PersistedAgent | undefined, input: RoutedTurn): string | undefined => {
    if (existing !== undefined) {
        return worktreeOf(existing)?.runner;
    }
    return input.placement?.kind === "runner" ? input.placement.id : undefined;
};

// A runner is isolated by construction; otherwise a fresh conversation takes the request's placement and later turns
// follow the registry. The persona no longer chooses: every caller already asks for isolation now.
const isolatedOf = (existing: PersistedAgent | undefined, input: RoutedTurn, runner: string | undefined): boolean => {
    if (runner !== undefined) {
        return true;
    }
    return existing === undefined ? input.isolated === true : existing.placement.kind === "worktree";
};

// Where the conversation's turn runs. The runner and the worktree compose their checkout with the same decision; only
// a local placement runs the turn's body here.
const placementOf = (
    services: Services,
    input: RoutedTurn,
    signal: AbortSignal | undefined,
    steering: SteeringQueue | undefined,
    conversation: { readonly id: string; readonly snapshot: SnapshotTurn; readonly runner: string | undefined; readonly isolated: boolean },
): Placement => {
    const { id, snapshot, runner } = conversation;
    if (runner !== undefined) {
        return runnerPlacement(
            services,
            { conversationId: id, snapshot, runner },
            {
                compose: () => ensureComposedWorktree(services, input, id, input.worktreeBase, entersNamespace(input)),
                dispatch: (worktree) => dispatchRemoteTurn(services, { ...input, conversationId: id }, runner, worktree, signal),
            },
        );
    }
    if (!conversation.isolated) {
        return mainTreePlacement(() => runTurn(services, input, signal, undefined, steering, snapshot));
    }
    return worktreePlacement(
        services,
        { input, conversationId: id, snapshot, signal },
        {
            compose: (base) => ensureComposedWorktree(services, input, id, base, entersNamespace(input)),
            versionMain: (repos) => versionMainTree(services, repos),
            run: (worktree) => runTurn(services, input, signal, worktree, steering, snapshot),
            settleLanding: (conversationId) => settleLandingInBackground(services, conversationId),
        },
    );
};

// The fleet-registry lifecycle around every turn: `conversationId` acquires the mutex and publishes frames, and where
// the conversation is placed decides what runs around the turn's own body.
async function* runConversationTurn(
    services: Services,
    input: RoutedTurn,
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
    // Placement belongs to the conversation, and a fresh one naming an unpaired runner is refused before it exists.
    const existing = services.agents.entry(conversationId);
    const runner = runnerOf(existing, input);
    if (existing === undefined && runner !== undefined && !(await services.runners.enrolled(runner))) {
        yield {
            kind: "error",
            message: `No runner named "${runner}" is paired with this sandbox — pair one first, or leave placement out to run here.`,
        };
        yield { kind: "done" };
        return;
    }
    const isolated = isolatedOf(existing, input, runner);
    const began = await services.conversations.send(conversationId, {
        kind: "begin",
        turn: conversationIdentity(input, conversationId, { isolated, runner }),
    }).settled;
    if (began !== "begun") {
        if (began === "archived") {
            services.logger.info({ conversationId }, "turn not begun: the conversation is archived, and only a person reopens it");
        }
        yield* refusedBegin(began);
        return;
    }
    // Names the conversation while the turn runs, fire-and-forget; a gate skips one already better-named.
    // Warn, not debug: this pass is invisible by construction, so a debug failure goes unnoticed fleet-wide.
    nameAgentTitle(services, conversationId, input.prompt).catch((error: unknown) =>
        services.logger.warn({ err: error }, "agents: title naming failed"),
    );
    // Read once above the placement, so every placement checkpoints under the same index.
    const snapshot: SnapshotTurn = { conversationId, index: await turnStartIndex(services, { ...input, conversationId }) };
    yield* placedTurn(
        services.conversations,
        conversationId,
        placementOf(services, input, signal, steering, { id: conversationId, snapshot, runner, isolated }),
        // Never throws: a job it cannot judge stays awaited.
        () => resolveTurnJobs({ conversations: services.conversations, scanPorts: services.scanPorts, logger: services.logger }, conversationId),
    );
}

// What a settled plan answer leaves in the transcript: the decision's notice, and a rejection's feedback, which stays
// visible as the user's own row or vanishes though the agent still has it. Staged files ride as @-paths in the one field.
export const notePlanAnswer = (run: LiveRun | undefined, answer: Extract<AgentReply, { kind: "plan" }>): void => {
    run?.note({ role: "notice", text: answer.approve ? "Plan approved." : "Kept planning." });
    if (!answer.approve && answer.feedback !== undefined && answer.feedback.trim().length > 0) {
        run?.note(userRow(answer.feedback, Date.now(), mentionPaths(answer.feedback)));
    }
};

// Preflight is a few hundred ms plus one throttled fetch; past this it's a defect, not ordinary load.
const SLOW_PREFLIGHT_MS = 5_000;

// Marks each preflight stage, so a slow start names its own culprit instead of hiding in an undated gap.
const preflightClock = (): { readonly mark: (stage: string) => void; readonly report: (logger: Logger) => void } => {
    const start = Date.now();
    const stages: Record<string, number> = {};
    return {
        mark: (stage) => {
            stages[stage] = Date.now() - start;
        },
        report: (logger) => {
            const preflightMs = Date.now() - start;
            if (preflightMs >= SLOW_PREFLIGHT_MS) {
                logger.warn(
                    { preflightMs, stages },
                    "turn preflight slow: the stage marks say which step, and a stalled event loop inflates all of them at once",
                );
            }
        },
    };
};

// The turn a spent allowance or a dead runtime is holding for this conversation, read as this turn supersedes every
// pending resume: a fresh session gets what the dead turn's ledgers measured. Nothing for a turn with no conversation.
const supersedeHeld = (services: Pick<Services, "conversations">, conversationId: string | undefined): HeldTurn | undefined =>
    conversationId === undefined ? undefined : services.conversations.send(conversationId, { kind: "resume-superseded" }).reply;

// What a fresh session is told beside the transcript: the tree, the proof, the checklist — only for a turn seeded from
// the record.
const handoffNoteFor = async (
    services: Services,
    input: RoutedTurn,
    history: readonly unknown[],
    held: HeldTurn | undefined,
): Promise<TurnNote | undefined> =>
    history.length === 0 || input.conversationId === undefined
        ? undefined
        : handoffStateNote(services, {
              conversationId: input.conversationId,
              standing: held?.standing,
              checklist: held?.checklist,
              retiredSessionId: held?.sessionId ?? services.agents.entry(input.conversationId)?.sessionId,
          });

// The session to resume, or none if the runtime no longer holds it, which opens a fresh session seeded from the record
// instead. A store that can't be probed is trusted, not doubted.
const sessionToResume = async (services: Services, input: RoutedTurn, effectiveCwd: string): Promise<string | undefined> => {
    const { sessionId } = input;
    if (sessionId === undefined) {
        return undefined;
    }
    const adapter = services.adapters.for(input.agent, input.harness);
    const held = await services.perf
        .track("turn.preflight.session", {}, () => adapter.holdsSession(services, sessionId, effectiveCwd))
        .catch((error: unknown) => {
            services.logger.warn({ err: error, sessionId }, "session probe failed, resuming as asked");
            return true;
        });
    return held ? sessionId : undefined;
};

// Resuming no session is a runtime handoff, seeded from the record read before this turn appends its own, less the
// runs the door turned away before this turn sent their words again: the model never saw those rows.
const handoffOf = async (services: Services, input: RoutedTurn, resumed: string | undefined): Promise<readonly TranscriptRow[]> => {
    if (resumed !== undefined || input.conversationId === undefined) {
        return [];
    }
    const rows = await handoffHistory(services, { ...input, conversationId: input.conversationId });
    const unseen = new Set(input.unseenRuns ?? []);
    return unseen.size === 0 ? rows : rows.filter((row) => row.run === undefined || !unseen.has(row.run));
};

// Attachments arrive workspace-relative; resolved to absolute paths for the provider, escapes rejected. The run route
// refuses these at the door, so reaching a refusal is a turn replayed from a record (resume, fork, a runner). Mentions
// are a tokenizer's reading of the message, not files the user picked: one that escapes or names nothing is dropped,
// since a `@path` pasted inside terminal output must not be able to kill the turn.
const attachmentsOf = async (root: string, input: RoutedTurn): Promise<{ readonly paths: string[] } | { readonly refused: string }> => {
    const paths: string[] = [];
    for (const rel of input.attachments ?? []) {
        const abs = resolveWithin(root, rel);
        if (abs === undefined) {
            return { refused: `invalid attachment path: ${rel}` };
        }
        paths.push(abs);
    }
    const mentioned = await resolveExistingWithin(root, input.mentions);
    paths.push(...mentioned.filter((abs) => !paths.includes(abs)));
    // The editor-context chip's file rides workspace-relative too, same escape guard as attachments.
    if (input.editorContext !== undefined && resolveWithin(root, input.editorContext.file) === undefined) {
        return { refused: `invalid editor context path: ${input.editorContext.file}` };
    }
    return { paths };
};

// Built only for the runtime that enters the namespace; others stay cwd'd, told so in the prompt instead.
const isolationOf = async (
    services: Services,
    input: RoutedTurn,
    worktree: WorktreeRun | undefined,
    localCwd: string,
): Promise<TurnPlacement | undefined> => {
    if (worktree === undefined || !entersNamespace(input)) {
        return undefined;
    }
    const plan = await services.turnIsolation.planFor(localCwd, worktree.fenced);
    if (!(await services.turnIsolation.available())) {
        return { plan };
    }
    return { plan, anchor: await startAnchor(plan) };
};

// What a conversation turn's gates ask of its actor as they go: whether a person has steered it, and whether a card
// restored after a restart already granted a tool.
const actorAsks = (
    conversations: Pick<Services["conversations"], "state" | "send">,
    conversationId: string,
): Pick<TurnHooks, "steered" | "restoredGrant"> => ({
    steered: () => conversations.state(conversationId)?.steered === true,
    restoredGrant: (tool) => conversations.send(conversationId, { kind: "grant-taken", tool }).reply,
});

// The request every arm builds on: the words as the model reads them, where it runs, the knobs the turn named, and
// what its conversation's actor answers live.
const baseRequestOf = (
    services: Pick<Services, "conversations" | "cards">,
    input: RoutedTurn,
    turn: {
        readonly history: readonly TranscriptRow[];
        readonly cwd: string;
        readonly isolation: TurnPlacement | undefined;
        readonly signal: AbortSignal | undefined;
        readonly cliEnv: Record<string, string>;
        readonly resumed: string | undefined;
    },
): TurnBase => {
    // Editor context attaches to THIS message, so it folds in before the older history preamble wraps it.
    const prompt = input.editorContext !== undefined ? `${input.prompt}\n\n${editorContextNote(input.editorContext)}` : input.prompt;
    return {
        spec: {
            prompt: turn.history.length > 0 ? withRuntimeHistory(prompt, turn.history) : prompt,
            cwd: turn.cwd,
            // Which agent the children this turn spawns belong to; absent for a turn with no conversation.
            ...opt("conversationId", input.conversationId),
            ...opt("spawnDepth", input.conversationId === undefined ? undefined : spawnDepthOf(services.conversations, input.conversationId)),
            ...opt("isolation", turn.isolation),
            ...opt("sessionId", turn.resumed),
            ...opt("model", input.model),
            ...opt("effort", input.effort),
            // Rides the same path as `effort`: through turn-plan's own gates, not straight to an adapter.
            ...opt("fast", input.fast),
        },
        policy: { ...opt("permissionMode", input.permissionMode), ...opt("allowedTools", input.allowedTools) },
        tools: Object.keys(turn.cliEnv).length > 0 ? { cliEnv: turn.cliEnv } : {},
        hooks: { cards: services.cards, ...(input.conversationId === undefined ? {} : actorAsks(services.conversations, input.conversationId)) },
        signal: turn.signal ?? new AbortController().signal,
    };
};

// The children this turn may spawn. None for a turn with no conversation, or one an outside wake started.
const childrenOf = (services: Services, input: RoutedTurn, cwd: string): ChildSupervisor | undefined =>
    input.conversationId === undefined || input.outsideWake !== undefined
        ? undefined
        : childSupervisor(services, { conversationId: input.conversationId, cwd });

// Everything a turn resolves before it can be planned: where it runs, the session it resumes and what a fresh one is
// told, the request every arm builds on, the readings its frames fold into, and the repo sync already under way.
interface Preflight {
    readonly context: Parameters<typeof planTurn>[2];
    readonly isolation: TurnPlacement | undefined;
    readonly effectiveCwd: string;
    readonly frames: TurnFrames;
    readonly handoffNote: TurnNote | undefined;
    readonly repoSync: Promise<RepoSync[]> | undefined;
}

const preflight = async (
    services: Services,
    input: RoutedTurn,
    signal: AbortSignal | undefined,
    worktree: WorktreeRun | undefined,
    steering: SteeringQueue | undefined,
    clock: ReturnType<typeof preflightClock>,
): Promise<Preflight | { readonly refused: string }> => {
    const held = supersedeHeld(services, input.conversationId);
    // Shared with the boot-time condition-watch restore, so a drifted second copy can't quietly stop working.
    const cliEnv = await turnCliEnv(services);
    clock.mark("env");
    const attachments = await attachmentsOf(services.workspace.root, input);
    if ("refused" in attachments) {
        return attachments;
    }
    // Two paths: `localCwd` is the daemon's tree; `effectiveCwd` is the root as the agent sees it.
    const localCwd = worktree?.cwd ?? services.workspace.root;
    const isolation = await isolationOf(services, input, worktree, localCwd);
    clock.mark("isolation");
    const effectiveCwd = isolation?.anchor?.cwd ?? localCwd;
    // Kicked off early to overlap setup; opposite the pre-turn rebase, into the user's checkout.
    const repoSync =
        worktree !== undefined
            ? undefined
            : syncWorkspaceRepos(services, 60_000).catch((error: unknown) => {
                  services.logger.warn({ err: error }, "repo sync failed");
                  return [];
              });
    // Asks the runtime's store whether it still holds the named session: a session id is a claim, not a fact.
    const resumed = await sessionToResume(services, input, effectiveCwd);
    const history = await handoffOf(services, input, resumed);
    // What is TRUE beside what was said, measured by the sandbox; rides the request as one more note.
    const handoffNote = await handoffNoteFor(services, input, history, held);
    clock.mark("history");
    const settings = await services.perf.track("turn.plan.settings", {}, () => services.sandboxSettings.get());
    const base = baseRequestOf(services, input, { history, cwd: effectiveCwd, isolation, signal, cliEnv, resumed });
    const frames = createTurnFrames(effectiveCwd, resumed);
    const context = {
        base,
        attachmentPaths: attachments.paths,
        localCwd,
        effectiveCwd,
        cliEnv,
        steering,
        settings,
        ...opt("resync", worktree?.resync),
        ...opt("children", childrenOf(services, input, localCwd)),
    };
    return { context, isolation, effectiveCwd, frames, handoffNote, repoSync };
};

// A refusal that ran nothing, as the frame the chat draws. `unattended` rides with it because the row it becomes
// offers to send the message again (transcript-fold.ts errorRow), which is only true where somebody typed one: an
// automation, a loop or a watch wake has no composer holding anything.
const refusalFrame = (
    refusal: {
        readonly code?: Extract<AgentEvent, { kind: "error" }>["code"];
        readonly message: string;
        // The cgroup reading behind a `sandbox-memory-low`, so the row it becomes can offer the raise as a press.
        readonly memory?: Extract<AgentEvent, { kind: "error" }>["memory"];
        readonly account?: string;
    },
    unattended: boolean,
) =>
    ({
        kind: "error",
        ...(refusal.code !== undefined ? { code: refusal.code } : {}),
        ...(unattended ? { unattended: true } : {}),
        ...(refusal.memory !== undefined ? { memory: refusal.memory } : {}),
        ...(refusal.account !== undefined ? { account: refusal.account } : {}),
        message: refusal.message,
    }) as const satisfies AgentEvent;

// What the message grew before reaching the model, and what the model's window would not let it grow. Both, together,
// because they are one disclosure asked from two sides: an empty note list is not one, and a shed note has no message
// to be drawn beside, so the trim frame is the only place its absence can be said.
//
// The trim speaks on every turn it applies rather than once per conversation. A turn forty messages down that ran thin
// without saying so is the failure this exists to stop, and switching to a larger model simply stops the line.
function* preambleDisclosure(notes: readonly TurnNote[], trim: ContextTrim | undefined): Generator<AgentEvent> {
    if (notes.length > 0) {
        yield { kind: "preamble", notes: [...notes] };
    }
    if (trim !== undefined) {
        yield { kind: "context_trim", ...trim };
    }
}

// The message's final note list, and the one frame naming what the window kept out of it. Together, because the two
// notes assembled here (the repo-sync advisory, the hand-off state) reach the window LAST and must face the same one
// the rest already did — the hand-off note is the largest of them — and because the reader is owed one list rather
// than planning's followed by this one's.
const sentNotes = (
    assembled: readonly TurnNote[],
    briefing: TurnBriefing,
    trim: TurnTrimState | undefined,
): { readonly notes: TurnNote[]; readonly trim: ContextTrim | undefined } => {
    // Through the card's briefing once more: these two missed the filter in planning, and the frame below must name
    // exactly what was sent rather than what was assembled.
    const { notes, state } = applyTrim(trim, briefing.keep([...assembled]));
    return { notes, trim: trimFrame(state) };
};

type PlannedTurn = Extract<TurnPlan, { readonly ok: true }>;

// The request as the runtime gets it. The repo-sync advisory goes first among its notes, as the first thing a turn
// should know; the hand-off's measured state goes last, beside the envelope and the words it describes; and the wire
// prompt is composed from the list the window let through, which is the list the preamble discloses.
const wireOf = (
    plan: PlannedTurn,
    advisory: string | undefined,
    handoffNote: TurnNote | undefined,
): { readonly request: AgentRequest; readonly notes: TurnNote[]; readonly trim: ContextTrim | undefined } => {
    const planned = plan.request.spec;
    const spec: TurnSpec =
        advisory === undefined ? planned : { ...planned, notes: [{ title: REPO_SYNC_NOTE_TITLE, text: advisory }, ...(planned.notes ?? [])] };
    const { notes, trim } = sentNotes([...(spec.notes ?? []), ...(handoffNote === undefined ? [] : [handoffNote])], plan.briefing, plan.contextTrim);
    return { request: { ...plan.request, spec: { ...spec, prompt: composeWirePrompt(notes, spec.prompt) } }, notes, trim };
};

// This turn's start checkpoint on the main tree, for a rewind or fork to name: the fence capture if any, else the
// newest one. Written down as well as streamed, since the frame alone reaches only today's browser.
async function* mainTreeCheckpoint(services: Services, turn: SnapshotTurn | undefined): AsyncGenerator<AgentEvent> {
    const checkpointId = await services.history
        .snapshot("user")
        .then(async (id) => id ?? (await services.history.list())[0]?.id)
        .catch((error: unknown) => {
            services.logger.warn({ err: error }, "history: turn-start snapshot failed");
            return undefined;
        });
    if (checkpointId === undefined) {
        return;
    }
    if (turn !== undefined) {
        await services.turnCheckpoints
            .record(turn.conversationId, turn.index, { kind: "tree", snapshot: checkpointId })
            .catch((error: unknown) => services.logger.warn({ err: error }, "anchors: recording the turn's checkpoint failed"));
    }
    yield { kind: "checkpoint", id: checkpointId, ...(turn !== undefined ? { index: turn.index } : {}) };
}

// A planned turn, ready to run: the plan, the request as the runtime gets it, and where it runs.
interface PreparedTurn {
    readonly plan: PlannedTurn;
    readonly request: AgentRequest;
    readonly isolation: TurnPlacement | undefined;
    readonly effectiveCwd: string;
    readonly frames: TurnFrames;
}

// Preflight, then the plan, then the notes the message grew and the checkpoint it can be rewound to; a refusal at any
// gate ends the turn here with its frame and `done`.
async function* prepareTurn(
    services: Services,
    input: RoutedTurn,
    signal: AbortSignal | undefined,
    worktree: WorktreeRun | undefined,
    steering: SteeringQueue | undefined,
    turn: SnapshotTurn | undefined,
): AsyncGenerator<AgentEvent, PreparedTurn | undefined> {
    const clock = preflightClock();
    const ready = await preflight(services, input, signal, worktree, steering, clock);
    if ("refused" in ready) {
        yield { kind: "error", message: ready.refused };
        yield { kind: "done" };
        return undefined;
    }
    const plan = await planTurn(services, input, ready.context);
    if (!plan.ok) {
        // The namespace anchor was built before the gates ran, so a refusal must dispose it too.
        ready.isolation?.anchor?.dispose();
        yield refusalFrame(plan, input.unattended === true);
        yield { kind: "done" };
        return undefined;
    }
    clock.mark("plan");
    // Fast-forwards repos with a remote before the agent reads them; pulled files count as user-authored.
    const advisory = ready.repoSync === undefined ? undefined : syncAdvisory(await ready.repoSync);
    clock.mark("repoSync");
    const wire = wireOf(plan, advisory, ready.handoffNote);
    yield* preambleDisclosure(wire.notes, wire.trim);
    recordSystemPrompt(services, input, wire.request);
    // An isolated turn takes no history capture: history covers only the main tree, which it never touches.
    if (worktree === undefined) {
        yield* mainTreeCheckpoint(services, turn);
    }
    clock.mark("snapshot");
    clock.report(services.logger);
    return { plan, request: wire.request, isolation: ready.isolation, effectiveCwd: ready.effectiveCwd, frames: ready.frames };
}

// Only a stored Claude account's credential is re-minted, never on the re-mint itself: refused again, it is dead.
const remintFor = (input: RoutedTurn, account: string | undefined, request: AgentRequest): FailureContext["remint"] =>
    input.conversationId !== undefined && account !== undefined && request.credential.kind === "claude-oauth" && input.resume !== "auth"
        ? { account, refusedToken: request.credential.token }
        : undefined;

// The questions a failure's classification asks, answered from the daemon's own records.
const failureQueries = (services: Services): FailureQueries => ({
    breakPolicy: (conversationId, ending) => breakPolicyFor(services, conversationId, ending),
    reopensAt: (at) => limitReopensAt({ services, ...at }),
    limitWay: (params) => limitWayOf(services, params),
    stopLadder: (conversationId) => {
        const made = services.conversations.state(conversationId)?.resume.stopTries ?? 0;
        return { made, nextAt: stopResumeAt(made) };
    },
});

// A turn's first cache reading names the hold it picked up, which the transcript turns into its receipt.
const keptWarmOf = (services: Pick<Services, "conversations">, conversationId: string | undefined, event: AgentEvent): AgentEvent => {
    if (event.kind !== "prompt_cache" || conversationId === undefined) {
        return event;
    }
    const kept = services.conversations.state(conversationId)?.turn.keptWarm;
    return kept === undefined ? event : { ...event, kept };
};

// What a running turn knows about itself, which each failure it classifies reads.
interface TurnState {
    readonly input: RoutedTurn;
    readonly turnId: string;
    readonly provider: NonNullable<AgentTurn["agent"]>;
    // The account serving this turn; undefined for a container-env credential or an untracked translator subscription.
    readonly account: string | undefined;
    readonly attribution: Attribution;
    readonly request: AgentRequest;
    readonly remint: FailureContext["remint"];
    readonly frames: TurnFrames;
}

// A failure frame as the window reads it: counted against the provider's breaker when it is an outage on a
// conversation, classified, its line logged, its records written and its hold taken, all before it goes out.
const classified = async (services: Services, event: ErrorFrame, turn: TurnState): Promise<AgentEvent> => {
    const { input, provider, frames } = turn;
    const readings = frames.readings();
    const outage = event.code === "provider-outage" && input.conversationId !== undefined ? recordProviderFailure(provider) : undefined;
    const failure = await classifyFailure(
        event,
        {
            turn: input,
            turnId: turn.turnId,
            provider,
            model: turn.request.spec.model,
            account: turn.account,
            attribution: turn.attribution,
            sessionId: readings.sessionId,
            answered: readings.silence.answered,
            remint: turn.remint,
            limitReset: readings.limitReset,
            outage,
            standing: frames.verification.standing(),
            checklist: readings.checklist,
            contextTokens: readings.context?.tokens,
            now: Date.now(),
        },
        failureQueries(services),
    );
    services.logger[failure.log.level](failure.log.fields, failure.log.message);
    performFailureWrites(services, failure.writes);
    frames.hold(failure.held);
    // The account that actually served (or was refused for) the turn rides on its frame, so no window guesses it.
    return turn.account === undefined || failure.frame.account !== undefined ? failure.frame : { ...failure.frame, account: turn.account };
};

// What a turn holds for its life, released together once its frames end: the account, so a proactive refresh waits for
// a gap rather than rotating the token under it, and the namespace anchor, though not the namespace, which a pane the
// agent left running keeps alive.
const holdTurn = (account: string | undefined, isolation: TurnPlacement | undefined): (() => void) => {
    const releaseAccount = account !== undefined ? holdAccount(account) : undefined;
    return () => {
        releaseAccount?.();
        isolation?.anchor?.dispose();
    };
};

// One agent turn's body, on the main tree or inside an isolated worktree; the cwd override is the one binding point
// every adapter and session store follows. Prepared and planned, then every frame through the pipeline (suppressed if
// the turn was stopped, folded into the readings, its writes made, its failure classified or its stamps applied), then
// settled from the readings.
async function* runTurn(
    services: Services,
    input: RoutedTurn,
    signal: AbortSignal | undefined,
    worktree: WorktreeRun | undefined,
    steering: SteeringQueue | undefined,
    // Which conversation message this turn answers, for its checkpoint; undefined with no conversation.
    turn?: SnapshotTurn,
): AsyncGenerator<AgentEvent> {
    const prepared = yield* prepareTurn(services, input, signal, worktree, steering, turn);
    if (prepared === undefined) {
        return;
    }
    const { plan, request, isolation, frames } = prepared;
    const provider = input.agent;
    const account = plan.account;
    const attribution = { ...opt("account", account), ...opt("actor", input.actor) };
    // This turn's identity in the activity log, minted here so its events join as one row.
    const turnId = randomUUID();
    // Tees every frame past the activity sniffer: outbound provider calls are only visible here.
    const sniffer = createOutboundSniffer(services, turnId);
    const record = turnActivity(services, { input, provider, turnId, attribution, sessionId: () => frames.readings().sessionId });
    const state: TurnState = { input, turnId, provider, account, attribution, request, remint: remintFor(input, account, request), frames };
    const aborted = (): boolean => signal?.aborted === true;
    const silent = (): string | undefined => silentEnding(silenceOf(frames, { conversationId: input.conversationId, aborted: aborted() }));
    record({ type: "turn.started", content: input.prompt.slice(0, 2_000) });
    const release = holdTurn(account, isolation);
    // The prefix this turn's requests were built from, as the CLI announced it; what a cache refresh must match.
    let fingerprint: PromptFingerprint | undefined;
    try {
        for await (const raw of withSilentEnding(plan.run(request.spec), silent)) {
            if (abortSuppresses(raw, aborted())) {
                continue;
            }
            const event = keptWarmOf(services, input.conversationId, raw);
            fingerprint = event.kind === "init" ? (event.prompt ?? fingerprint) : fingerprint;
            sniffer.observe(event);
            if (frames.note(event)) {
                providerAnswered(services, provider, account);
            }
            recordFrame(services, event, { provider, account, record });
            yield event.kind === "error"
                ? await classified(services, event, state)
                : decorateFrame(event, { attribution, provider, oauth: request.credential.kind === "claude-oauth" });
        }
    } finally {
        release();
        const spawned = input.conversationId !== undefined && isSpawnedChild(services.conversations, input.conversationId);
        if (input.conversationId !== undefined) {
            noteReplay(
                services.conversations,
                input.conversationId,
                replayOf({ input, request, account, sessionId: frames.readings().sessionId, fingerprint, spawned }),
            );
        }
        const settlement = settleTurn({
            ...state,
            aborted: aborted(),
            isolated: worktree !== undefined,
            spawnedChild: spawned,
            isolation,
            experiments: plan.experiments,
        });
        performSettlement(services, settlement, { record, flush: sniffer.flush });
    }
}

