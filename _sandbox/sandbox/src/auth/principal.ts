import type { ControlScope } from "@intentic/sandbox-contract";

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

// The one-line name a principal signs its work with; prefixed so a token labeled like an email can't read as the
// person.
export const principalActor = (principal: Principal): string => `token:${principal.label}`;
