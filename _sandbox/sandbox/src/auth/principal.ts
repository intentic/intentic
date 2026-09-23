import type { ControlScope, SessionOwner } from "@intentic/sandbox-contract";
import type { Caller } from "./auth.js";

// Who a non-bearer caller is, when the grant that admitted it can say: the per-boot secrets name a process, not a
// party.
// A control token is minted by a person and handed to one program, so it can be attributed (activity log rows, fleet
// card provenance).
export interface ControlPrincipal {
    readonly kind: "control";
    readonly id: string;
    readonly label: string;
    readonly scope: ControlScope;
}

export type Principal = ControlPrincipal;

/* WHO ASKED FOR A TURN, as the daemon verified it, never as the client said it (TurnInput, seams/turn-starter.ts). */

// The one-line name a caller signs a turn with: a member's email, else the principal's label, prefixed so a token
// labeled like an email can't read as the person.
export const actorOf = (identity: Caller | undefined, principal: Principal | undefined): string | undefined =>
    identity?.email ?? (principal === undefined ? undefined : `token:${principal.label}`);

// A signed-in member owns what they start; a program (a control token) owns nothing, so its conversations stay
// claimable.
export const ownerOf = (identity: Caller | undefined): Pick<SessionOwner, "email" | "name"> | undefined =>
    identity === undefined ? undefined : { email: identity.email, ...(identity.name !== undefined ? { name: identity.name } : {}) };

// The fence a conversation is born with, from whoever opened it. Undefined for an unfenced member and for a program's
// wake, which is the whole workspace; a fenced member hands over exactly the areas they hold.
export const areasOf = (identity: Caller | undefined): readonly string[] | undefined => identity?.areas;

// A child's starter names its parent conversation, prefixed like a token's so an id can never read as a person.
const CHILD_PREFIX = "agent:";
export const childActor = (parentConversationId: string): string => `${CHILD_PREFIX}${parentConversationId}`;
export const parentOfActor = (actor: string | undefined): string | undefined =>
    actor !== undefined && actor.startsWith(CHILD_PREFIX) && actor.length > CHILD_PREFIX.length ? actor.slice(CHILD_PREFIX.length) : undefined;
