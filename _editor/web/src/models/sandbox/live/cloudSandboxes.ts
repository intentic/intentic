import type { SandboxSummary } from "@intentic/api-contract";

const seenAt = (row: SandboxSummary): number => (row.lastSeenAt === null ? 0 : Date.parse(row.lastSeenAt) || 0);

// THE READER'S OWN CLOUD SANDBOXES: on a machine of ours (`hosted`), theirs, their container not reported removed. The
// cloud entry opens one rather than offering a second (router/hostedEntry.ts), and the add dialog names one when the
// free machine is already in use (features/setup/add/AddSandboxForm.vue). Newest check-in first: the one last used.
export const ownCloudSandboxes = (rows: readonly SandboxSummary[]): readonly SandboxSummary[] =>
    rows
        .filter((row) => row.tier === `owner` && (row.hosted ?? null) !== null && (row.removedAt ?? null) === null)
        .toSorted((a, b) => seenAt(b) - seenAt(a));

