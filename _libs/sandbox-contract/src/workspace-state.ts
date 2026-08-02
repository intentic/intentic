import type { FileContribution } from "@intentic/extension-api";
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
    { path: ".intentic/capabilities.json", invalidates: ["capabilities", "environment", "panels"], portability: "secret" },

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
    { path: ".intentic/environment.custom.Dockerfile", invalidates: ["environment"], portability: "carry" },
    { path: ".intentic/environment.Dockerfile", invalidates: ["environment"], portability: "carry" },
    { path: ".intentic/environment.d/", invalidates: ["environment"], portability: "carry" },
    {
        path: ".intentic/environment.approved.Dockerfile",
        invalidates: ["environment"],
        portability: "derived",
        note: "The target composes its own overlay on first boot; rebuild it there to install the tools it names.",
    },

    { path: ".intentic/settings.json", invalidates: ["settings"], portability: "carry" },
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
    },
    {
        path: ".intentic/approvals/",
        invalidates: [],
        why: "Declared by the intentic.automations extension's contributes.files — `automation-approvals` is its query key, not core's.",
        portability: "carry",
    },
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
    },
    {
        path: ".intentic/members.json",
        invalidates: [],
        why: "Not this view's source at all: SandboxAccess renders the PLATFORM's invite records (apiClient.invite.list), and this file is the daemon's ENFORCED copy — written first so a grant the enforcer never got is never recorded, then never read back. A change here means the two disagreed, which the write order makes fail-closed rather than stale.",
        portability: "identity",
        note: "Re-invite collaborators from the Access tab — a grant is the platform's record, and the target enforces its own copy.",
    },

    // ---- daemon-owned, nothing derives from watching them ----
    /* Agent session transcripts, rewritten on every streamed token.
     *
     * The memory notes under it (`projects/<slug>/memory/**`) ARE user-facing and the /memory view polls them
     * every 30s, which is the one place in this table where a poll survives a real change feed being available.
     * It stays a poll deliberately: the watcher's exclusion is a DESCENT filter, so reaching those notes means
     * letting it walk `.intentic/claude` → `projects` → every project slug. Measured on the live workspace that
     * is +119 watched directories against ~593 today (a fifth more), with 314 continuously-rewritten transcripts
     * inside the newly-watched set, to make ONE memory directory live. Notes change at agent-turn cadence, so the
     * poll costs a request a minute and the alternative costs a permanent 20% on the watcher. */
    /* THE STORE THAT IS TWO THINGS, hence two entries — this is the case stateFileFor's longest-match rule
     * exists for. `.intentic/claude/` is where linkClaudeState parks the Claude CLI's per-conversation state,
     * and (when AGENT_AUTH_DIR is unset, which is the production layout) it is ALSO the provider credential
     * root. The subtree under `projects/` is the half a bundle exists to carry — the agent's memory notes and
     * every conversation's transcript — while its siblings hold the OAuth that must not leave the sandbox. */
    {
        path: ".intentic/claude/",
        invalidates: [],
        why: "Agent session transcripts — see the note above on why the memory notes under it stay polled.",
        portability: "secret",
        note: "Sign the agent's AI accounts in again on the Agent tab.",
    },
    {
        path: ".intentic/claude/projects/",
        invalidates: [],
        why: "Same store as the entry above; split from it for portability, not for invalidation.",
        portability: "carry",
    },
    {
        path: ".intentic/ci.json",
        invalidates: [],
        why: "Webhook secret + conclusion memory; the Pipelines view reads it through /ci/runs, not off disk.",
        portability: "secret",
        note: "Re-add the CI webhook on the Pipelines view — its secret is per-sandbox.",
    },
    {
        path: ".intentic/komodo.json",
        invalidates: [],
        why: "Per-connection 'when the owner last looked at Deployments'; the view reads it through /komodo/{capability}/overview, not off disk — and it is written BY that view being opened, so invalidating on it would refetch the board in answer to the browser's own click.",
        portability: "carry",
    },
    {
        path: ".intentic/bridge-tokens.json",
        invalidates: [],
        why: "Hashed ACP bridge tokens, listed on demand by the owner.",
        portability: "identity",
        note: "Mint fresh ACP bridge tokens — the old ones authenticate against the source sandbox.",
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
    { path: ".intentic/templates.json", invalidates: [], why: "Scaffold templates, read when the scaffold dialog opens.", portability: "carry" },
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
] as const satisfies readonly WorkspaceStateFile[];

export const WORKSPACE_STATE_FILES: readonly WorkspaceStateFile[] = STATE_FILES;

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
