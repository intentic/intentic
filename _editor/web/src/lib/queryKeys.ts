import { sandboxKey } from "../features/sandbox/overview/activeSandbox";

// Every cache key's path, written once: `sandboxKey` scopes to the active sandbox, so `.of()` is that sandbox's exact
// key and `.every` is the deliberate wider prefix across all sandboxes. Imports only `sandboxKey`, nothing
// app-specific, to avoid an import cycle; queryKeys.guard.test.ts enforces this as the only place a key is spelled.

// One family of cache entries: `of(...variant)` scopes the active sandbox (variant before the appended id); `every` is
// the deliberate wide prefix across variants and sandboxes; `ofSandbox` names one explicitly.
export interface QueryFamily {
    readonly of: (...extra: readonly unknown[]) => unknown[];
    readonly ofSandbox: (sandboxId: string, ...extra: readonly unknown[]) => unknown[];
    readonly every: readonly string[];
}

const family = (...path: readonly string[]): QueryFamily => ({
    of: (...extra) => sandboxKey(...path, ...extra),
    ofSandbox: (sandboxId, ...extra) => [...path, ...extra, sandboxId],
    every: path,
});

// The sandbox list itself (`["sandbox","list"]`, useSandbox) has no family here: it is the registry of all sandboxes,
// not data from one, and giving it one would close an import loop useSandbox needs open at module-init time.

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
// The same repos matched to their remotes; its own family because it costs a lookup per repo.
export const GIT_REMOTE_REPOS = family(`git`, `remote-repos`);

// ---- agents ----

export const AGENTS = family(`agents`);

// AGENTS.every would also catch transcripts (the expensive read) since the agent id sits mid-key; `matches` names every
// agent's diff precisely, and reaches the per-file diffs filed under it too.
const DIFF = `diff`;
export const AGENT_DIFF = {
    of: (agentId: string): unknown[] => AGENTS.of(agentId, DIFF),
    ofSandbox: (sandboxId: string, agentId: string): unknown[] => AGENTS.ofSandbox(sandboxId, agentId, DIFF),
    matches: (key: readonly unknown[]): boolean => key[0] === AGENTS.every[0] && key[2] === DIFF,
} as const;

// What one conversation was told before its own words; read only when a reader opens it, so it is never part of the
// transcript's own key.
export const AGENT_SYSTEM_PROMPT = family(`agent-system-prompt`);

export const SESSIONS = family(`sessions`);
export const SUBAGENTS = family(`subagents`);
export const SUBAGENT_TRANSCRIPT = family(`subagent-transcript`);

// Pushed by name from the daemon (WORKSPACE_STATE_FILES), so the query registers under that same bare name (`.every`)
// rather than a scoped key the guard test's cross-check would not recognize.
export const WORKFLOW_RUNS = family(`workflow-runs`);
export const WORKFLOW_DESIGNS = family(`workflows`);
export const LOOP_DESIGNS = family(`loop-designs`);

// The hosted plan belongs to the person, not the sandbox; keyed under `.every` since scoping it would cache a
// disagreeing copy per sandbox.
export const HOSTED_PLAN = family(`hosted-plan`);
// Deleted sandboxes still inside their recovery window. Account-wide like the sandbox list, never one box's data.
export const SANDBOX_TRASH = family(`sandbox-trash`);

// ---- sandbox surfaces ----

// Per-repo app lists (`of(repo)`); the daemon's runtime push invalidates the bare `apps` prefix on any dev-server
// change, reaching every per-repo variant at once.
export const APPS = family(`apps`);
export const BROWSERS = family(`browsers`);
export const BUNDLE_EXPORTS = family(`bundle-exports`);
export const CAPABILITIES = family(`capabilities`);
export const DEVICES = family(`devices`);
export const DEPLOYMENTS = family(`deployments`);
export const ENGINES = family(`engines`);
export const ENVIRONMENT = family(`environment`);
export const ENVIRONMENT_CONTENTS = family(`environment-contents`);
export const EXTENSIONS = family(`extensions`);
export const INVENTORY = family(`inventory`);
// What this machine can run locally: memory, GPU, and which curated models fit. Its own family, not part of
// CAPABILITIES, because it goes stale on a rebuild or a download rather than on the manifest changing.
export const LOCAL_MODEL_FIT = family(`local-model-fit`);
export const MANIFESTS = family(`manifests`);
export const PANELS = family(`panels`);
export const PERSONAS = family(`personas`);
export const PORTS = family(`ports`);
// The named parts of the workspace a member's access is granted in; the daemon invalidates this on an area write.
export const AREAS = family(`areas`);
// This sandbox's runners: the machines it can hand a conversation to.
export const RUNNERS = family(`runners`);
// Shared with the preview extension by exact path: its manifest binds `public/` to the name `public`, so
// `family("public").of()` and its `api.key("public")` produce the identical key and share one push.
export const PUBLIC = family(`public`);
export const REGISTRY = family(`registry`);
// What each repository declares for itself. Its own key rather than part of the settings: the declaration is a tracked
// file in the repository, so it changes with a commit or a pull, not only when somebody edits the settings.
export const REPO_CHECKS = family(`repo-checks`);
export const RULE_FIRINGS = family(`rule-firings`);
// Two keys, not one: the policy document changes at human speed, the log several times a turn, so sharing a key would
// refetch the text someone is editing on every judged command.
export const SAFETY_POLICY = family(`safety-policy`);
export const SAFETY_LOG = family(`safety-log`);
export const SANDBOX_INFO = family(`info`);
export const SANDBOX_SETTINGS = family(`settings`);
export const SANDBOX_SAVINGS = family(`settings-savings`);
export const SANDBOX_FIELD_NOTES = family(`settings-field-notes`);
// Seeds the background-rendering status; `derivedChanged` frames keep it current afterwards, so it is fetched once
// rather than polled.
export const DERIVED_STATUS = family(`derived-status`);
export const SECRETS = family(`secrets`);
export const SECRETS_INVENTORY = family(`secrets`, `inventory`);
// Which credentials need approval, and who may grant it; its own key so the gate editor refetches without re-running
// the inventory fan-out beside it.
export const SECRET_GATES = family(`secrets`, `gates`);
export const SANDBOX_MEMBERS = family(`members`);
export const SKILLS = family(`skills`);
export const SYNC_HEALTH = family(`sync-health`);
export const TERMINALS = family(`terminals`);
// The Agents board's opt-in CPU and memory readout; polled while shown, never pushed.
export const LIVE_METRICS = family(`live-metrics`);
export const USAGE_ROLLUP = family(`usage-rollup`);
export const VPN = family(`vpn`);
export const NETDISK = family(`netdisk`);
