import { join } from "node:path";
import type { CompositionCore } from "../composition.js";
import { defineSlice } from "../seams/slice.js";
import { approvalsDocument, type ApprovalsStore, fileApprovalsStore } from "./approvals-store.js";

export interface ApprovalsSlice {
    // Things the agent prepared and may not do unasked; /approvals is the owner's approve/reject side.
    readonly approvals: ApprovalsStore;
}

export const approvalsSlice = defineSlice<ApprovalsSlice>({
    build: ({ workspace }: Pick<CompositionCore, "workspace">) => ({ approvals: fileApprovalsStore(join(workspace.root, approvalsDocument.path)) }),
});
