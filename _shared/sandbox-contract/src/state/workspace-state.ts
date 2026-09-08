import { STATE_DIR } from "@intentic/constants";
import type { FileContribution } from "@intentic/extension-manifest";
import type { StateFile } from "./state-portability.js";

// Declares which workspace file backs which browser view, imported by both the daemon (builds store paths from
// `path`) and the browser (builds its invalidation table from `invalidates`). Extensions declare their own entries
// via `contributes.files`; the browser unions the two lists.

// A core entry is an extension's `contributes.files` entry plus two core-only fields: the right to declare no
// invalidations, and a portability class. `path` is workspace-root-relative, forward-slash, the space
// `workspaceChanged` paths arrive in. Matching is by prefix, so one entry covers an exact file, a directory (kept
// with its trailing slash so it can't prefix-match a sibling file), or a name family. Entries may nest; stateFileFor
// resolves the longest match.
export interface WorkspaceStateFile extends StateFile {
    // Browser query keys this file feeds; empty is a real answer (`why` says which). Never a prefix over all of
    // `.intentic/`: one stray write must not refetch every view.
    readonly invalidates: readonly string[];
    // Present only on entries with no invalidations.
    readonly why?: string;
    // Whether this entry is tracked by the root repo, so its diff is reviewable in Changes and `git log`. Absent by
    // default; only configuration (settings, personas, skills, automations, workflow designs, environment overlay,
    // which extensions are on) or authored content whose consequences leave the sandbox (workspace extensions, drafts
    // posted under the owner's name) earns it. Ledgers and bulk content stay out even when `carry`. Narrower than
    // `carry`: `carry` asks whether it moves to a new sandbox, this asks whether a human should review it changing.
    readonly versioned?: true;
    // Whether this is human- or agent-authored text a workspace search should surface (drafts, staged docs, workspace
    // extensions); every `versioned` entry already counts. Kept independent of `versioned` since untracking a draft
    // must not stop search finding it. `SEARCHABLE_STATE_PATHS` denies everything else by default.
    readonly authored?: true;
    // Whether desktop-sync copies this down to the owner's machine, a different question from `portability` (may this
    // restore into a different sandbox): default is `carry` plus `identity`; `derived` (rebuildable) and `secret` are
    // excluded from backup entirely. `false` is the only settable value, an entry opts out, never in.
    readonly backup?: false;
    // Who builds this path when it isn't the daemon; the coverage guard needs an explicit owner or it reads an entry
    // the daemon never builds as dead. Absent for daemon-written entries.
    readonly outsideWriter?: string;
}

// Declared `as const` so paths survive as literal types (`WorkspaceStatePath`); consumers still type entries as
// `WorkspaceStateFile` so optional fields like `note`/`why` aren't lost.
const STATE_FILES = [
    // Holds no credential: values are vaulted (capabilities-store.ts's withSecretVault) and read back rehydrated; the
    // vaulted keys are the complement of what `echo` exposes (capabilities/secret-fields.ts). `carry` because
    // composeEnvironment reads Dockerfile fragments from here; `versioned` because connecting a capability is a
    // consequential change worth reviewing.
    {
        path: ".intentic/config/capabilities.json",
        invalidates: ["capabilities", "environment", "panels", "manifests"],
        portability: "carry",
        versioned: true,
    },

    // Declined capability recommendations and their evidence; shares the `capabilities` key since the catalog changes
    // with it. Holds no credential.
    { path: ".intentic/config/capability-dismissals.json", invalidates: ["capabilities"], portability: "carry", versioned: true },

    // Ledger of when the agent's exits spent a stored secret; holds names and destinations, never values, so it may
    // `carry`.
    { path: ".intentic/records/secret-uses.json", invalidates: ["secrets"], portability: "carry" },

    // Payment ledger: what was paid, to whom, how it settled, the tx hash if any. No credential (the signing key never
    // enters the container), so it may `carry`.
    {
        path: ".intentic/records/wallet-ledger.json",
        invalidates: [],
        why: "Rendered through the wallet CLI and the capability card's live status probe, not from a browser query key.",
        portability: "carry",
    },

    // Named personas: which connected accounts each speaks for, what a session wearing it may do, where it works
    // (PersonaSchema). Invalidates `capabilities` too since a persona's account list is read together with the
    // capability catalog. `carry`: a card is a name and ids, never a credential.
    { path: ".intentic/config/personas.json", invalidates: ["personas", "capabilities", "manifests"], portability: "carry", versioned: true },

    // Four files split by portability, not just prefix: `custom` is the owner-approved source and the only one that
    // must travel; `approved` is composed from custom + capability fragments + the base image and is rebuilt on the
    // target's first boot (carrying it would ship a `FROM` naming an image the target may not have); the proposal and
    // per-tool drafts under `environment.d/` are pending agent requests, carried so the question survives the move.
    { path: ".intentic/config/environment.custom.Dockerfile", invalidates: ["environment"], portability: "carry", versioned: true },
    { path: ".intentic/config/environment.Dockerfile", invalidates: ["environment"], portability: "carry", versioned: true },
    { path: ".intentic/config/environment.d/", invalidates: ["environment"], portability: "carry", versioned: true },
    {
        path: ".intentic/local/environment.approved.Dockerfile",
        invalidates: ["environment"],
        portability: "derived",
        note: "The target composes its own overlay on first boot; rebuild it there to install the tools it names.",
    },

    { path: ".intentic/config/settings.json", invalidates: ["settings", "manifests"], portability: "carry", versioned: true },
    // Safety policy read before every flagged command (safety-policy.ts). `carry`+`versioned`: governs what the agent
    // may do unasked, so a fresh sandbox should start already governed and changes should show in review. Absent falls
    // back to `DEFAULT_SAFETY_POLICY`, not unconfigured.
    { path: ".intentic/config/safety.md", invalidates: ["safety-policy"], portability: "carry", versioned: true },
    // Verdicts the policy above produced, newest first. `derived`/`local`: evidence about this machine, self-trimming,
    // not carried. Own query key, separate from the policy's, since a verdict must not invalidate the document someone
    // is editing.
    {
        path: ".intentic/local/safety-log.json",
        invalidates: ["safety-log"],
        portability: "derived",
        note: "The target starts its own record of what it decided.",
    },
    // Apps the daemon starts on every boot (scaffold/autostart.ts). `carry`: an exported workspace should start the
    // same things. Invalidates nothing: the browser reads what's running off `/panels`, not this file.
    {
        path: ".intentic/config/autostart.json",
        invalidates: [],
        why: "The browser reads what is running off /panels; this file only tells the daemon what to start at boot.",
        portability: "carry",
        versioned: true,
    },
    // Which commands are heavy enough to queue, and how many may run at once (platform/heavy-commands.ts), read per
    // Bash command. `carry`: a property of the workspace, not the machine. `versioned`: raising the limit is a decision
    // worth a diff.
    { path: ".intentic/config/heavy-commands.json", invalidates: ["settings"], portability: "carry", versioned: true },
    // Scripts the rule table runs, one per reader (settings.json points at them per event, e.g. `file.edited`).
    // `versioned`: this is code that runs against every file an agent writes, more consequential than the rule naming
    // it. `carry`: authored text, no credential. Invalidates nothing: the settings screen renders the rules from
    // settings.json, not these scripts.
    {
        path: ".intentic/config/hooks/",
        invalidates: [],
        why: "The settings screen renders the rules that name these scripts, out of settings.json; nothing in the browser reads the scripts themselves.",
        portability: "carry",
        versioned: true,
        // The daemon only runs these scripts by path; it never builds them, so there's no `statePath` call for the
        // coverage guard to find.
        outsideWriter: "the owner or an agent, authoring them; the daemon only ever RUNS one, by the path a rule's command names",
    },
    // Last-fired stamps for the rule table. `derived`: records what happened on this machine, not carried.
    {
        path: ".intentic/local/rule-firings.json",
        invalidates: ["rule-firings"],
        portability: "derived",
        note: "Stamps of when each rule last did something; the new sandbox starts its own record.",
    },
    // Runtime-install ledger: which tools sessions installed, how often, and the last drift snapshot
    // (environment/runtime-installs.ts). `carry` unlike rule-firings: this is about what the workspace's tasks keep
    // needing, not what one machine did. The drift snapshot self-expires on a move since its `bornAt` won't match the
    // new container.
    { path: ".intentic/records/runtime-installs.json", invalidates: ["environment"], portability: "carry" },
    // Where each agent engine's version comes from: blessed list, upstream newest, a pin, or the image
    // (schemas/engines.ts). The versions themselves are machine state on the daemon's volume (architecture-specific
    // binaries); the policy here travels. `versioned`: a human decision worth reviewing. Own key, not `environment`'s:
    // the engines card reads its own route.
    { path: ".intentic/config/engines.json", invalidates: ["engines"], portability: "carry", versioned: true },
    // Written by the agent's approvals skill, read by the owner's inbox. `authored`: text meant to be found by search.
    // `versioned`: an approval can spend, send, or delete under the owner's name, and is kept (not consumed) as a
    // durable record of what was proposed, changed, and done.
    { path: ".intentic/config/approvals/", invalidates: ["approvals"], portability: "carry", versioned: true, authored: true },
    // Path is the daemon's (automations-store writes it); query keys belong to the intentic.automations extension,
    // declared in its own manifest so uninstalling it removes the invalidation too.
    {
        path: ".intentic/config/automations.json",
        invalidates: [],
        why: "Declared by the intentic.automations extension's contributes.files, `automations` is its query key, not core's.",
        portability: "carry",
        versioned: true,
    },
    // Run history, split out of automations.json so a scheduled fire doesn't dirty the tracked config with ledger
    // noise; a fire now touches nothing tracked. `carry`: about the automation, not the machine. Invalidation is
    // declared by the intentic.automations extension since it renders each row's history from this file.
    {
        path: ".intentic/records/automation-runs.json",
        invalidates: [],
        why: "Declared by the intentic.automations extension's contributes.files, `automations` is its query key, not core's.",
        portability: "carry",
    },
    {
        path: ".intentic/records/approvals/",
        invalidates: [],
        why: "Declared by the intentic.approvals extension's contributes.files (the page that lists held wakes), `automation-approvals` is its query key, not core's.",
        portability: "carry",
    },
    // Bug-report inbox, one file per fingerprint (daemon's issues-store), rendered by intentic.issues. `carry`: a fact
    // about the product, not the container. Not `versioned`: machine-recorded telemetry, not an owner decision.
    {
        path: ".intentic/records/issues/",
        invalidates: [],
        why: "Declared by the intentic.issues extension's contributes.files, `issues` is its query key, not core's.",
        portability: "carry",
    },
    // Maintenance ledger and probe evidence (daemon's chores-store), rendered by intentic.maintenance. `carry`:
    // point-in-time evidence about this workspace.
    {
        path: ".intentic/records/chores/",
        invalidates: [],
        why: "Declared by the intentic.maintenance extension's contributes.files, `maintenance-report`/`maintenance-runs` are its query keys, not core's.",
        portability: "carry",
    },
    // Documentation staging tree (documentation extension's paths.ts): generation writes here, the owner approves
    // here, publishing copies into the repo. `authored`: draft READMEs, searchable like a post draft.
    {
        path: ".intentic/config/docs/",
        invalidates: [],
        why: "Declared by the intentic.documentation extension's contributes.files, `documentation`/`documentation-runs` are its query keys, not core's.",
        portability: "carry",
        authored: true,
        outsideWriter: "the intentic.documentation extension's staging writes (its paths.ts)",
    },
    // Core keys, not the workflows extension's: the fleet board and chat panel render workflow runs regardless of
    // whether that extension is enabled. This push is the only live feed the scheduler has. The runs file also
    // invalidates `workflows` since `GET /workflows` embeds each design's runs.
    { path: ".intentic/config/workflows.json", invalidates: ["workflows"], portability: "carry", versioned: true },
    { path: ".intentic/records/workflow-runs.json", invalidates: ["workflows", "workflow-runs"], portability: "carry" },
    // Saved loops: a manifest read by both the workflows page and every chat composer's loop picker, often in
    // different windows, so an edit on one must reach the other. Core key for the same reason workflow designs are.
    { path: ".intentic/config/loop-designs.json", invalidates: ["loop-designs"], portability: "carry", versioned: true },
    {
        path: ".intentic/records/loops.json",
        invalidates: [],
        why: "Ralph loops and their iteration history. Nothing observes it: where a RUNNING loop stands rides on the fleet roster (AgentSummary.loop), which the /events stream already pushes about once a second, and a second source invalidating on this file could only ever disagree with the card beside it. The iteration list of an ENDED loop is an on-demand read, nothing renders it until someone opens it (web's useLoops, which holds no query for exactly this reason).",
        portability: "carry",
    },

    // Reached by no query, by design: invalidation only reaches an observed query key, and none of these are observed.
    // Each entry's `why` states the constraint so a future reader doesn't have to re-derive it.
    {
        path: ".intentic/records/webchat-installs.json",
        invalidates: [],
        why: "Which origins have loaded a Front Desk's widget, written on a 30s flush timer while a customer's site serves page views. The install panel that renders it fetches on open and polls itself while it is on screen, which is the whole window in which the answer changes for anyone. Pushing instead would bill every connected browser a refetch per flush, for a panel almost nobody has open.",
        portability: "carry",
    },
    {
        path: ".intentic/records/issue-installs.json",
        invalidates: [],
        why: "The same probe for the bug reporter's script, on the same flush timer and read by the same kind of panel, so it is outside the push path for the same reason the Front Desk's is.",
        portability: "carry",
    },
    {
        path: ".intentic/records/thread-sessions.json",
        invalidates: [],
        why: "Thread bookkeeping (an inbound thread, a Front Desk visitor, a Discord or Slack channel, → sandbox conversation + provider session), written on EVERY inbound message. Nothing in the browser reads it: what a thread produces is a conversation, and the fleet board already learns about that from the agent registry's own push. Naming a key here would bill every connected browser a refetch per inbound message, the request storm this table's own note warns about, to refresh nothing it can see.",
        portability: "carry",
    },
    // Extension configuration only; secret keys named by `contributes.settings[].secret` are vaulted separately
    // (extensions/extension-settings.ts) and rehydrated on read, so no caller sees the split. `carry`+`versioned`:
    // reviewable now that no credential is inside. No `note`: notes are for skipped/untracked entries; this one
    // carries.
    {
        path: ".intentic/config/extension-settings.json",
        invalidates: [],
        why: "Held in a module-level shallowRef store per extension (web's extensionSettingsStore) with no query observer, and deliberately so: api.settings.get must answer SYNCHRONOUSLY from an extension's first activate() line, and the store outlives every component scope. A module-level QueryObserver is the one shape that would make invalidation refetch, and this app already ruled it out, it detaches on the queryClient.clear() at logout (see useSandbox's sandbox-list mirror). So a remote member's setting edit reaches this browser on its next load, not live.",
        portability: "carry",
        versioned: true,
    },
    // Unlike the settings file, this switch is observed by the Extensions tab's query, so a flip elsewhere shows up
    // live. Toggling doesn't itself rerun the host, that happens via the loader's reconcile, triggered by the tab's own
    // toggle.
    {
        path: ".intentic/config/extension-enablement.json",
        invalidates: ["extensions"],
        portability: "carry",
        versioned: true,
    },
    // Workspace extensions: one directory per extension, written directly by the agent's file tools and live
    // immediately (no clone, no install step). `authored`, unlike `.intentic/extensions/` below which holds clones.
    // `versioned`: every other load path is already reviewable (a git-installed extension's sha, a baked one's image);
    // this is the one kind with no install moment to review at, so the diff is the only review there is. The daemon
    // restarts the extension host on a change here.
    { path: ".intentic/config/workspace-extensions/", invalidates: ["extensions"], portability: "carry", versioned: true, authored: true },
    // Per-extension update/advisory/health findings, written by the periodic check and by update/revert. Pushed live
    // so an auto-disabling advisory doesn't wait for a reload.
    { path: ".intentic/records/extension-updates.json", invalidates: ["extensions"], portability: "carry" },
    // Owner's per-extension update posture (notify/agent/auto, advisory opt-out). `carry`: a decision about the
    // extension, not the machine.
    { path: ".intentic/config/extension-update-policy.json", invalidates: ["extensions"], portability: "carry", versioned: true },
    // `carry`: evidence is about the extension, not the machine; dropping it would make every permission look unused
    // rather than simply unmeasured.
    {
        path: ".intentic/records/extension-usage.json",
        invalidates: [],
        why: "Which of the routes each extension DECLARED it has actually called, the evidence behind the permissions list on its row. The one entry here whose empty set is a RATE decision rather than an architectural one: every browser with the app open reports its batch on a timer, so wiring this to the `extensions` query would refetch the whole list every few seconds for a figure nobody is watching change. The tab reads it when it loads, which is when anyone is reading it.",
        portability: "carry",
    },
    // Holds no credential but stays `identity`, not `carry`: it mirrors the platform's own invite records (the
    // enforcer's copy, so a grant it never received is never honoured), and review already happens on the Access tab
    // against the authoritative record. An access list that traveled would let a source sandbox hand itself the
    // target's ownership.
    {
        path: ".intentic/identity/members.json",
        invalidates: [],
        why: "Not this view's source at all: SandboxAccess renders the PLATFORM's invite records (apiClient.invite.list), and this file is the daemon's ENFORCED copy, written first so a grant the enforcer never got is never recorded, then never read back. A change here means the two disagreed, which the write order makes fail-closed rather than stale.",
        portability: "identity",
        note: "Re-invite collaborators from the Access tab, a grant is the platform's record, and the target enforces its own copy.",
    },

    // ---- daemon-owned, nothing derives from watching them ----
    // AI-provider credentials and homes, plus the capability and extension-settings secret vaults, all under one root:
    // several provider CLIs mix OAuth, config and thread metadata in one home, so no generic export can safely split
    // them, and a new provider lands secret by construction. This tree is already outside the file routes, workspace
    // walk and search index (composition.ts), which is why both secret vaults sit here too.
    {
        path: ".intentic/secrets/auth/",
        invalidates: [],
        why: "AI-provider credentials and runtime homes, plus the capability and extension-settings secret vaults; each account is rendered through owner-gated provider routes.",
        portability: "secret",
        note: "Sign the agent's AI accounts in again on the Agent tab, then re-enter each connection's credential on Capabilities and each extension's secret settings on Extensions, both arrived listed but unauthenticated.",
    },
    // Session transcripts, rewritten on every streamed token; nothing renders them off disk. Excluded as a descent
    // filter, the watcher never walks this subtree at all, which is what makes it cheap.
    {
        path: ".intentic/records/sessions/claude/",
        invalidates: [],
        why: "Agent session transcripts; nothing derives from watching them, and descending into them would cost a fifth of the watcher.",
        portability: "carry",
    },
    {
        path: ".intentic/records/artifacts/",
        invalidates: [],
        why: "Durable outputs owned by conversations and extension runs: attachments, browser captures, generated images, acceptance reports, workflow step reports, voice transcripts, and loop ledgers.",
        portability: "carry",
    },
    {
        path: ".intentic/local/cache/",
        invalidates: [],
        why: "Rebuildable indexes and caches, the iq index and its vector sidecar, the whisper model, fileq's derived/ markdown shadows of binary files; ignored by the watcher and recreated from carried workspace content.",
        portability: "derived",
    },
    // Extension runtime scratch, one directory per extension via `extensionRuntimeDir` below (the only way an
    // extension may name a home here). Resume watermarks and cached tokens; all of it expires or re-derives.
    {
        path: ".intentic/local/runtime/",
        invalidates: [],
        why: "Extension runtime scratch (watermarks, cached short-lived tokens); nothing renders it and gateways re-derive it.",
        portability: "derived",
        outsideWriter: "extensions, through extensionRuntimeDir below",
    },
    {
        path: ".intentic/local/tmp/",
        invalidates: [],
        why: "Scratch that agents and tools leave behind (build logs, demo checkouts); nothing reads it after the turn that wrote it. The state janitor empties it at boot.",
        portability: "derived",
    },
    // Not written by the daemon: pnpm auto-creates its content-addressable store when an install runs from under
    // `.intentic`. Declared anyway so the table accounts for everything under the state dir; a fresh install rebuilds
    // it.
    {
        path: ".intentic/local/.pnpm-store/",
        invalidates: [],
        why: "pnpm's content-addressable store, auto-created by installs run from under .intentic; the next install rebuilds it.",
        portability: "derived",
        outsideWriter: "pnpm itself, when an install runs from under .intentic",
    },
    {
        path: ".intentic/local/newest-run.json",
        invalidates: [],
        why: "The newest daemon version that ever ran this workspace (store/newest-run.ts), a downgrade tripwire, about THIS sandbox the way rule-firings is.",
        portability: "derived",
        note: "The target stamps its own daemon version on first boot.",
    },
    {
        path: ".intentic/records/verify.json",
        invalidates: [],
        why: "The dependency verifier's verdict memory; nothing renders it directly, outcomes reach the owner as activity entries and workspace events.",
        portability: "carry",
    },
    {
        path: ".intentic/local/verify/",
        invalidates: [],
        why: "A running check's wrapper artifacts (log + exit status), read once by the daemon when the panel finishes.",
        portability: "derived",
    },
    {
        path: ".intentic/secrets/ci.json",
        invalidates: [],
        why: "Webhook secret + conclusion memory; the Pipelines view reads it through /ci/runs, not off disk.",
        portability: "secret",
        note: "Re-add the CI webhook on the Pipelines view, its secret is per-sandbox.",
    },
    // Credentials behind the daemon's public doors: an automation's webhook, a workflow's release gate, an issue
    // intake key. Kept out of the versioned manifests that declare those doors (automations.json, workflows.json)
    // since a credential has no place in a tracked, agent-readable file; reachable only through the route that lists
    // the automation or workflow.
    {
        path: ".intentic/secrets/doors.json",
        invalidates: [],
        why: "The credentials behind the event webhooks, release gates and bug intakes; each surface reads its own through /automations and /workflows, never off disk.",
        portability: "secret",
        note: "Webhook, gate and intake URLs are minted fresh on the first read here: re-copy each into its caller's secret store.",
    },
    // The one `identity` entry that opts out of backup: unlike the rows beside it (a name, an id, a role), these
    // tokens authenticate against this sandbox from outside it, so a copy has no business surviving the sandbox it
    // admits callers to. Re-minted on a new sandbox regardless, so nothing is lost by excluding it.
    {
        path: ".intentic/identity/control-tokens.json",
        invalidates: [],
        why: "Hashed control tokens (the ACP editor bridge, and anything else driving this sandbox from outside), listed on demand by the owner.",
        portability: "identity",
        backup: false,
        note: "Mint fresh control tokens, the old ones authenticate against the source sandbox.",
    },
    {
        path: ".intentic/identity/owner.json",
        invalidates: [],
        why: "Bound once on first use; a change here means the sandbox was re-owned, which re-authenticates anyway.",
        portability: "identity",
    },
    {
        path: ".intentic/identity/workspace.json",
        invalidates: [],
        why: "The workspace identity, read from the /events hello frame rather than as a file.",
        portability: "identity",
    },
    {
        path: ".intentic/config/templates.json",
        invalidates: [],
        why: "Scaffold templates, read when the scaffold dialog opens.",
        portability: "carry",
        versioned: true,
    },
    // `derived` for size, not safety, these are logged-in sessions, but gigabytes of a store Chromium rewrites
    // constantly and versions to its own build, so carrying it might not even work on the target.
    {
        path: ".intentic/local/browser/",
        invalidates: [],
        why: "Browser-login profiles: Chromium rewrites these constantly. Descent-ignored by the watcher outright.",
        portability: "derived",
        note: "Log the agent's browser back into any site it needs, profiles do not travel.",
    },
    {
        path: ".intentic/local/extensions/",
        invalidates: [],
        why: "Extension checkouts, whole git clones. The `extensions` query is driven by the capability manifest above, not by their contents.",
        portability: "derived",
        note: "Extensions re-clone from the capability manifest on the target's next reconcile.",
    },
    { path: ".intentic/records/plugins/", invalidates: [], why: "Agent plugin dirs, read by the SDK's loader each turn.", portability: "carry" },
    // Skills the owner wrote, source of truth for the reconciler that copies enabled ones into `.agents/skills`
    // (settings.json's `skills` list); a skill switched off keeps its text here rather than nowhere. `versioned`+
    // `carry`: it changes agent behavior and holds no credential.
    { path: ".intentic/config/skills/", invalidates: ["skills"], portability: "carry", versioned: true },
    // One folder per persona: its system prompt, skills and tools, laid out as a Claude Code plugin
    // (`.claude-plugin/plugin.json`, `skills/`, `agents/`, `commands/`, `hooks/`, `.mcp.json`) so the runtime's own
    // loader reads it directly. Kept separate from `personas.json` because this is prose and files rather than a
    // diffable record; folding a 20k prompt into JSON would make every edit unreadable.
    { path: ".intentic/config/personas/", invalidates: ["personas"], portability: "carry", versioned: true },
] as const satisfies readonly WorkspaceStateFile[];

export const WORKSPACE_STATE_FILES: readonly WorkspaceStateFile[] = STATE_FILES;

// Entries the root repo tracks, in declaration order; history.ts turns this into the negations that carve them out
// of the wholesale `.intentic` exclusion. Derived here rather than duplicated beside the git rule, so marking an
// entry `versioned` is the only change needed.
export const VERSIONED_STATE_PATHS: readonly string[] = WORKSPACE_STATE_FILES.filter((file) => file.versioned).map((file) => file.path);

// Slice a workspace search may surface: `versioned` config plus `authored` content (approvals, staged docs,
// workspace extensions). Everything else under `.intentic` is machine state, denied by default. `auth/`, where
// vaulted credentials live, is always denied regardless.
export const SEARCHABLE_STATE_PATHS: readonly string[] = WORKSPACE_STATE_FILES.filter((file) => file.versioned || file.authored).map(
    (file) => file.path,
);

// The kind of thing an entry is, and the axis the directory layout is built on. Derived from
// `versioned`/`authored`/`portability` rather than declared per entry, since those three answers already nest
// cleanly (every `versioned` and `authored` entry is `carry`), declaring the group separately would be a fourth
// fact to keep in step.
export type StateGroup =
    // Reviewed and reviewable: settings, personas, skills, approvals, staged docs, environment overlay. Tracked,
    // searchable, backed up, carried. Called `config` even though approvals and staged docs are authored content, not
    // settings, since most members are.
    | "config"
    // What happened: run ledgers, chores, transcripts, artifacts. Machine-written, so untracked and unsearchable, but
    // backed up and carried as the owner's history.
    | "records"
    // Rebuildable from what does travel: caches, indexes, extension checkouts, scratch, the composed overlay, browser
    // profiles. Neither backed up nor carried; the janitor may delete it freely.
    | "local"
    // Who owns this sandbox and who may drive it. Backed up so the owner keeps their own access record; never carried,
    // or a source sandbox could claim the target.
    | "identity"
    // Credentials. Never backed up; carried only when the owner opts in at export.
    | "secrets";

// Directory each group lives in; group name is the folder name, one vocabulary, so the layout guard
// (workspace-state.test.ts) can check the whole tree with one rule. Two things don't collapse to a folder prefix:
// the staged-docs tree is searchable but deliberately untracked (publishing already copies it into the repo)
// despite living in `config/`; and the composed overlay plus rule-firing stamps are `derived`/`local` but still
// feed a view, so the watcher can't just skip all of `local/`. Both stay derived from the flags rather than the
// folder name.
export const STATE_GROUP_DIR: Readonly<Record<StateGroup, string>> = {
    config: `${STATE_DIR}/config`,
    records: `${STATE_DIR}/records`,
    local: `${STATE_DIR}/local`,
    identity: `${STATE_DIR}/identity`,
    secrets: `${STATE_DIR}/secrets`,
};

// Every group, derived from the folder map so the two can't disagree on count; declaration order is the reading
// order (what you wrote, what happened, what's disposable, who owns this, the keys).
export const STATE_GROUPS = Object.keys(STATE_GROUP_DIR) as readonly StateGroup[];

// Group for one entry, checked most-specific first: a credential is a credential regardless of anything else.
export const stateGroupOf = (file: WorkspaceStateFile): StateGroup => {
    switch (file.portability) {
        case "secret":
            return "secrets";
        case "identity":
            return "identity";
        case "derived":
            return "local";
        case "carry":
            return file.versioned === true || file.authored === true ? "config" : "records";
    }
};

// Entries of one group, in declaration order, what a hand-kept path list would otherwise need.
export const stateGroupPaths = (group: StateGroup): readonly string[] =>
    WORKSPACE_STATE_FILES.filter((file) => stateGroupOf(file) === group).map((file) => file.path);

// What an isolated turn shares live with the main tree vs. keeps as its own worktree checkout, split along the
// line git already draws: `versioned` entries are the worktree's own checkout (reviewed in its diff, landed like
// code); everything untracked is bound in from the main tree (agents/isolation.ts), or a transcript, ledger or
// staged doc written into a per-worktree copy would simply be lost. Whole-group dirs are bound where the whole
// group is untracked (records, local, identity, secrets); only `config`, which mixes tracked and untracked (the
// staged-docs tree), is bound entry by entry. Trailing slash kept on every directory entry.
export const SHARED_STATE_PATHS: readonly string[] = STATE_GROUPS.flatMap((group) => {
    const files = WORKSPACE_STATE_FILES.filter((file) => stateGroupOf(file) === group);
    return files.some((file) => file.versioned === true)
        ? files.filter((file) => file.versioned !== true).map((file) => file.path)
        : [`${STATE_GROUP_DIR[group]}/`];
});

// Slice desktop-sync copies down: ordinary state and the records binding this sandbox to its owner, minus anything
// that opts out via `backup: false`. Deliberately not the same question as the export bundle: a bundle asks what
// may be reconstituted elsewhere, this asks what the owner may keep a copy of.
export const BACKED_UP_STATE_PATHS: readonly string[] = WORKSPACE_STATE_FILES.filter(
    (file) => file.backup !== false && (file.portability === "carry" || file.portability === "identity"),
).map((file) => file.path);

// Complement of the above: everything that must not be copied down. Derived from the same predicate, so a new
// store defaults to excluded until its class says otherwise.
export const UNBACKED_STATE_PATHS: readonly string[] = WORKSPACE_STATE_FILES.filter((file) => !BACKED_UP_STATE_PATHS.includes(file.path)).map(
    (file) => file.path,
);

// The only way an extension may name a scratch home, workspace-relative and forward-slash so the browser bundle
// can hold it too. Extension ids are already validated slugs; the character replace is defense in depth.
export const extensionRuntimeDir = (extension: string): string =>
    `${STATE_GROUP_DIR.local}/runtime/extensions/${extension.replaceAll(/[^a-zA-Z0-9._-]/g, "_")}`;

// Manifests the unreadable-manifest notice reports on: exactly the entries that declare `manifests` in
// `invalidates`, since a file's problems are only worth showing if a write to it can refresh the notice. A broken
// file still falls back and sets its bad bytes aside (store/json-file.ts); it just stops asking the owner to fix
// it.
export const REPORTED_MANIFEST_PATHS: readonly string[] = WORKSPACE_STATE_FILES.filter((file) => file.invalidates.includes("manifests")).map(
    (file) => file.path,
);

// Accepts either separator; the daemon holds these as platform paths and normalizing at every call site is what
// eventually gets forgotten.
export const isReportedManifest = (relPath: string): boolean => REPORTED_MANIFEST_PATHS.includes(relPath.replaceAll("\\", "/"));

// Entries directly under `.intentic/` the file API refuses to read, write, move or delete for anyone, owner
// included (workspace/workspace-files.ts enforces it). Declared here so the browser can draw the same rule instead
// of only reacting to a refusal. Naming them gives nothing away the tree doesn't already list; what's protected is
// the bytes.
// Group-relative names, and the one rule that cuts across every group rather than collapsing to a group prefix:
// what the file API refuses depends on whether the bytes are sensitive, not on what kind of entry it is.
export const LOCKED_STATE_ENTRIES: ReadonlySet<string> = new Set([
    "identity/owner.json",
    "identity/members.json",
    "identity/control-tokens.json",
    "config/capabilities.json",
    "secrets/ci.json",
    "secrets/doors.json",
    "secrets/auth",
    "records/sessions",
    "local/browser",
    // The provider CLI's own home, undeclared in the table above and so without a group; stays at the state dir root.
    // The two-segment match below still reaches it since a bare name joins to itself. Locked: it holds a live session
    // for whatever the agent is signed into.
    "claude.json",
]);

// Where the CLI's plan files land; `~/.claude/plans` symlinks here (sessions/session-store.ts), so a plan has a
// harness-owned address rather than a length heuristic. Locked even though its contents are the same text the chat
// already rendered for approval, unlike `records/sessions` which is locked for holding the provider's own session
// state.
export const PLAN_DOCUMENTS_DIR = `${STATE_DIR}/records/sessions/claude/plans`;

// Where message attachments land: the browser posts to `<this>/<uuid>/<name>` before the message is sent, and the
// turn reads them back (schemas/agent.ts). The role floor (auth/role-floor.ts) keys off this path: attaching is
// part of sending (a collaborator's grant), writing elsewhere in the workspace is the operating tier's, and both
// travel through the same upload route.
export const ATTACHMENTS_DIR = `${STATE_DIR}/records/artifacts/attachments`;

// Normalizes first: a path that opens inside the attachments dir and climbs back out with `..` would otherwise
// reach anywhere in the workspace under an attachment's address. A path that climbs above the root, or is
// absolute, is simply not an attachment, and falls back to the operating tier's floor rather than to permission.
export const isAttachmentPath = (relPath: string): boolean => {
    const resolved: string[] = [];
    for (const segment of relPath.split(/[\\/]/)) {
        if (segment === "" || segment === ".") {
            continue;
        }
        if (segment !== "..") {
            resolved.push(segment);
            continue;
        }
        if (resolved.pop() === undefined) {
            // Climbed above the workspace root: whatever it names, it is not in here.
            return false;
        }
    }
    // An absolute path's leading separator produces an empty segment dropped from `resolved`, so it folds to the same
    // shape as a relative one; checking the leading separator is what still tells the two apart.
    return !relPath.startsWith("/") && !/^[A-Za-z]:/.test(relPath) && resolved.join("/").startsWith(`${ATTACHMENTS_DIR}/`);
};

// Which locked entry a root-relative path belongs to, or undefined if it's not in the control plane. Scoped tight:
// only the root `.intentic` counts (a nested repo's own is ordinary content), and the root's own `.git` joins the
// set as the pointer to the shadow history repo kept off the workspace so the agent can't rewrite its own past.
// Returns the entry name rather than a boolean since the refusal screen needs to say what the file holds. Accepts
// either slash.
export const lockedWorkspaceEntry = (relPath: string): string | undefined => {
    const segments = relPath.split(/[\\/]/).filter((segment) => segment !== "" && segment !== ".");
    if (segments[0] === ".git") {
        return ".git";
    }
    if (segments[0] !== STATE_DIR) {
        return undefined;
    }
    const rel = segments.join("/");
    if (rel === PLAN_DOCUMENTS_DIR || rel.startsWith(`${PLAN_DOCUMENTS_DIR}/`)) {
        return undefined;
    }
    // Two segments covers both spellings above: a grouped entry (`secrets/auth`) matches as written, and a bare root
    // entry (`claude.json`) joins to itself.
    const entry = segments.slice(1, 3).join("/");
    return LOCKED_STATE_ENTRIES.has(entry) ? entry : undefined;
};

// Whether a path lands in the control plane and so is refused by the file API rather than opened.
export const isLockedWorkspacePath = (relPath: string): boolean => lockedWorkspaceEntry(relPath) !== undefined;

// Locked entries the root repo tracks anyway: refused by the file API but still diffable in Changes, since `git
// log` and every clone already have the bytes. Derives from the same `versioned` flag rather than naming a file,
// so marking another locked entry `versioned` doesn't need a second edit here. Every other surface (read, write,
// move, delete, publish) still asks `isLockedWorkspacePath` and still refuses. Accepts either slash.
export const isReviewableLockedPath = (relPath: string): boolean => {
    const rel = relPath.replaceAll("\\", "/").replace(/^\.\//, "");
    return isLockedWorkspacePath(rel) && VERSIONED_STATE_PATHS.some((path) => (path.endsWith("/") ? rel.startsWith(path) : rel === path));
};

// Every path this table declares, as a type; the daemon joins paths only through `statePath`
// (workspace/state-paths.ts), which accepts one of these and nothing else, so renaming a store's file is a compile
// error everywhere it's named rather than a view that silently stops refreshing.
export type WorkspaceStatePath = (typeof STATE_FILES)[number]["path"];

// Query keys a batch of changed paths makes stale; the browser's `/events` handler calls it. `contributed`
// (activated extensions' `contributes.files`) is a required argument, not imported, since which extensions are
// live is a browser-only fact and an optional argument here would be one a caller could forget to pass. Extension
// entries are unioned flat with core ones so a narrower extension entry can still fire under a core prefix that
// itself invalidates nothing.
export const staleQueryKeys = (paths: readonly string[], contributed: readonly FileContribution[]): readonly string[] => [
    ...new Set(
        [...WORKSPACE_STATE_FILES, ...contributed]
            .filter((file) => file.invalidates.length > 0 && paths.some((path) => path.startsWith(file.path)))
            .flatMap((file) => file.invalidates),
    ),
];

// Every query key any watched file feeds, what a new `/events` connection invalidates wholesale. The file push is
// these keys' only live feed, so a change while the stream was down would otherwise sit stale until the file's
// next write; re-asking on connect bounds that to one read per key.
export const fileBoundQueryKeys = (contributed: readonly FileContribution[]): readonly string[] => [
    ...new Set([...WORKSPACE_STATE_FILES, ...contributed].flatMap((file) => file.invalidates)),
];
