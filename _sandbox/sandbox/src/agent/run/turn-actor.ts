import type { AgentTurn } from "@intentic/sandbox-contract";
import type { Caller } from "../../auth/auth.js";
import { type Principal, principalActor } from "../../auth/principal.js";

/* WHO ASKED FOR THIS TURN, as the daemon verified it, never as the client said it.
 *
 * `AgentTurn` is the wire shape a client sends, and everything on it is the client's word. The actor cannot be:
 * a collaborator naming themselves as somebody else on the audit trail is the exact claim the trail exists to
 * refute. So it rides beside the wire shape rather than inside it, added by the route handler from the identity
 * or principal the middleware established for that request (context.ts), and readable by the turn machinery
 * downstream because a TurnInput is an AgentTurn with one more optional field. A wake with no request behind it
 * (a schedule, a listener, a boot-time resume) carries no actor; its provenance is its origin. */
export type TurnInput = AgentTurn & { readonly actor?: string };

export const actorOf = (identity: Caller | undefined, principal: Principal | undefined): string | undefined =>
    identity?.email ?? (principal === undefined ? undefined : principalActor(principal));
