import { type AgentEvent, profileOf, type SnapshotTurn } from "@intentic/sandbox-contract";
import { landAgent, reportLockfileFailures } from "../../../conversations/land/land.js";
import type { ConversationActors } from "../../../conversations/actor/conversation-actors.js";
import type { BeginRefusal, BeginTurn } from "../../../conversations/actor/conversation-decide.js";
import { isIsolated } from "../../../conversations/registry/agents-store.js";
import type { ConversationWorktree } from "../../../conversations/worktrees/worktrees.js";
import type { Services } from "../../../composition.js";
import { checkpointWorktree } from "../../checkpoints/checkpoint-worktree.js";
import { opt } from "../../../opt.js";
import type { SentTurn } from "../../../seams/turn-starter.js";

// Where a conversation's turn runs, as the one value its lifecycle is parameterized by: the runner, the main tree, or a
// worktree. Each announces itself, hands over the turn's body, and has its own after-turn and its own books; the
// conversation's side (every body frame to its actor, a failure marked, always settled) is the same for all three.

export interface Placement {
    // Frames announcing where the turn runs, ahead of its body; the generator returns the body itself.
    readonly open: () => AsyncGenerator<AgentEvent, AsyncIterable<AgentEvent>>;
    // After a body that ran to its end; `failed` is whether it emitted an error frame.
    readonly land: (failed: boolean) => AsyncGenerator<AgentEvent>;
    // In the turn's finally, before the conversation settles.
    readonly close: (failed: boolean) => Promise<void>;
    // After the settle, once per turn whatever happened.
    readonly settled: (failed: boolean) => void;
    // What a thrown error carrying no message of its own is observed as.
    readonly thrown: string;
}

// A stop or a closed stream, which ends a turn without failing it.
const isAbort = (error: unknown): boolean => typeof error === "object" && error !== null && (error as { name?: string }).name === "AbortError";

// The conversation's lifecycle around one placed turn the caller has begun: every body frame sent to its actor, an
// error frame or a thrown error marking it failed, a thrown one sent and rethrown, and the settle always sent.
// `ended` runs between a body that ran to its end and the land, whatever the placement: what the turn's ending decides
// about what it left running must be decided before the land asks whether anything still wakes the conversation.
export async function* placedTurn(
    conversations: Pick<ConversationActors, "send">,
    conversationId: string,
    placement: Placement,
    ended?: () => Promise<void>,
): AsyncGenerator<AgentEvent> {
    let failed = false;
    try {
        const body = yield* placement.open();
        for await (const event of body) {
            conversations.send(conversationId, { kind: "frame", frame: event });
            failed ||= event.kind === "error";
            yield event;
        }
        await ended?.();
        yield* placement.land(failed);
    } catch (error) {
        if (!isAbort(error)) {
            failed = true;
            conversations.send(conversationId, { kind: "frame", frame: { kind: "error", message: error instanceof Error ? error.message : placement.thrown } });
        }
        throw error;
    } finally {
        await placement.close(failed);
        await conversations.send(conversationId, { kind: "settle" }).settled;
        placement.settled(failed);
    }
}

// What a conversation's turn begins as: its profile whole, and what an opening turn decides. Placement is the
// conversation's: a fresh one takes the request's, later turns follow the registry's own record.
export const conversationIdentity = (
    input: SentTurn,
    conversationId: string,
    placement: { readonly isolated: boolean; readonly runner: string | undefined },
): BeginTurn => ({
    conversationId,
    isolated: placement.isolated,
    ...opt("runner", placement.runner),
    prompt: input.prompt,
    profile: profileOf(input),
    byPerson: input.byPerson,
    ...opt("title", input.title),
    ...opt("origin", input.origin),
    ...opt("startedBy", input.actor),
    ...opt("owner", input.owner),
    ...opt("areas", input.areas),
    ...opt("startIn", input.startIn),
    // A fork names its source once; `keep` is the cut's index in the source's own record.
    ...(input.forkOf !== undefined ? { forkedFrom: { conversationId: input.forkOf.conversationId, index: input.forkOf.keep, files: input.forkOf.files } } : {}),
});

const REFUSED: { readonly [R in BeginRefusal]: string } = {
    busy: "This agent is already running a turn, wait for it to finish.",
    archived: "This conversation is archived: only a person's message reopens it.",
};

// What a turn whose `begin` was refused says to whoever folds its frames; `agent-busy` is the one refusal with a code.
export function* refusedBegin(refusal: BeginRefusal): Generator<AgentEvent> {
    yield refusal === "busy" ? { kind: "error", code: "agent-busy", message: REFUSED.busy } : { kind: "error", message: REFUSED.archived };
    yield { kind: "done" };
}

// This turn's before-state, as a branch commit: recorded for a reopened tab and framed for the live one, under the same
// id agent-transcript.ts synthesizes for both. Best-effort; nothing pinned means no frame.
export async function* anchorIsolatedTurn(
    deps: Pick<Services, "agentWorktrees" | "logger" | "turnCheckpoints">,
    conversationId: string,
    repos: readonly { readonly repo: string; readonly base: string }[],
    turn: SnapshotTurn,
): AsyncGenerator<AgentEvent> {
    const anchored = await checkpointWorktree(deps, conversationId, repos);
    if (anchored.length === 0) {
        return;
    }
    await deps.turnCheckpoints
        .record(turn.conversationId, turn.index, { kind: "worktree", repos: anchored })
        .catch((error: unknown) => deps.logger.warn({ err: error }, "anchors: recording the turn's commits failed"));
    yield { kind: "checkpoint", id: `worktree:${turn.index}`, index: turn.index };
}

// Everything the end-of-turn pass does except land on the main tree, for a turn that skipped that pass: in `measure`
// mode, and never fatal, since this runs after the turn has already ended.
export const settleLandBooks = async (
    deps: Pick<Services, "agents" | "conversations" | "perf" | "agentWorktrees" | "logger">,
    conversationId: string,
): Promise<void> => {
    const entry = deps.agents.entry(conversationId);
    if (entry === undefined || !isIsolated(entry)) {
        return;
    }
    try {
        const measured = await deps.conversations.withLandLease(conversationId, () =>
            deps.perf.track("agent.land", { id: conversationId, mode: "measure", span: "outstanding" }, () => landAgent(deps.agentWorktrees, entry, "measure")),
        );
        reportLockfileFailures(deps.logger, conversationId, measured);
        if (measured.changed) {
            await deps.agents.recordLanded(conversationId, measured);
        }
    } catch (error) {
        deps.logger.warn({ err: error, id: conversationId }, "agents: settling an ended turn's land books failed");
    }
};

// The main tree: the body announces its own checkpoint, and there is no branch to land or books to settle.
export const mainTreePlacement = (body: () => AsyncIterable<AgentEvent>): Placement => ({
    // oxlint-disable-next-line require-yield -- A placement with nothing to announce hands its body over at once.
    async *open () {
        return body();
    },
    async *land () {},
    close: async () => {},
    settled: () => {},
    thrown: "agent turn failed",
});

// A runner: this sandbox's worktree is a mirror for diff, standing and land, anchored here for a rewind, and settled
// whatever the remote turn said, since the mirror is what the runner delivered.
export const runnerPlacement = (
    deps: Pick<Services, "agents" | "conversations" | "perf" | "agentWorktrees" | "logger" | "turnCheckpoints">,
    turn: { readonly conversationId: string; readonly snapshot: SnapshotTurn; readonly runner: string },
    steps: {
        // Composes the mirror with the same decision a local turn makes.
        readonly compose: () => Promise<ConversationWorktree>;
        readonly dispatch: (worktree: ConversationWorktree) => AsyncIterable<AgentEvent>;
    },
): Placement => ({
    async *open () {
        const worktree = await steps.compose();
        const root = worktree.repos.find((repo) => repo.repo === "root") ?? worktree.repos[0];
        yield { kind: "worktree", branch: worktree.branch, base: (root?.base ?? "").slice(0, 7), remote: turn.runner };
        yield* anchorIsolatedTurn(deps, turn.conversationId, worktree.repos, turn.snapshot);
        return steps.dispatch(worktree);
    },
    async *land () {},
    close: () => settleLandBooks(deps, turn.conversationId),
    settled: () => {},
    thrown: "the remote turn failed",
});
