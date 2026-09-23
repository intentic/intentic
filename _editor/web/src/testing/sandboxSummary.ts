import type { SandboxSummary } from "@intentic/api-contract";

// A registry row as the platform lists it: an owner's sandbox that has never run, named after its id, with every field
// a suite does not name at its empty value.
export const sandboxSummary = (over: Partial<SandboxSummary> & Pick<SandboxSummary, `id`>): SandboxSummary => ({
    name: over.id,
    image: null,
    daemonUrl: null,
    lastSeenAt: null,
    setupCodeClaimedAt: null,
    setupReport: null,
    bootReport: null,
    announceRefusal: null,
    removedAt: null,
    removedBy: null,
    token: `token-${over.id}`,
    role: `owner`,
    providedAddress: false,
    localHostname: null,
    hosted: null,
    ...over,
});
