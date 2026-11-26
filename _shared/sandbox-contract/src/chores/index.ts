/**
 * @deprecated FROZEN (2026-11-26). The chore book, its probes and its verdicts belong to the maintenance extension
 * (intentic/extension-maintenance, `src/chores/`), whose views and backend read only its own copy since its probes left
 * the daemon. This subpath stays, unchanged, only because the extension wire records it (EXTENSION_WIRE in
 * @intentic/extension-api, `wireExports` in its surface.json) and a wire subpath leaves only in a major: it is removed
 * at extension API 3.0.0. Change nothing here; nothing in the daemon or the editor imports it. `composeAsk`,
 * `updateBrief` and the workspace-root exclusion live in `briefs/agent-ask.ts`, `briefs/extension-update-brief.ts` and
 * `policy/shell/workspace-root-exclude.ts`, and are re-exported here for the same reason. The demo's fixture
 * (`_site/demo/src/fixture/chores.ts`) is its last reader in this repository, until the demo vendors a maintenance that
 * carries its own book.
 */
export { CHORE_KINDS, CHORES, choreAutomationPrompt, choreById, chorePrompt, repoLabel, repoName } from "./chores.js";
export type { Chore, ChoreContext, ChoreFinding, ChoreKind, ChoreKindSpec, ChoreStance } from "./chores.js";
export { bucketOf, digestOf } from "./digest.js";
export { CHORE_INVARIANTS, composeAsk, REPORT_INVARIANTS, TRIAGE_NOTE } from "./prompt.js";
export type { Ask } from "./prompt.js";
export { updateBrief } from "../briefs/extension-update-brief.js";
export type { UpdateBrief } from "../briefs/extension-update-brief.js";
export { PROBES, probeSpec } from "./probes.js";
export type { ProbeSpec } from "./probes.js";
export { WORKSPACE_ROOT_EXCLUDE_ENV } from "./workspace-scope.js";
export { componentStem, frameworksOf, IDIOM_RULES, idiomRule, normalizePath, UI_FRAMEWORKS, usesTailwind } from "./stack.js";
export type { IdiomRule, UiFramework } from "./stack.js";
export { assessChore, assessReport, choreAnswer, choreAnswered, ledgerKey, unseenVerdicts } from "./verdict.js";
export type { ChoreAnswer, ChoreState, ChoreVerdict } from "./verdict.js";
