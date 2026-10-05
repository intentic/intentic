import type { ConversationActors } from "../../conversations/actor/conversation-actors.js";
import type { Holding } from "../../conversations/actor/conversation-holdings.js";

// A conversation leaving the board (archived by hand, by the board's Clear, by the aged sweep or a vanished checkout;
// purged; discarded) takes the work of the children it spawned with it: their running turns stop and the re-runs the
// sandbox booked for them are dropped, so nothing goes on working for a parent that will never read it, and nothing
// starts again by itself. Their conversations stay, with whatever they wrote. The decisions are here; children.ts
// carries them out through the cancel tool's own path (cancelFamily).

/** Why a family ends. */
export type FamilyEnd = "archived" | "purged" | "discarded";

/** One edge of the spawn tree: a conversation and the one that spawned it. */
export interface FamilyLink {
    readonly child: string;
    readonly parent: string;
}

/**
 * Every conversation below `heads` in the spawn tree, nearer generations first, each once with the parent it hangs from.
 * The heads are not in it, even where one spawned another: each leaves on its own account. A grandchild is in it, since
 * a child stopped while its own children work on would be woken again by their reports.
 */
export const descendantsOf = (heads: readonly string[], links: Iterable<FamilyLink>): FamilyLink[] => {
    const childrenOf = new Map<string, string[]>();
    for (const { child, parent } of links) {
        childrenOf.set(parent, [...(childrenOf.get(parent) ?? []), child]);
    }
    const seen = new Set(heads);
    const found: FamilyLink[] = [];
    for (let generation = [...seen]; generation.length > 0;) {
        const next: string[] = [];
        for (const parent of generation) {
            for (const child of childrenOf.get(parent) ?? []) {
                if (!seen.has(child)) {
                    seen.add(child);
                    found.push({ child, parent });
                    next.push(child);
                }
            }
        }
        generation = next;
    }
    return found;
};

/**
 * What a child stands on as its family ends: one this daemon supervises (its spawn record, which dies with the daemon), or
 * one it lost track of across a restart, read off its conversation alone. For the latter, `sandboxRun` is a live turn
 * nobody started in its own chat, and `bookedRerun` a re-run booked for a turn nobody started there.
 */
export type ChildStanding =
    | { readonly tracked: true; readonly heldForOwner: boolean; readonly paused: boolean; readonly running: boolean }
    | { readonly tracked: false; readonly sandboxRun: boolean; readonly bookedRerun: boolean };

/** What stopping one child takes: the cancel tool's own path, its live turn stopped and its booking dropped, or nothing. */
export type CancelMove =
    { readonly kind: "cancel" } | { readonly kind: "halt"; readonly stop: boolean; readonly drop: boolean } | { readonly kind: "none" };

/**
 * A supervised child is cancelled as its parent's cancel would: a running turn, a start still waiting, a booked re-run.
 * A start or message waiting on the owner's card is theirs to decline, as the cancel tool says, and a finished child needs
 * nothing. A child without a record has the sandbox's turn and booking stopped; a person's own turn in its chat stays
 * theirs, as a supervised child's does.
 */
export const cancelMoveFor = (standing: ChildStanding): CancelMove => {
    if (standing.tracked) {
        return !standing.heldForOwner && (standing.paused || standing.running) ? { kind: "cancel" } : { kind: "none" };
    }
    return standing.sandboxRun || standing.bookedRerun ? { kind: "halt", stop: standing.sandboxRun, drop: standing.bookedRerun } : { kind: "none" };
};

/** One child to stop, and how. */
export interface FamilyCancel extends FamilyLink {
    readonly move: Exclude<CancelMove, { readonly kind: "none" }>;
}

/** Which of a family's members to stop, and how, as each stands when the cancel runs; nearer generations first. */
export const familyCancels = (members: readonly FamilyLink[], standingOf: (child: string) => ChildStanding): FamilyCancel[] =>
    members.flatMap((member) => {
        const move = cancelMoveFor(standingOf(member.child));
        return move.kind === "none" ? [] : [{ ...member, move }];
    });

// A conversation whose children were just stopped because a conversation above it left. The endings of those stopped
// turns arrive in the moments after and are news for nobody; said to it, they would wake it into a turn of its own.
// Held by the conversation, so its dispose takes it, and stamped, so it lapses instead of swallowing the report of work
// somebody starts there later.
const FAMILY_ENDED: Holding<number> = { name: "family ended" };
const FAMILY_ENDED_MS = 2 * 60_000;

/** Marks a conversation still on the board whose children a family's end just stopped. */
export const markFamilyEnded = (actors: Pick<ConversationActors, "holdings">, conversationId: string, now: number): void => {
    actors.holdings(FAMILY_ENDED).hold(conversationId, conversationId, now);
};

/** Whether a child's ending reaching this conversation now is one a family's end stopped (child-report.ts). */
export const familyEnded = (actors: Pick<ConversationActors, "holdings">, conversationId: string, now: number): boolean => {
    const at = actors.holdings(FAMILY_ENDED).get(conversationId);
    return at !== undefined && now - at < FAMILY_ENDED_MS;
};
