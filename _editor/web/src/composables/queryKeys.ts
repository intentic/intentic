import { sandboxKey } from "./sandbox/activeSandbox";

/* EVERY CACHE KEY'S PATH, WRITTEN DOWN ONCE.
 *
 * A vue-query key is a path, and until this file the paths were written twice: once where the query registers
 * (`sandboxKey('git','changes')`) and again, as a bare literal, wherever something invalidated it
 * (`['git','changes']`). Twenty-odd such literals were spread over six files. Nothing held the two spellings
 * together, and the drift they hide is invisible at the call site — a key that matches nothing invalidates
 * nothing, and the screen simply keeps showing what it had.
 *
 * THE SECOND PROBLEM IS BLAST RADIUS, and it is the one that made this worth doing. `sandboxKey` APPENDS the
 * active sandbox id (useSandbox), so `['git','changes']` and `sandboxKey('git','changes')` are not two
 * spellings of one thing: the first is a prefix that matches EVERY sandbox's changes, the second only the
 * active one's. Both were in use, neither was labelled, and no reader could tell which a given call meant to
 * do — or whether the difference had been noticed at all.
 *
 * So a family answers both, by name. `.of(...)` is this sandbox's exact key — what a query registers under and
 * what a targeted invalidation names. `.every` is the broad prefix that reaches across sandboxes, and spelling
 * it out is the point: it becomes a deliberate choice rather than the shorter literal someone happened to type.
 *
 * WHAT DOES NOT LIVE HERE: the state a key is scoped BY, and the types that describe it. A family is a path
 * and nothing else, so this file imports one function and nothing else — a registry that reached for the app's
 * refs would pull the app in behind it, and every module would then import the app to name a key. Composed
 * sub-keys (one file's diff under its change list, one skill's body under its skill list) therefore stay with
 * the code that reads them and are BUILT from a family here.
 *
 * queryKeys.guard.test.ts is what keeps this the only source: it fails on an array literal handed to a
 * queryKey, and on any use of `sandboxKey` outside this file. */

/* One family of cache entries.
 *
 * `of(...variant)` is the key a query registers under, scoped to the active sandbox so switching sandboxes
 * never serves the previous one's data. A variant segment (the focused scope of a tree, the agent a diff
 * belongs to) lands BEFORE the appended sandbox id, so each variant is its own entry and `of()` with no
 * variant does NOT reach the others — `every` is what does.
 *
 * `every` is the bare path: it prefix-matches the family across every variant AND every sandbox this browser
 * has cached. Wider than most callers want, and named so that choosing it is visible.
 *
 * A sub-entry filed under a family — one file's diff under its change list — appends AFTER the family's key
 * (`[...GIT_CHANGES.of(), UNPERSISTED, …]`) rather than passing extra segments to `of`. That is what makes a
 * prefix match on `of()` reach it, which is how invalidating a list drops the per-item reads it introduced. */
export interface QueryFamily {
    readonly of: (...extra: readonly unknown[]) => unknown[];
    readonly every: readonly string[];
}

const family = (...path: readonly string[]): QueryFamily => ({
    of: (...extra) => sandboxKey(...path, ...extra),
    every: path,
});

/* THE ONE KEY THAT IS NOT HERE is the sandbox list itself (`["sandbox","list"]`, useSandbox). It is the
 * registry of ALL sandboxes rather than data from one, so it is not sandbox-scoped and has no family — and
 * moving it would close the import loop this file deliberately leaves open: useSandbox writes that key while
 * its own module body runs, so it must not have to wait on a module that is waiting on it. The guard test
 * names useSandbox as the one exemption for that reason. */

// ---- workspace ----

export const WORKSPACE_TREE = family(`workspace`, `tree`);
export const WORKSPACE_MODULES = family(`workspace`, `modules`);
export const WORKSPACE_STATE = family(`workspace`, `state`);
export const WORKSPACE_APPS = family(`workspace`, `apps`);
export const WORKSPACE_HEALTH = family(`workspace`, `health`);
export const WORKSPACE_SEARCH = family(`workspace`, `search`);
export const HISTORY_SNAPSHOTS = family(`history`, `snapshots`);

// ---- git ----

export const GIT_CHANGES = family(`git`, `changes`);
export const GIT_LOG = family(`git`, `log`);
export const GIT_REPOS = family(`git`, `repos`);

// ---- agents ----

export const AGENTS = family(`agents`);
export const SESSIONS = family(`sessions`);
export const SUBAGENTS = family(`subagents`);
export const SUBAGENT_TRANSCRIPT = family(`subagent-transcript`);

/* NOT SANDBOX-SCOPED, and that is the daemon's decision rather than an omission. These three are pushed by
 * name: a write to `.intentic/records/workflow-runs.json` carries `invalidates: ["workflows","workflow-runs"]` from
 * the contract's WORKSPACE_STATE_FILES, and systemEvents invalidates that bare name. The query therefore
 * registers under the same bare name — a scoped key would still be reached by the push (the name is its
 * prefix), but the two spellings would no longer be one fact, which is what this file exists to prevent.
 *
 * They are `.every` of a family rather than a loose literal so the contract cross-check in the guard test can
 * find them the same way it finds every other name the daemon can push. */
export const WORKFLOW_RUNS = family(`workflow-runs`);
export const WORKFLOW_DESIGNS = family(`workflows`);
export const LOOP_DESIGNS = family(`loop-designs`);

/* ---- the signed-in ACCOUNT, which is not a sandbox --------------------------------------------------------
 *
 * The membership and its credit meter belong to the person, not to the box they happen to be looking at: one
 * allowance is spent by every sandbox they own, and the platform keys it by user. So this registers under
 * `.every` — the bare path — for a different reason to the three above. Scoped, it would cache a separate copy
 * per sandbox and show a switcher's worth of disagreeing balances, and a spend made in one would leave the
 * others reading the pre-spend figure until something else evicted them. */
export const MEMBERSHIP = family(`membership`);

// ---- sandbox surfaces ----

export const BROWSERS = family(`browsers`);
export const BUNDLE_EXPORTS = family(`bundle-exports`);
export const CAPABILITIES = family(`capabilities`);
export const COMPUTERS = family(`computers`);
export const DEPLOYMENTS = family(`deployments`);
export const ENVIRONMENT = family(`environment`);
export const ENVIRONMENT_CONTENTS = family(`environment-contents`);
export const EXTENSIONS = family(`extensions`);
export const INVENTORY = family(`inventory`);
export const MANIFESTS = family(`manifests`);
export const PANELS = family(`panels`);
export const PERSONAS = family(`personas`);
export const PORTS = family(`ports`);
/* SHARED WITH THE PREVIEW EXTENSION, deliberately and by exact path. That extension's manifest binds `public/`
 * to the name `public` (contributes.files), which is what makes a write into the outbox refresh its view
 * without a clock. `family("public").of()` and its `api.key("public")` produce the identical key, so the
 * first-run screen's read of the same route rides the same push — rather than growing a second key for one
 * directory, which the daemon would then have to be taught to invalidate twice. */
export const PUBLIC = family(`public`);
export const REGISTRY = family(`registry`);
export const RULE_FIRINGS = family(`rule-firings`);
export const SANDBOX_INFO = family(`info`);
export const SANDBOX_SETTINGS = family(`settings`);
export const SANDBOX_SAVINGS = family(`settings-savings`);
export const SECRETS = family(`secrets`);
export const SECRETS_INVENTORY = family(`secrets`, `inventory`);
export const SKILLS = family(`skills`);
export const SYNC_HEALTH = family(`sync-health`);
export const TERMINALS = family(`terminals`);
export const USAGE_ROLLUP = family(`usage-rollup`);
export const VPN = family(`vpn`);
