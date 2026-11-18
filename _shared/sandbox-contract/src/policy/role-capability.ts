// WHETHER A ROLE LETS A TURN ACT THROUGH ONE CONNECTED CAPABILITY. Pure and shared, because the daemon mounts a turn's
// tools on this answer (roles/roles.ts `turnRole`) and the Sandbox ▸ Map view draws who reaches what from it,
// and two implementations would disagree at exactly the boundary that matters.
// A card decides one thing about reach: which signed-in accounts it speaks through. Every other limit on a conversation
// wearing it (connectors, devices, servers, shelves, folders) is an access profile that lists the card
// (schemas/access-profiles.ts `roles`), held in the principal chain like a person's or a service's.

// The two fields of a connection the rule reads; structural, so neither side has to hand over its own record type.
export interface CapabilityRef {
    readonly id: string;
    readonly kind: string;
}

/**
 * The kinds that are someone signed in: a site account, the identity whose browser holds every account born of it, and
 * the owner's own browser (its extension), which holds every session they have. The last one was missing until
 * 2026-10-25, and it fell through to "passes untouched": an X-only role's unattended run reached the owner's Brave,
 * and an unpinned wake that lost every sandbox account kept it.
 */
export const isSignedInAccount = (kind: string): boolean => kind === "browser" || kind === "identity" || kind === "webext";

/**
 * Whether a role speaking through these accounts (its `capabilities`) may act through a capability. Granting an
 * account (`reddit-work`) grants its hands; granting the identity itself grants the someone. The owner's own browser is
 * named the same way: a role reaches it only when its list says so. Every other kind passes here and is decided by
 * access.
 */
export const roleAllowsCapability = (capability: CapabilityRef, accounts: readonly string[]): boolean =>
    !isSignedInAccount(capability.kind) || accounts.includes(capability.id);
