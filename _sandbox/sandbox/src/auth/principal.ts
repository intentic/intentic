import type { ControlScope } from "@intentic/sandbox-contract";

/* WHO A NON-BEARER CALLER IS, when the grant that admitted it can say.
 *
 * The bearer middleware verifies a PERSON and stashes a Caller (auth.ts); the grant loop admits a PROGRAM and
 * used to stash nothing, each grant acting as "the owner's tool". For the per-boot secrets that is the truth:
 * the panel token and the agent token name a process, not a party. A control token is different, it was minted
 * by a person, given a label, and handed to one program, so a request it admits CAN be attributed, and the two
 * places that read attribution (the activity log's rows, the fleet card's provenance) are exactly where "which
 * token started this" is the question somebody asks after a surprise. */
export interface ControlPrincipal {
    readonly kind: "control";
    readonly id: string;
    readonly label: string;
    readonly scope: ControlScope;
}

export type Principal = ControlPrincipal;

// The one-line name a principal signs its work with, in the shape the actor field carries beside a member's
// email. Prefixed so a token called "alice@corp.com" can never read as the person.
export const principalActor = (principal: Principal): string => `token:${principal.label}`;
