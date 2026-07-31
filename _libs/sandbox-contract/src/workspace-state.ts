/* WHICH WORKSPACE FILE BACKS WHICH VIEW — one declaration, read by both sides of the wire.
 *
 * The daemon's own state lives under `<workspace>/.intentic/`, the agent edits it out-of-band with its file
 * tools, and the file watcher pushes every change as a `workspaceChanged` batch. Turning those paths back into
 * "and therefore this view is stale" used to be a hand-written table in the BROWSER (web's systemEventRouting),
 * maintained separately from the paths the daemon actually writes (composition.ts) — two lists of the same
 * fact, in two packages, with nothing tying them together.
 *
 * They drifted, exactly as that shape always does. `.intentic/drafts/` is written by the AGENT (the drafts
 * skill puts a file there) and rendered by the Drafts view, but it was never added to the browser's table — so
 * a draft appearing on disk while the owner watched the page changed nothing until they refocused the tab. The
 * same hole was open for extension settings and the members list.
 *
 * So the binding is declared HERE, once, in the package both the daemon and the browser already import, and
 * each side derives what it needs: the daemon builds its store paths from `path`, the browser builds its
 * invalidation table from `invalidates`. Adding a manifest without saying what it makes stale is now a change
 * to one visible list rather than an omission in a file nobody edits — and `workspace-state.test.ts` fails when
 * a daemon store names a `.intentic` path this list doesn't carry.
 *
 * This mirrors what routes.ts does for the route surface ("nothing is generated and nothing is hand-maintained")
 * one layer over: the same refusal to keep the same knowledge in two places. */

export interface WorkspaceStateFile {
    /* Workspace-root-relative, forward-slash — the space `workspaceChanged` paths arrive in. Matching is by
     * PREFIX, which lets one entry cover three shapes without a second matching rule:
     *   - an exact file      `.intentic/settings.json`
     *   - a directory        `.intentic/drafts/`     (one file per draft)
     *   - a name family      `.intentic/environment.` (…Dockerfile, .custom.Dockerfile, .approved.Dockerfile)
     * A directory entry keeps its trailing slash so it can never prefix-match a sibling file. */
    readonly path: string;
    /* The browser query keys this file's contents feed. EMPTY is a real answer, not a gap — a file the browser
     * renders nothing from, or one deliberately kept off the push path — and `why` says which. Never a prefix
     * test over `.intentic/` as a whole: one stray write must not cost every view a refetch, which is the
     * amplification that once turned an iq index rebuild into an endless request storm. */
    readonly invalidates: readonly string[];
    // Why this file has no invalidations, for the entries that declare none. Absent when it has some.
    readonly why?: string;
}

export const WORKSPACE_STATE_FILES: readonly WorkspaceStateFile[] = [
    // A capability add/remove recomposes the environment overlay and can add or drop a repo's panel.
    { path: ".intentic/capabilities.json", invalidates: ["capabilities", "environment", "panels"] },
    { path: ".intentic/environment.", invalidates: ["environment"] },
    { path: ".intentic/automations.json", invalidates: ["automations"] },
    { path: ".intentic/approvals/", invalidates: ["automation-approvals"] },
    { path: ".intentic/settings.json", invalidates: ["settings"] },
    // Written by the AGENT's file tools (the drafts skill), read by the owner's approval inbox — the one entry
    // here whose whole point is that a change arrives from outside the browser that renders it.
    { path: ".intentic/drafts/", invalidates: ["drafts"] },
    // ---- backed by a view that holds its own state, so there is no cached query to make stale ----
    // Both of these ARE user-facing and DO change out-of-band; they simply bypass the query cache, so the push
    // has nothing to invalidate. Listing them with an empty set is the honest record of that — and the place a
    // fix would start, by moving each view onto a query first. Naming a key that no query uses would only put
    // the drift this table exists to remove back into it.
    {
        path: ".intentic/extension-settings.json",
        invalidates: [],
        why: "Held in a shallowRef store keyed by extension (web's extensionSettingsStore), loaded on demand — not a vue-query. The `extensions` LIST query does not carry setting values, so invalidating it would refetch the wrong thing.",
    },
    {
        path: ".intentic/members.json",
        invalidates: [],
        why: "The access list is a local ref loaded on mount from the PLATFORM's invite record (web's SandboxAccess); the daemon's enforced list is written but never read back into the view.",
    },

    // ---- daemon-owned, nothing derives from watching them ----
    {
        path: ".intentic/gate.json",
        invalidates: [],
        why: "The landing gate's verdict is POLLED on purpose (web's useGate). Its fingerprint pass rewrites this file every couple of seconds while a check runs, and pushing that back would refetch the review set — the daemon's most expensive read — on every poll.",
    },
    {
        path: ".intentic/gate-index/",
        invalidates: [],
        why: "The gate's per-repo git index. Machine state, rewritten continuously by the fingerprint pass.",
    },
    {
        path: ".intentic/claude/",
        invalidates: [],
        why: "Agent session transcripts, rewritten on every streamed token. The memory notes under it ARE user-facing, but they are read through /memory rather than off this push.",
    },
    { path: ".intentic/ci.json", invalidates: [], why: "Webhook secret + conclusion memory; the Pipelines view reads it through /ci/runs, not off disk." },
    { path: ".intentic/bridge-tokens.json", invalidates: [], why: "Hashed ACP bridge tokens, listed on demand by the owner." },
    { path: ".intentic/owner.json", invalidates: [], why: "Bound once on first use; a change here means the sandbox was re-owned, which re-authenticates anyway." },
    { path: ".intentic/workspace.json", invalidates: [], why: "The workspace identity, read from the /events hello frame rather than as a file." },
    { path: ".intentic/templates.json", invalidates: [], why: "Scaffold templates, read when the scaffold dialog opens." },
    { path: ".intentic/browser/", invalidates: [], why: "Browser-login profiles: Chromium rewrites these constantly. Descent-ignored by the watcher outright." },
    { path: ".intentic/extensions/", invalidates: [], why: "Extension checkouts — whole git clones. The `extensions` query is driven by the capability manifest above, not by their contents." },
    { path: ".intentic/plugins/", invalidates: [], why: "Agent plugin dirs, read by the SDK's loader each turn." },
];

// The query keys a batch of changed paths makes stale, deduped and stable. The browser's `/events` handler
// calls this; keeping it here rather than in the web means the rule is unit-testable without a query client,
// and the daemon can assert against the same table.
export const staleQueryKeys = (paths: readonly string[]): readonly string[] => [
    ...new Set(
        WORKSPACE_STATE_FILES.filter((file) => file.invalidates.length > 0 && paths.some((path) => path.startsWith(file.path))).flatMap(
            (file) => file.invalidates,
        ),
    ),
];

// Every declared path, for the daemon's own guard that no store addresses `.intentic` off-list.
export const WORKSPACE_STATE_PATHS: readonly string[] = WORKSPACE_STATE_FILES.map((file) => file.path);
