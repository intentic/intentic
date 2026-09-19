import type { AgentTurn, SessionOwner } from "@intentic/sandbox-contract";
import type { Caller } from "../../../auth/auth.js";
import { type Principal, principalActor } from "../../../auth/principal.js";

/* WHO ASKED FOR THIS TURN, as the daemon verified it, never as the client said it. */
export type TurnInput = AgentTurn & {
    readonly actor?: string;
    // The member the conversation belongs to if this turn is its first; `since` is the registry's to stamp.
    readonly owner?: Pick<SessionOwner, "email" | "name">;
};

export const actorOf = (identity: Caller | undefined, principal: Principal | undefined): string | undefined =>
    identity?.email ?? (principal === undefined ? undefined : principalActor(principal));

// A signed-in member owns what they start; a program (a control token) owns nothing, so its conversations stay
// claimable.
export const ownerOf = (identity: Caller | undefined): Pick<SessionOwner, "email" | "name"> | undefined =>
    identity === undefined ? undefined : { email: identity.email, ...(identity.name !== undefined ? { name: identity.name } : {}) };

// A child's starter names its parent conversation, prefixed like a token's so an id can never read as a person.
const CHILD_PREFIX = "agent:";
export const childActor = (parentConversationId: string): string => `${CHILD_PREFIX}${parentConversationId}`;
export const parentOfActor = (actor: string | undefined): string | undefined =>
    actor !== undefined && actor.startsWith(CHILD_PREFIX) && actor.length > CHILD_PREFIX.length ? actor.slice(CHILD_PREFIX.length) : undefined;
