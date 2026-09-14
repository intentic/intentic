import type { AgentTurn } from "@intentic/sandbox-contract";
import type { Caller } from "../../../auth/auth.js";
import { type Principal, principalActor } from "../../../auth/principal.js";

/* WHO ASKED FOR THIS TURN, as the daemon verified it, never as the client said it. */
export type TurnInput = AgentTurn & { readonly actor?: string };

export const actorOf = (identity: Caller | undefined, principal: Principal | undefined): string | undefined =>
    identity?.email ?? (principal === undefined ? undefined : principalActor(principal));
