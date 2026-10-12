import { memoryOwnerGrants } from "../personas/owner-grants.js";
import type { OwnerApprovals, StandingGrantsDeps } from "./standing-grants.js";

// No hook set and no extension approved, and nothing to take back: what a suite about conversation grants stands on.
export const NO_APPROVALS: OwnerApprovals = {
    hookSets: async () => ({ sets: [], unreadable: false }),
    revokeHookSet: async () => false,
    extensions: async () => ({ extensions: [], unreadable: false }),
    revokeExtension: async () => false,
};

// The list's dependencies with the owner-wide halves empty unless the suite names them.
export const standingDeps = (
    parts: Pick<StandingGrantsDeps, "conversationGrants" | "credentialGrants"> & { readonly ownerGrants?: StandingGrantsDeps["ownerGrants"]; readonly approvals?: OwnerApprovals },
): StandingGrantsDeps => ({
    conversationGrants: parts.conversationGrants,
    credentialGrants: parts.credentialGrants,
    ownerGrants: parts.ownerGrants ?? memoryOwnerGrants(),
    approvals: parts.approvals ?? NO_APPROVALS,
});
