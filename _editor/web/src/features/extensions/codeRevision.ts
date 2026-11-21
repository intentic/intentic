import type { ExtensionSummary } from "@intentic/sandbox-contract/schemas/extension-updates";

// Which build of an extension a browser holds, as the list names it: the pinned commit, or, for an install running from
// its source checkout, the fingerprint of the bundle served from there. The loader records it per load and the
// Extensions tab compares it with the list's, so a rebuilt checkout offers the same reload an update does. A held
// checkout carries no fingerprint: the pinned commit is what runs, and what it reads as. A folder written in the workspace
// has no commit (it reads "workspace"): its `revision`, a fingerprint of its declaration and bundle, moves instead.
export const codeRevisionOf = (summary: Pick<ExtensionSummary, "commit" | "dev" | "revision">): string =>
    summary.dev?.revision ?? summary.revision ?? summary.commit;
