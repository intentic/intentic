import type { CrossesOrg } from "@intentic/sandbox-contract/sandbox-pass";

// Which organisations a pass crosses (docs/architecture/account-routing.md): allowed, and said, so the receiver can label
// what came across the line (2026-11-24, the owner's call). Undefined when both sandboxes sit in the same organisation, or
// both in none.

type OrgSide = { readonly id: string; readonly name: string } | null;

export const orgCrossing = (from: OrgSide, to: OrgSide): CrossesOrg | undefined => {
    if ((from?.id ?? null) === (to?.id ?? null)) {
        return undefined;
    }
    if (from !== null && to !== null) {
        return { from, to };
    }
    if (from !== null) {
        return { from };
    }
    return to === null ? undefined : { to };
};

