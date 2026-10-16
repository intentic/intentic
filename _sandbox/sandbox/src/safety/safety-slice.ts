import { join } from "node:path";
import type { CompositionCore } from "../composition.js";
import { defineSlice } from "../seams/slice.js";
import { fileSafetyLog, type SafetyLog, safetyLogDocument } from "./safety-log.js";

export interface SafetySlice {
    // What the safety judge decided; the policy it is handed is a document, this log changes mid-turn.
    readonly safetyLog: SafetyLog;
}

export const safetySlice = defineSlice<SafetySlice>({
    build: ({ workspace }: Pick<CompositionCore, "workspace">) => ({ safetyLog: fileSafetyLog(join(workspace.root, safetyLogDocument.path)) }),
});
