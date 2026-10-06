import type { ExtensionSummary } from "@intentic/sandbox-contract";

// Which build of an extension a browser holds, as the list names it: the pinned commit, or, for an install running from
// its source checkout, the fingerprint of the bundle served from there. The loader records it per load and the
// Extensions tab compares it with the list's, so a rebuilt checkout offers the same reload an update does. A held
// checkout carries no fingerprint: the pinned commit is what runs, and what it reads as.
export const codeRevisionOf = (summary: Pick<ExtensionSummary, "commit" | "dev">): string => summary.dev?.revision ?? summary.commit;
