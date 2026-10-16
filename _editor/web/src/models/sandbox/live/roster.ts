import type { SandboxSummary } from "@intentic/api-contract";

// The sandbox list is two lists: ones that have checked in (switchable) and ones that never have (unfinished, no daemon
// to select). `lastSeenAt` is the test, stamped once and never un-happening; a merely down sandbox keeps its stamp and
// stays switchable.
export const connectedSandboxes = (rows: readonly SandboxSummary[]): readonly SandboxSummary[] => rows.filter((entry) => entry.lastSeenAt !== null);

// Only the reader's own: finishing a setup means opening /setup on it, which resumes nothing but an owner's row and starts
// a fresh sandbox on the reader's account for anyone else's (setupArrival.ts `rowToOpen`). A shared sandbox its owner has
// not finished is not an errand its members can run.
export const unfinishedSandboxes = (rows: readonly SandboxSummary[]): readonly SandboxSummary[] =>
    rows.filter((entry) => entry.lastSeenAt === null && entry.role === `owner`);
