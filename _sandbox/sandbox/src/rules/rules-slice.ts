import { join } from "node:path";
import type { CompositionCore } from "../composition.js";
import { defineSlice } from "../seams/slice.js";
import { fileRuleFiringsStore, ruleFiringsDocument, type RuleFiringsStore } from "./rule-firings.js";

export interface RulesSlice {
    // When each rule last fired; kept beside settings, not in them, so a firing isn't a config write.
    readonly ruleFirings: RuleFiringsStore;
}

export const rulesSlice = defineSlice<RulesSlice>({
    build: ({ workspace }: Pick<CompositionCore, "workspace">) => ({
        ruleFirings: fileRuleFiringsStore(join(workspace.root, ruleFiringsDocument.path)),
    }),
});
