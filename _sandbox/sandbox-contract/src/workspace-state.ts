import { STATE_DIR } from "@intentic/constants";
import type { FileContribution } from "@intentic/extension-manifest";
import type { StateFile } from "./state-portability.js";

/* WHICH WORKSPACE FILE BACKS WHICH CORE VIEW — one declaration, read by both sides of the wire.
 *
 * The daemon's own state lives under `<workspace>/.intentic/`, the agent edits it out-of-band with its file
 * tools, and the file watcher pushes every change as a `workspaceChanged` batch. Turning those paths back into
 * "and therefore this view is stale" used to be a hand-written table in the BROWSER (web's systemEventRouting),
 * maintained separately from the paths the daemon actually writes (composition.ts) — two lists of the same
 * fact, in two packages, with nothing tying them together.
 *
 * They drifted, exactly as that shape always does. `.intentic/drafts/` is written by the AGENT (the drafts
 * skill puts a file there) and rendered by the Drafts view, but it was never added to the browser's table — so
 * a draft appearing on disk while the owner watched the page changed nothing until they refocused the tab.
 * Extension settings and the members list were missing for the same reason; writing them out is what showed
 * that neither is a drafts-shaped hole — see their entries.
 *
 * So the binding is declared HERE, once, in the package both the daemon and the browser already import, and
 * each side derives what it needs: the daemon builds its store paths from `path`, the browser builds its
 * invalidation table from `invalidates`. Adding a manifest without saying what it makes stale is now a change
 * to one visible list rather than an omission in a file nobody edits — and `workspace-state.test.ts` fails when
 * a daemon store names a `.intentic` path this list doesn't carry.
 *
 * This mirrors what routes.ts does for the route surface ("nothing is generated and nothing is hand-maintained")
 * one layer over: the same refusal to keep the same knowledge in two places.
 *
 * EXTENSIONS declare their own half in their manifest (`contributes.files`, @intentic/extension-api), in the same
 * two fields, and the browser unions the two lists — see staleQueryKeys. That split is what this table is FOR:
 * before it existed the core enumeration had to carry `automations` and `automation-approvals`, query keys owned
 * by the automations extension, because the extension had no way to say so itself. A key belongs to whoever
 * queries it. */

/* A core entry is an extension's `contributes.files` entry plus the two things only the core list needs: the
 * right to declare NO invalidations (for a daemon-owned file, the answer more often than not), and a
 * portability class, because the daemon's own state is what an environment export has to reason about.
 *
 * `path` is workspace-root-relative, forward-slash — the space `workspaceChanged` paths arrive in. Matching is
 * by PREFIX, which lets one entry cover three shapes without a second matching rule:
 *   - an exact file      `.intentic/settings.json`
 *   - a directory        `.intentic/drafts/`     (one file per draft)
 *   - a name family      `.intentic/environment.custom.` (…Dockerfile and anything later named beside it)
 * A directory entry keeps its trailing slash so it can never prefix-match a sibling file. Entries may NEST —
 * see stateFileFor, which resolves the longest match rather than the first. */
export interface WorkspaceStateFile extends StateFile {
    /* The browser query keys this file's contents feed. EMPTY is a real answer, not a gap — a file the browser
     * renders nothing from, or one deliberately kept off the push path — and `why` says which. Never a prefix
     * test over `.intentic/` as a whole: one stray write must not cost every view a refetch, which is the
     * amplification that once turned an iq index rebuild into an endless request storm. */
    readonly invalidates: readonly string[];
    // Why this file has no invalidations, for the entries that declare none. Absent when it has some.
    readonly why?: string;
    /* Whether this entry is TRACKED by the root repo — the third thing an entry declares, and the one an owner
     * sees most directly: a tracked entry gets a diff in the Changes review and a line in `git log`, so a change
     * to how this sandbox behaves can be read, reverted, and attributed.
     *
     * ABSENT IS THE ANSWER FOR ALMOST EVERYTHING, and deliberately so. The root repo excludes `.intentic`
     * wholesale and this flag is the only thing that carves an entry back out, so a store added later is
     * untracked until someone says otherwise — the same default-deny the `portability` classes are built on, for
     * the same reason. An ignore-pattern list would invert it: a credential store added next month would be
     * committed on its first write, and nothing would have had to change for that to happen.
     *
     * Only CONFIGURATION belongs here — the small, slow-moving files that decide how this sandbox behaves. Two
     * kinds of entry are excluded on purpose even though they are `carry` and hold no secret:
     *   - LEDGERS (workflow runs, loop iterations, thread bookkeeping, permission-usage batches), which are
     *     rewritten on a timer or several times per step. Tracking them buries the owner's code review under
     *     machine noise — one of them is written every few seconds while a browser has the app open.
     *   - BULK (session transcripts, artifacts), which are hundreds of megabytes of constantly-rewritten
     *     content. They travel in a bundle; they do not belong in a diff.
     * `versioned` is therefore NARROWER than `carry`, and the two answer different questions: carry is "does it
     * move to a new sandbox", this is "should a human review it changing". */
    readonly versioned?: true;
}

/* Declared `as const` so the paths survive as literal types (see WorkspaceStatePath below), then published under
 * the interface. Both bindings are needed and neither is redundant: the const is the only thing that can produce
 * the path union, and every consumer reads entries as `WorkspaceStateFile` — an exact-literal tuple loses the
 * optional members (`note`, `why`) on the entries that omit them, which is a worse type for reading than the
 * interface it satisfies. One list, two views of it. */
const STATE_FILES = [
    /* A capability add/remove recomposes the environment overlay and can add or drop a repo's panel.
     *
     * Each entry's `config` carries that capability's credential (an mcp server's token, a Komodo key, an ssh
     * key), so the manifest is a secret in full. It is also what composeEnvironment reads its Dockerfile
     * fragments from, which makes this the entry where the owner's export choice has the most visible
     * consequence: a bundle exported WITHOUT secrets rebuilds a stock overlay, and the import report has to
     * name every capability the target needs re-added before its environment matches again. */
    { path: ".intentic/capabilities.json", invalidates: ["capabilities", "environment", "panels", "manifests"], portability: "secret" },

    /* Which workspace-derived recommendations the owner has said "not needed" to, and the evidence each was
     * declined against. It rides the `capabilities` key because the catalog is what changes when one lands, and
     * it travels because a decision about what this workspace does NOT need is as much the owner's as the
     * connections themselves — an export that dropped it would greet them on the target with the same
     * suggestions they had already dismissed. Holds no credential: it is a card name and a file path. */
    { path: ".intentic/capability-dismissals.json", invalidates: ["capabilities"], portability: "carry", versioned: true },

    /* The named personas this sandbox shows the outside world — which connected accounts each one speaks for,
     * how it sounds, whether it may publish (schemas.ts PersonaSchema). It invalidates `capabilities` as well as
     * its own key because a card and the accounts it names are read together everywhere they are shown: connect
     * a second Reddit and the persona list has a new candidate; remove one and a card points at nothing.
     *
     * It is `carry`, and that is the whole design rather than an oversight — a card is a NAME and a list of ids,
     * never a credential, so it travels to a new sandbox in full while the logins it refers to stay behind. What
     * arrives is a workspace that already knows it has a work-reddit and a studio-x, both visibly unconnected,
     * each waiting for one sign-in. It was also the FIRST file under .intentic the root repo tracked, and the
     * argument it was carved out on — a card is configuration, holds no secret, and belongs in review — is the
     * one `versioned` now generalises to the rest of the config slice (personas/personas-store.ts argues it at
     * length, and its reasoning is why the flag exists rather than a second hand-kept list). */
    { path: ".intentic/personas.json", invalidates: ["personas", "capabilities", "manifests"], portability: "carry", versioned: true },

    /* The overlay Dockerfile, four files that a single `.intentic/environment.` prefix used to cover. They are
     * split here because they answer PORTABILITY differently while answering invalidation identically, and the
     * split is the whole difference between an export that reproduces an environment and one that reproduces a
     * stale copy of it:
     *   - custom is the owner-approved SOURCE OF TRUTH and the only one that must travel;
     *   - approved is COMPOSED from custom + the capability fragments + this container's base image, and is
     *     rewritten on the target's first boot — carrying it would ship a FROM naming an image the target may
     *     not be on (see composeEnvironment's baseImageOf);
     *   - the proposal and the per-tool drafts under environment.d/ are the agent's pending requests, which the
     *     owner has not answered yet; they travel so the question survives the move. */
    { path: ".intentic/environment.custom.Dockerfile", invalidates: ["environment"], portability: "carry", versioned: true },
    { path: ".intentic/environment.Dockerfile", invalidates: ["environment"], portability: "carry", versioned: true },
    { path: ".intentic/environment.d/", invalidates: ["environment"], portability: "carry", versioned: true },
    {
        path: ".intentic/environment.approved.Dockerfile",
        invalidates: ["environment"],
        portability: "derived",
        note: "The target composes its own overlay on first boot; rebuild it there to install the tools it names.",
    },

    { path: ".intentic/settings.json", invalidates: ["settings", "manifests"], portability: "carry", versioned: true },
    // The rule table's last-fired stamps, beside the rules themselves. `derived` rather than `carry`: it is a
    // record of what happened in THIS sandbox, and carrying it to a fresh one would date every rule to work
    // that machine never did.
    {
        path: ".intentic/rule-firings.json",
        invalidates: ["rule-firings"],
        portability: "derived",
        note: "Stamps of when each rule last did something; the new sandbox starts its own record.",
    },
    // Written by the AGENT's file tools (the drafts skill), read by the owner's approval inbox — the one entry
    // here whose whole point is that a change arrives from outside the browser that renders it.
    { path: ".intentic/drafts/", invalidates: ["drafts"], portability: "carry" },
    // ---- declared by the extension that renders them (contributes.files), not here ----
    // The path is the DAEMON's (automations-store writes both), the query keys are the intentic.automations
    // extension's. It declares them in its own manifest and the browser unions the two lists, so uninstalling
    // the extension takes its invalidations with it instead of leaving a rule for a view that no longer exists.
    {
        path: ".intentic/automations.json",
        invalidates: [],
        why: "Declared by the intentic.automations extension's contributes.files — `automations` is its query key, not core's.",
        portability: "carry",
        versioned: true,
    },
    {
        path: ".intentic/approvals/",
        invalidates: [],
        why: "Declared by the intentic.automations extension's contributes.files — `automation-approvals` is its query key, not core's.",
        portability: "carry",
    },
    {
        path: ".intentic/automations.seeded.json",
        invalidates: [],
        why: "Which default automations this workspace has been offered (default-automations.ts); nothing renders it — it exists so deleting a seeded automation is final.",
        portability: "carry",
        versioned: true,
    },
    /* The workflow designs and their run ledger became CORE keys the day runs got cards on the fleet board and
     * a mode of the chat panel (web's useWorkflowRuns): those surfaces exist whether or not the workflows
     * extension is enabled, so their freshness cannot ride an extension's contributes.files — an owner turning
     * the extension off would have frozen the board's run cards mid-run. This push is the ONLY live feed the
     * run surfaces have: the scheduler writes the ledger several times per step and nothing polls for it.
     * The runs file invalidates `workflows` too, because GET /workflows embeds each design's runs
     * (WorkflowSummary) — a settled step changes that answer as surely as an edited design does. */
    { path: ".intentic/workflows.json", invalidates: ["workflows"], portability: "carry", versioned: true },
    { path: ".intentic/workflow-runs.json", invalidates: ["workflows", "workflow-runs"], portability: "carry" },
    /* The SAVED loops, which are a manifest and so the opposite of the ledger below them: a handful of entries
     * a person authors, read by two surfaces at once — the workflows page that owns them, and every chat
     * composer's loop picker. Those two are in different windows as often as not (a popped-out chat is its own
     * window), so an edit made on the page has to reach a picker nobody is going to think to reopen. A CORE key
     * rather than the workflows extension's, for the reason the workflow designs beside it are: the composer
     * lists saved loops whether or not that extension is switched on. */
    { path: ".intentic/loop-designs.json", invalidates: ["loop-designs"], portability: "carry", versioned: true },
    {
        path: ".intentic/loops.json",
        invalidates: [],
        why: "Ralph loops and their iteration history. Nothing observes it: where a RUNNING loop stands rides on the fleet roster (AgentSummary.loop), which the /events stream already pushes about once a second, and a second source invalidating on this file could only ever disagree with the card beside it. The iteration list of an ENDED loop is an on-demand read — nothing renders it until someone opens it (web's useLoops, which holds no query for exactly this reason).",
        portability: "carry",
    },

    /* ---- reached by no query, for reasons that are not oversights ----
     *
     * This channel's currency is a QUERY KEY, and invalidation only reaches a query something is observing.
     * Both entries below are outside that by design, so an empty set is the honest record — naming a key no
     * query uses would put the drift this table exists to remove straight back into it. Each says which
     * constraint would have to move first, so the next reader doesn't re-derive it. */
    {
        path: ".intentic/webchat-installs.json",
        invalidates: [],
        why: "Which origins have loaded a Doorbell's widget, written on a 30s flush timer while a customer's site serves page views. The install panel that renders it fetches on open and polls itself while it is on screen, which is the whole window in which the answer changes for anyone. Pushing instead would bill every connected browser a refetch per flush, for a panel almost nobody has open.",
        portability: "carry",
    },
    {
        path: ".intentic/thread-sessions.json",
        invalidates: [],
        why: "Thread bookkeeping (an inbound thread — a Doorbell visitor, a Discord or Slack channel — → sandbox conversation + provider session), written on EVERY inbound message. Nothing in the browser reads it: what a thread produces is a conversation, and the fleet board already learns about that from the agent registry's own push. Naming a key here would bill every connected browser a refetch per inbound message — the request storm this table's own note warns about — to refresh nothing it can see.",
        portability: "carry",
    },
    /* Values are a primitive union an extension chooses the meaning of, and "an API key for the service I talk
     * to" is squarely within it — so this is classed by what it CAN hold, not by what any particular extension
     * happens to put there. The alternative reads the wrong way round: a bundle that leaked one extension's
     * token would have been correct about all the others. */
    {
        path: ".intentic/extension-settings.json",
        invalidates: [],
        why: "Held in a module-level shallowRef store per extension (web's extensionSettingsStore) with no query observer, and deliberately so: api.settings.get must answer SYNCHRONOUSLY from an extension's first activate() line, and the store outlives every component scope. A module-level QueryObserver is the one shape that would make invalidation refetch, and this app already ruled it out — it detaches on the queryClient.clear() at logout (see useSandbox's sandbox-list mirror). So a remote member's setting edit reaches this browser on its next load, not live.",
        portability: "secret",
        note: "Re-enter each extension's settings on the Extensions tab.",
    },
    /* Unlike the settings file above it, the on/off switch IS observed by a query — the Extensions tab's list,
     * which carries each row's switch position — so a flip made elsewhere (another member, the agent writing the
     * file) shows up here live. It does not re-run the host: activating or retiring an extension is the loader's
     * reconcile, which the tab's own toggle triggers, so a remote flip takes effect on this browser's next load. */
    {
        path: ".intentic/extension-enablement.json",
        invalidates: ["extensions"],
        portability: "carry",
        versioned: true,
    },
    /* Workspace extensions: one directory per extension, consumed straight from the workspace — no clone, no
     * install moment. Written like drafts, by the agent's own file tools (which is the point: an agent authors
     * an extension and it is live for the daemon and every session at once, since .intentic is shared), so this
     * push is what makes one appearing or changing show up on the Extensions tab while the owner watches. */
    { path: ".intentic/workspace-extensions/", invalidates: ["extensions"], portability: "carry" },
    /* Carried, because the evidence is about the extension rather than about the machine: an export that dropped
     * it would arrive claiming every permission was unused, which is worse than arriving with no figures at all. */
    {
        path: ".intentic/extension-usage.json",
        invalidates: [],
        why: "Which of the routes each extension DECLARED it has actually called — the evidence behind the permissions list on its row. The one entry here whose empty set is a RATE decision rather than an architectural one: every browser with the app open reports its batch on a timer, so wiring this to the `extensions` query would refetch the whole list every few seconds for a figure nobody is watching change. The tab reads it when it loads, which is when anyone is reading it.",
        portability: "carry",
    },
    /* The creator pool's day bits: which PREMIUM extensions saw use, per UTC day — all the revenue share runs
     * on, and all that ever leaves the sandbox. Nothing watches it and nothing renders it; it exists so the
     * owner can read exactly what their sandbox reported. Identity, not carry: the days are THIS machine's
     * report, the platform's ledger already holds every one it sent, and a bundle that carried them would
     * re-report one machine's use as another's. */
    {
        path: ".intentic/extension-active-use.json",
        invalidates: [],
        why: "Which premium extensions saw use, per UTC day — the sandbox's half of the creator-pool ledger, written by the daemon for its own reporter (platform/pool-report.ts). No view renders it, so a change invalidates nothing; it exists on disk so the owner can read exactly what their sandbox reported and nothing more.",
        portability: "identity",
        note: "Use days stay with the machine that reported them; the new sandbox starts its own.",
    },
    {
        path: ".intentic/members.json",
        invalidates: [],
        why: "Not this view's source at all: SandboxAccess renders the PLATFORM's invite records (apiClient.invite.list), and this file is the daemon's ENFORCED copy — written first so a grant the enforcer never got is never recorded, then never read back. A change here means the two disagreed, which the write order makes fail-closed rather than stale.",
        portability: "identity",
        note: "Re-invite collaborators from the Access tab — a grant is the platform's record, and the target enforces its own copy.",
    },

    // ---- daemon-owned, nothing derives from watching them ----
    /* Keep credentials and conversation state in disjoint top-level trees. Provider homes are intentionally
     * classified as a single secret unit: several CLIs mix OAuth, config, and provider-native thread metadata,
     * and no generic export can safely distinguish those files. The broad root also makes a newly-added provider
     * secret by construction instead of relying on another hand-maintained provider-name list. */
    {
        path: ".intentic/auth/",
        invalidates: [],
        why: "AI-provider credentials and runtime homes; each account is rendered through owner-gated provider routes.",
        portability: "secret",
        note: "Sign the agent's AI accounts in again on the Agent tab.",
    },
    /* Agent session transcripts, rewritten on every streamed token.
     *
     * The memory notes under it (`projects/<slug>/memory/**`) ARE user-facing and the /memory view polls them
     * every 30s, which is the one place in this table where a poll survives a real change feed being available.
     * It stays a poll deliberately: the watcher's exclusion is a DESCENT filter, so reaching those notes means
     * letting it walk `.intentic/sessions/claude` → `projects` → every project slug. Measured on the live
     * workspace that is +119 watched directories against ~593 today (a fifth more), with 314 continuously-
     * rewritten transcripts inside the newly-watched set, to make ONE memory directory live. Notes change at
     * agent-turn cadence, so the poll costs a request a minute and the alternative costs a permanent 20% on the
     * watcher. */
    {
        path: ".intentic/sessions/claude/",
        invalidates: [],
        why: "Agent session transcripts — see the note above on why the memory notes under it stay polled.",
        portability: "carry",
    },
    {
        path: ".intentic/artifacts/",
        invalidates: [],
        why: "Durable outputs owned by conversations and extension runs: attachments, browser captures, generated images, acceptance reports, and loop ledgers.",
        portability: "carry",
    },
    {
        path: ".intentic/cache/",
        invalidates: [],
        why: "Rebuildable indexes and caches; ignored by the watcher and recreated from carried workspace content.",
        portability: "derived",
    },
    {
        path: ".intentic/verify.json",
        invalidates: [],
        why: "The dependency verifier's verdict memory; nothing renders it directly — outcomes reach the owner as activity entries and workspace events.",
        portability: "carry",
    },
    {
        path: ".intentic/verify/",
        invalidates: [],
        why: "A running check's wrapper artifacts (log + exit status), read once by the daemon when the panel finishes.",
        portability: "derived",
    },
    {
        path: ".intentic/ci.json",
        invalidates: [],
        why: "Webhook secret + conclusion memory; the Pipelines view reads it through /ci/runs, not off disk.",
        portability: "secret",
        note: "Re-add the CI webhook on the Pipelines view — its secret is per-sandbox.",
    },
    {
        path: ".intentic/control-tokens.json",
        invalidates: [],
        why: "Hashed control tokens (the ACP editor bridge, and anything else driving this sandbox from outside), listed on demand by the owner.",
        portability: "identity",
        note: "Mint fresh control tokens — the old ones authenticate against the source sandbox.",
    },
    {
        path: ".intentic/owner.json",
        invalidates: [],
        why: "Bound once on first use; a change here means the sandbox was re-owned, which re-authenticates anyway.",
        portability: "identity",
    },
    {
        path: ".intentic/workspace.json",
        invalidates: [],
        why: "The workspace identity, read from the /events hello frame rather than as a file.",
        portability: "identity",
    },
    {
        path: ".intentic/templates.json",
        invalidates: [],
        why: "Scaffold templates, read when the scaffold dialog opens.",
        portability: "carry",
        versioned: true,
    },
    /* Classed `derived` for size rather than for safety, and it is the one entry where that costs the owner
     * something real: the profiles ARE logged-in sessions. They are also gigabytes of a store Chromium rewrites
     * constantly and versions against its own build, so carrying them ships bulk that the target's Chromium may
     * refuse anyway. The note is what keeps the loss visible instead of silent. */
    {
        path: ".intentic/browser/",
        invalidates: [],
        why: "Browser-login profiles: Chromium rewrites these constantly. Descent-ignored by the watcher outright.",
        portability: "derived",
        note: "Log the agent's browser back into any site it needs — profiles do not travel.",
    },
    {
        path: ".intentic/extensions/",
        invalidates: [],
        why: "Extension checkouts — whole git clones. The `extensions` query is driven by the capability manifest above, not by their contents.",
        portability: "derived",
        note: "Extensions re-clone from the capability manifest on the target's next reconcile.",
    },
    { path: ".intentic/plugins/", invalidates: [], why: "Agent plugin dirs, read by the SDK's loader each turn.", portability: "carry" },
    /* THE SKILLS THE OWNER WROTE THEMSELVES, one directory per skill — the source of truth the reconciler copies
     * into `.claude/skills` for the ones currently switched on (settings.json's `skills` list). It is here rather
     * than in `.claude/` for the reason the plugin dirs are: that tree is Claude Code's to manage, and a skill
     * switched off has to keep its text somewhere the loader will not read it from.
     *
     * `versioned`, like the rest of the config slice: a skill changes how the agent behaves, so it earns a diff
     * in the Changes review and a line in `git log` the same way a rule or a persona does. `carry` for the same
     * reason — it is text the owner wrote, with no credential in it and nothing about this machine. */
    { path: ".intentic/skills/", invalidates: ["skills"], portability: "carry", versioned: true },
] as const satisfies readonly WorkspaceStateFile[];

export const WORKSPACE_STATE_FILES: readonly WorkspaceStateFile[] = STATE_FILES;

/* The entries the root repo tracks, workspace-root-relative and in declaration order — what history.ts turns
 * into the negations that carve them back out of the wholesale `.intentic` exclusion.
 *
 * Derived rather than written down beside the exclude rule, for the reason this whole file exists: the git rule
 * lives in the daemon and the classification lives here, and a second hand-kept copy of "which config is
 * reviewable" is a copy that goes stale the first time someone adds a store. Marking an entry `versioned` is now
 * the entire change — the exclude list follows on the next boot, in both places it is written. */
export const VERSIONED_STATE_PATHS: readonly string[] = WORKSPACE_STATE_FILES.filter((file) => file.versioned).map((file) => file.path);

/* The manifests whose problems the unreadable-manifest notice SHOWS — the handful a person hand-edits — and the
 * one fact that decides it is already in the table above.
 *
 * Every store reads through the same `jsonFile`, so every store reports what it could not make sense of, and for
 * a long time the notice showed all of them. That is wrong twice over. Its advice — fix the file and this clears
 * on its own — is addressed to somebody holding an editor, which is true of `settings.json` and false of a
 * daemon-written LEDGER nobody opens: a run history that stopped matching a schema the build tightened is not a
 * mistake the owner made, and the card asked them to repair sixty kilobytes of machine JSON by hand. Worse, a
 * file that reports into the notice without feeding the notice's QUERY leaves a complaint no write can refresh,
 * so it sits on screen until the daemon restarts — which is exactly how the workflow ledger's entry became
 * permanent furniture.
 *
 * Both follow from one rule, which is why this derives rather than lists: a file's problems are shown IFF a write
 * to that file refreshes the notice. Declaring `manifests` in `invalidates` is the entire opt-in, so the edit
 * that puts a file on the card is the same edit that keeps it current, and neither can be done without the
 * other. A ledger that breaks still falls back and still sets its unreadable bytes aside on the next write
 * (store/json-file.ts) — it just stops asking the owner to fix it. */
export const REPORTED_MANIFEST_PATHS: readonly string[] = WORKSPACE_STATE_FILES.filter((file) => file.invalidates.includes("manifests")).map(
    (file) => file.path,
);

// Accepts either separator, like isLockedWorkspacePath below: the daemon holds these as platform paths and makes
// them relative at the last moment, and normalizing at each call site is the one that eventually gets forgotten.
export const isReportedManifest = (relPath: string): boolean => REPORTED_MANIFEST_PATHS.includes(relPath.replaceAll("\\", "/"));

/* Old directory names are never read or migrated, but persistent workspaces can retain them until an owner
 * removes them manually. Keep that finite set in one quarantine record so access, export, and search cannot
 * reinterpret abandoned machine state as ordinary workspace content after a rename. `artifacts` still carry;
 * the distinction here tells portability only which retired roots are secrets or derived. */
export const RETIRED_WORKSPACE_STATE_DIRS = {
    secret: ["claude", "codex", "kimi", "opencode", "cliproxy"],
    derived: ["iq", "extensions-runtime"],
    artifacts: ["attachments", "acceptance", "loops"],
} as const;

/* THE DAEMON'S OWN CONTROL PLANE — the entries directly under the workspace root's `.intentic/` that the file
 * API refuses to read, write, move or delete for anyone, the owner included (workspace/workspace-files.ts holds
 * the enforcement and the full reasoning for each name).
 *
 * The list lives HERE, in the package both sides import, because the browser has to draw the same rule the
 * daemon enforces. It didn't, and the gap was a small piece of theatre: the explorer listed `capabilities.json`
 * like any other file, opening it flashed a tab, the read came back with nothing there, and the tab closed
 * itself — a refusal acted out as a glitch. A file the app will not open should say so before it is clicked,
 * which takes a rule the explorer can consult, not a status code it can only react to.
 *
 * Naming these to the browser gives nothing away that the tree did not already publish — it listed them, sizes
 * and all. What stays behind the guard is the only thing that ever mattered: the bytes. */
const LOCKED_STATE_ENTRIES: ReadonlySet<string> = new Set([
    "owner.json",
    "members.json",
    "capabilities.json",
    "ci.json",
    "claude.json",
    "auth",
    "sessions",
    "browser",
    ...RETIRED_WORKSPACE_STATE_DIRS.secret,
]);

/* Whether a workspace-root-relative path lands in that control plane — and so is shown locked rather than
 * opened. Scoped deliberately tight, matching the guard: only the ROOT `.intentic` counts (a repo's own nested
 * one is ordinary content) and only these entries within it, subtrees included, so a new provider dropped under
 * `auth/` is covered without a second edit.
 *
 * The ROOT's own `.git` joins them. It is the pointer to the shadow history repo kept off the workspace so the
 * agent cannot rewrite its own past; a NESTED repo's `.git` is ordinary content and stays browsable.
 *
 * Accepts either slash so a caller holding a platform path doesn't have to normalize first. */
export const isLockedWorkspacePath = (relPath: string): boolean => {
    const segments = relPath.split(/[\\/]/).filter((segment) => segment !== "" && segment !== ".");
    if (segments[0] === ".git") {
        return true;
    }
    return segments.length >= 2 && segments[0] === STATE_DIR && LOCKED_STATE_ENTRIES.has(segments[1] ?? "");
};

/* Every path this table declares, as a type. `as const` above is what makes it one, and it is what finally makes
 * the first sentence of this file's header TRUE rather than aspirational.
 *
 * "The daemon builds its store paths from `path`" was the design; the code did not. `composition.ts` and twenty
 * files beside it spelled the same layout a SECOND way — `join(root, ".intentic", "settings.json")` — with
 * nothing tying the two spellings together. Rename a store's file and this table keeps declaring the old name:
 * no error, no failing test, just a view that quietly stops refreshing, which is the exact failure the table was
 * written to end and the exact way drafts went missing.
 *
 * So the daemon joins through `statePath` (workspace/state-paths.ts), which takes one of THESE and nothing else.
 * A rename is now a compile error at every site that names the file, in both packages, or it is not a rename. */
export type WorkspaceStatePath = (typeof STATE_FILES)[number]["path"];

/* The query keys a batch of changed paths makes stale, deduped and stable. The browser's `/events` handler calls
 * this; keeping it here rather than in the web means the rule is unit-testable without a query client, and the
 * daemon can assert against the same table.
 *
 * `contributed` is what the ACTIVATED extensions declared in `contributes.files` — passed in rather than
 * imported, because which extensions are live is a browser fact this package has no way to know. It is a
 * required argument for the same reason: an added second source that callers may forget is a source that
 * silently does nothing, which is the failure this whole file exists to remove. Extension entries are unioned
 * flat with the core ones, not layered over them: both lists describe the same fact about the same file, and a
 * path can legitimately match one entry in each — a core prefix that invalidates nothing must not veto a
 * narrower extension entry beneath it, or everything under one of the daemon's machine-state prefixes would be
 * unreachable to extensions by construction. */
export const staleQueryKeys = (paths: readonly string[], contributed: readonly FileContribution[]): readonly string[] => [
    ...new Set(
        [...WORKSPACE_STATE_FILES, ...contributed]
            .filter((file) => file.invalidates.length > 0 && paths.some((path) => path.startsWith(file.path)))
            .flatMap((file) => file.invalidates),
    ),
];

/* Every query key any watched file feeds — what a NEW /events connection invalidates wholesale (core's table
 * plus the running extensions'). The file push is these keys' ONLY live feed, and a `workspaceChanged` frame
 * produced while the stream was down is a frame nobody will ever resend — so each key's view would sit stale
 * until the file's NEXT write, indefinitely for anything that settled while the browser was away. Re-asking on
 * connect bounds the damage at one cheap read per key, which is what lets those views go entirely unpolled. */
export const fileBoundQueryKeys = (contributed: readonly FileContribution[]): readonly string[] => [
    ...new Set([...WORKSPACE_STATE_FILES, ...contributed].flatMap((file) => file.invalidates)),
];
