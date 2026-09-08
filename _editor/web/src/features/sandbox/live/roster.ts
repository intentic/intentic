import type { SandboxSummary } from "@intentic/api-contract";

// The sandbox list is two lists: ones that have checked in (switchable) and ones that never have (unfinished, no daemon
// to select). `lastSeenAt` is the test, stamped once and never un-happening; a merely down sandbox keeps its stamp and
// stays switchable.
export const connectedSandboxes = (rows: readonly SandboxSummary[]): readonly SandboxSummary[] => rows.filter((entry) => entry.lastSeenAt !== null);

export const unfinishedSandboxes = (rows: readonly SandboxSummary[]): readonly SandboxSummary[] => rows.filter((entry) => entry.lastSeenAt === null);
