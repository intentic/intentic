import type { ProcedureName } from "../features/sandbox/client/sandboxRpc";
import { sandboxKey } from "../features/sandbox/overview/activeSandbox";

// Every cache key's path, written once: `sandboxKey` scopes to the active sandbox, so `.of()` is that sandbox's exact
// key and `.every` is the deliberate wider prefix across all sandboxes. Imports only `sandboxKey` at runtime, nothing
// app-specific, to avoid an import cycle; queryKeys.guard.test.ts enforces this as the only place a key is spelled.

// A contract read's key is derived, never declared: its route name, its input, any storage marks, then the sandbox,
// which stays last so sandboxQueryPredicate can sweep one box. `rpcPrefix` reaches every input in every box.
export const rpcPrefix = (procedure: ProcedureName): readonly string[] => [procedure];
const rpcParts = (procedure: ProcedureName, input: unknown, marks: readonly unknown[]): unknown[] => [
    procedure,
    ...(input === undefined ? [] : [input]),
    ...marks,
];
export const rpcKey = (procedure: ProcedureName, input?: unknown, ...marks: readonly unknown[]): unknown[] =>
    sandboxKey(...rpcParts(procedure, input, marks));
// The same key naming its sandbox; for the active one it equals `rpcKey`'s, so one read never becomes two entries.
export const rpcKeyAt = (sandboxId: string, procedure: ProcedureName, input?: unknown, ...marks: readonly unknown[]): unknown[] => [
    ...rpcParts(procedure, input, marks),
    sandboxId,
];

// The working tree's review: its change list and the file diffs read from it, which go stale only together.
const WORKING_REVIEW: readonly ProcedureName[] = [`git.changes`, `git.fileDiff`];
export const workingReviewKeys: readonly (readonly string[])[] = WORKING_REVIEW.map(rpcPrefix);

// An agent's review: its diff against the main line, the file diffs read from it, and where its landed work went,
// which go stale only together; every agent's in every box.
export const AGENT_REVIEW: readonly ProcedureName[] = [`agents.diff`, `agents.fileDiff`, `agents.history`];
export const agentReviewPrefixes: readonly (readonly string[])[] = AGENT_REVIEW.map(rpcPrefix);

// The contract reads each name the daemon pushes stands for (WORKSPACE_STATE_FILES, RUNTIME_DOMAIN_BINDINGS, runtime
// paths joined by `/`), since the daemon's tables name cache entries and a read is filed under its route name.
const PUSHED_READS: Readonly<Record<string, readonly ProcedureName[]>> = {
    areas: [`areas.list`],
    browsers: [`system.browsers`],
    capabilities: [`capabilities.list`],
    devices: [`system.devices`],
    extensions: [`extensions.list`],
    "git/changes": WORKING_REVIEW,
    "loop-designs": [`loops.designs`],
    manifests: [`system.manifestProblems`],
    mainline: [`workspace.mainline`],
    panels: [`panels.list`],
    personas: [`personas.list`, `personas.kit`],
    "rule-firings": [`settings.firings`],
    "safety-log": [`safety.log`],
    "safety-policy": [`safety.policy`],
    secrets: [`secrets.list`, `secrets.inventory`, `secrets.gates`],
    settings: [`settings.get`],
    skills: [`skills.list`, `skills.read`],
    subagents: [`system.subagents`],
    terminals: [`system.terminals`],
    "workflow-runs": [`workflows.runs`],
    workflows: [`workflows.list`],
};

// Every prefix a pushed key path makes stale: its own, which an extension's `api.key(...)` or a family below is filed
// under, then the contract reads it stands for.
export const pushedKeys = (path: readonly string[]): readonly (readonly string[])[] => [
    path,
    ...(PUSHED_READS[path.join(`/`)] ?? []).map(rpcPrefix),
];

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

// A family names what is not one contract read: a composite of several calls, a projection of an answer, a
// non-contract route, the platform's account-wide state, or a key an extension shares by name.

// ---- workspace ----

// The infrastructure read-model: two desired-state files read and projected into one state.
export const WORKSPACE_STATE = family(`workspace`, `state`);
// Every monorepo's apps, one read per repo.
export const WORKSPACE_APPS = family(`workspace`, `apps`);
// Search results by page, as an infinite query holds them.
export const WORKSPACE_SEARCH = family(`workspace`, `search`);

// ---- git ----

export const GIT_LOG = family(`git`, `log`);

// ---- agents ----

// A conversation's transcript, projected into the reading the chat hydrates from (`agentTranscript.ts`).
export const AGENTS = family(`agents`);

// The hosted plan belongs to the person, not the sandbox; keyed under `.every` since scoping it would cache a
// disagreeing copy per sandbox.
export const HOSTED_PLAN = family(`hosted-plan`);
// Deleted sandboxes still inside their recovery window. Account-wide like the sandbox list, never one box's data.
export const SANDBOX_TRASH = family(`sandbox-trash`);

// ---- sandbox surfaces ----

// Per-repo app lists (`of(repo)`); the daemon's runtime push invalidates the bare `apps` prefix on any dev-server
// change, reaching every per-repo variant at once.
export const APPS = family(`apps`);
export const BUNDLE_EXPORTS = family(`bundle-exports`);
export const DEPLOYMENTS = family(`deployments`);
export const ENGINES = family(`engines`);
export const ENVIRONMENT = family(`environment`);
export const ENVIRONMENT_CONTENTS = family(`environment-contents`);
// Shared with the preview extension's ports view by exact key, as `PUBLIC` is below.
export const PORTS = family(`ports`);
// This sandbox's runners: the machines it can hand a conversation to.
export const RUNNERS = family(`runners`);
// Shared with the preview extension by exact path: its manifest binds `public/` to the name `public`, so
// `family("public").of()` and its `api.key("public")` produce the identical key and share one push.
export const PUBLIC = family(`public`);
export const REGISTRY = family(`registry`);
export const SANDBOX_MEMBERS = family(`members`);
export const SYNC_HEALTH = family(`sync-health`);
