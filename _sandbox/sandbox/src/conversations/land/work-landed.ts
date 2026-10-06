import type { Services } from "../../composition.js";
import { awaitingWake } from "../actor/conversation-state.js";
import { endingStatus, reposOf, worktreeOf } from "../registry/agents-store.js";

// A message booked to go after another conversation's work (AgentTurn.sendAfter) waits on two readings of that other
// conversation, both made here: whether it can be waited for at all, asked once at the booking, and whether its work
// is in the workspace now, asked at the booking and by every resume pass after it (turn-resume.ts, releaseBooked).
// Read from what the daemon holds, never from an event: a pass after a restart reads the same answer a live one would.

type Readers = Pick<Services, "agents" | "conversations">;

/**
 * Why conversation `waiter` cannot wait for conversation `id`, or undefined when it can: one that does not exist, is
 * archived (nothing of it will land), is a spawned child (whose work lands into the agent that started it rather than
 * the workspace, which is the agent to wait for instead), or itself waits for `waiter`, so neither would ever go.
 */
export const unwaitable = (services: Pick<Services, "agents" | "conversations">, id: string, waiter: string): string | undefined => {
    const entry = services.agents.entry(id);
    if (entry === undefined) {
        return `there is no conversation "${id}" to wait for`;
    }
    if (entry.archivedAt !== undefined) {
        return "that conversation is archived, so nothing of it will land";
    }
    if (worktreeOf(entry)?.parent !== undefined) {
        return "that agent's work lands into the agent that started it: wait for that one instead";
    }
    // Any message of its booked for after the asker's work: each message carries its own booking.
    if (services.conversations.queued(id).items.some((item) => item.after?.conversationId === waiter)) {
        return "that conversation already waits for this one's work: one of the two has to go first";
    }
    return undefined;
};

// When work of this conversation last reached the workspace (ms), or 0 for never: a land into a parent's checkout is not
// the workspace, and a workspace conversation has no land of its own.
const landedAt = (entry: NonNullable<ReturnType<Services["agents"]["entry"]>>): number =>
    worktreeOf(entry)?.landedInto === undefined ? Math.max(0, ...reposOf(entry).map((repo) => repo.landedAt ?? 0)) : 0;

/**
 * Whether conversation `id` has finished and all of its work is in the workspace, so what waits for it may go. Nothing
 * running, held or armed to run again by itself, and nothing of its own still waiting to go; nothing left on its branch
 * to land and no land standing broken; and its last turn ended clean, or work of its landed after `since` (the booking):
 * a person landing what a stopped or failed turn left is that work being in, but a failure nobody acted on is not. A
 * conversation that is gone or archived never reads as landed: what waits on it is the person's to send or take back.
 */
export const workLanded = (services: Readers, id: string, since: number): boolean => {
    const entry = services.agents.entry(id);
    if (entry === undefined || entry.archivedAt !== undefined) {
        return false;
    }
    const state = services.conversations.state(id);
    if (state !== undefined && (state.phase.kind !== "idle" || state.turn.resuming || state.turn.landing || awaitingWake(state))) {
        return false;
    }
    if (services.conversations.queued(id).items.length > 0) {
        return false;
    }
    const standing = services.agents.standingOf(id);
    if (standing === "ready" || standing === "conflict") {
        return false;
    }
    if (entry.landing.failure !== undefined && entry.landing.failure.check !== true) {
        return false;
    }
    return endingStatus(entry.ending) === "idle" || landedAt(entry) > since;
};

/** The repositories a conversation's work lands in, whose version commits a follow-up waits for before it starts. */
export const landingRepos = (services: Pick<Services, "agents">, id: string): readonly string[] => {
    const entry = services.agents.entry(id);
    return entry === undefined ? [] : reposOf(entry).map((repo) => repo.repo);
};
