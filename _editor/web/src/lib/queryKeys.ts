import type { ProcedureName } from "../client/sandbox/sandboxRpc";
import { sandboxKey } from "../app/storage/activeSandbox";

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

// The contract reads each name the daemon pushes stands for (WORKSPACE_STATE_FILES, RUNTIME_DOMAIN_BINDINGS, an
// extension's `contributes.files`, runtime paths joined by `/`), since the daemon's tables name cache entries and a read
// is filed under its route name, the shell's and an extension's `api.sandbox.readKey(...)` alike.
// A raw read that no procedure stands for (the paired-machine rosters, the sync state, the runners list: the families
// below) needs no entry here. It is filed under the pushed path itself (`hosts`, `webext`, `phones`, `runners`,
// `sync-health`), which `pushedKeys` returns first, so the daemon's push of the domain reaches it and everything else
// that path names.
const PUSHED_READS: Readonly<Record<string, readonly ProcedureName[]>> = {
    // The activity extension's status card: the daemon's activity domain, and the config files its manifest names.
    "activity-status": [`activity.status`],
    // A dev server starting or stopping: each monorepo's app list.
    apps: [`workspace.appsList`],
    // The approvals queue, by its directory's write or the daemon's own domain; hook sets and held automation wakes ride it,
    // living off /work.
    approvals: [`approvals.list`, `approvals.hookRequests`, `automations.pendingList`],
    // A held automation wake parked, approved or rejected, by the file binding releases before 2026-10-12 pushed on.
    "automation-approvals": [`automations.pendingList`],
    areas: [`areas.list`],
    // The automations extension's manifest names its own files by this.
    automations: [`automations.list`],
    browsers: [`system.browsers`],
    capabilities: [`capabilities.list`],
    // The CI sweep's board, which the pipelines board, its rail badge and the CI trigger's delivery note all read.
    "ci-runs": [`ci.runs`],
    desktop: [`system.desktop`],
    devices: [`system.devices`],
    extensions: [`extensions.list`],
    "git/changes": WORKING_REVIEW,
    // A standing yes written by a card or taken back, outside any need's answer: only the Allowed list reads them.
    grants: [`needs.grants`],
    "loop-designs": [`loops.designs`],
    manifests: [`system.manifestProblems`],
    // What agents wait on people for: the chat's need cards, the conversation strip, the board and the inbox share it.
    needs: [`needs.list`, `needs.grants`],
    panels: [`panels.list`],
    personas: [`personas.list`, `personas.kit`],
    // The forward table moving: the rail's exposure indicator, Preview's targets and the preview extension's ports view.
    ports: [`ports.list`],
    // A write under `public/`, through the preview extension's manifest: its outbox view and the shell's Preview target.
    public: [`public.list`],
    "privacy-log": [`privacy.log`],
    "rule-firings": [`settings.firings`],
    "safety-log": [`safety.log`],
    "safety-policy": [`safety.policy`],
    secrets: [`secrets.list`, `secrets.inventory`, `secrets.gates`],
    settings: [`settings.get`],
    skills: [`skills.list`, `skills.read`],
    subagents: [`system.subagents`],
    terminals: [`system.terminals`],
    // An automatic update's state rides /info, beside everything else the update card reads.
    update: [`system.info`],
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

// Every monorepo's apps for the preview list (`of([...repos])`), one per-repo read each; the daemon's runtime push
// invalidates the bare `apps` prefix on any dev-server change. The repo list rides as ONE array element, so no key made
// of plain names (an extension's `api.sandbox.key("apps", repo)`) can ever equal it and store another shape under it.
export const APPS = family(`apps`);
export const BUNDLE_EXPORTS = family(`bundle-exports`);
export const DEPLOYMENTS = family(`deployments`);
export const ENGINES = family(`engines`);
export const ENVIRONMENT = family(`environment`);
export const ENVIRONMENT_CONTENTS = family(`environment-contents`);
// The machines paired with this sandbox, one roster each, read by every dialog, row and badge that names them. These
// are raw reads (`sandboxRaw`), not contract procedures, so their keys are the families' own, and the daemon's push of
// the matching domain (RUNTIME_DOMAIN_BINDINGS: `hosts`, `webext`, `phones`, `runners`) refreshes whichever are on screen.
export const PAIRED_HOSTS = family(`hosts`);
export const PAIRED_BROWSERS = family(`webext`);
export const PAIRED_PHONES = family(`phones`);
// The machines it can hand a conversation to.
export const RUNNERS = family(`runners`);
export const REGISTRY = family(`registry`);
export const SANDBOX_MEMBERS = family(`members`);
// The platform's invite records for this sandbox (invite.list): whose invite still waits, and whose ran out.
export const SANDBOX_INVITES = family(`invites`);
// The control tokens minted against this sandbox and the other sandboxes' links into it (GET /system/control/tokens,
// GET /system/links), as Sandbox ▸ Map reads them; the Access tab keeps its own lists, the ones it mints into and revokes.
export const CONTROL_TOKENS = family(`control-tokens`);
export const INBOUND_LINKS = family(`inbound-links`);
// What the signed-in person's own grant allows (GET /members/self), read for a writer, whose tier alone does not say
// whether it runs agents.
export const SANDBOX_SELF_ACCESS = family(`members-self`);
// Desktop sync's sandbox-level state (GET /system/sync): the one read behind the sync badges and the Add device card.
export const SYNC_HEALTH = family(`sync-health`);
// The voices this sandbox can speak with (GET /speech/voices), read by the Agent tab's Voice card. Not one contract read
// and pushed by no domain: the card refetches it itself after a voice setting is saved, since whether the connected
// provider's key resolves is part of the answer.
export const SPEECH_VOICES = family(`speech-voices`);
