import { oc } from "@orpc/contract";
import {
    AddAppsSchema,
    AppParamSchema,
    AppsListSchema,
    CloneRepoSchema,
    CloneResultSchema,
    WorkspaceSearchResultSchema,
    WorkspaceSearchQuerySchema,
    OkSchema,
    RepoAppsParamSchema,
    ReposListSchema,
    RunTestsSchema,
    TemplatesListSchema,
    WorkspaceChildrenQuerySchema,
    WorkspaceChildrenSchema,
    WorkspaceClassificationSchema,
    WorkspaceDirSchema,
    WorkspaceFileQuerySchema,
    WorkspaceFileSchema,
    WorkspaceGraphSchema,
    WorkspaceMoveSchema,
    WorkspaceSyncSchema,
    WorkspaceTreeSchema,
} from "../schemas.js";

// The full /work view + extra-repo cloning. The binary preview (/workspace/raw) is intentionally NOT here — it
// stays a plain Hono route serving raw bytes with a Content-Type header (oRPC's request/response shape doesn't
// fit a streamed binary body). External MCP tools moved to the unified capabilities manifest (mcp kind).
export const workspaceContract = {
    tree: oc.route({ method: "GET", path: "/workspace/tree" }).output(WorkspaceTreeSchema),
    // Lazy-load one directory's children — the tree returns ignored dirs (node_modules, .git, …) without children,
    // and the client fetches them here on expand so a giant node_modules can't blow the tree walk's entry budget.
    children: oc.route({ method: "GET", path: "/workspace/children" }).input(WorkspaceChildrenQuerySchema).output(WorkspaceChildrenSchema),
    file: oc.route({ method: "GET", path: "/workspace/file" }).input(WorkspaceFileQuerySchema).output(WorkspaceFileSchema),
    // Ranked groups, match-reason tags, freshness, resumable cursor. `mode` narrows to one verb; default is
    // auto-mode fusion. (Implementation detail: the daemon backs this with a resident in-process iq engine.)
    search: oc.route({ method: "GET", path: "/workspace/search" }).input(WorkspaceSearchQuerySchema).output(WorkspaceSearchResultSchema),
    // Deterministic, no-LLM classification of the dropped workspace into coarse buckets (repositories / documents
    // / media / archives / other). Read-only proposal: the browser renders it and applies accepted moves via the
    // existing /workspace/move route — this route never touches the tree.
    classify: oc.route({ method: "GET", path: "/workspace/classify" }).output(WorkspaceClassificationSchema),
    // Direct file management the browser drives against the /work tree (byte writes go through POST
    // /workspace/upload). oRPC's OpenAPI codec reads non-GET input from the JSON body, so delete sends {path}
    // in the body too (not the query) — same as the POST routes.
    mkdir: oc.route({ method: "POST", path: "/workspace/dir" }).input(WorkspaceDirSchema).output(OkSchema),
    delete: oc.route({ method: "DELETE", path: "/workspace/entry" }).input(WorkspaceFileQuerySchema).output(OkSchema),
    move: oc.route({ method: "POST", path: "/workspace/move" }).input(WorkspaceMoveSchema).output(OkSchema),
    copy: oc.route({ method: "POST", path: "/workspace/copy" }).input(WorkspaceMoveSchema).output(OkSchema),
    repos: oc.route({ method: "GET", path: "/workspace/repos" }).output(ReposListSchema),
    addRepo: oc.route({ method: "POST", path: "/workspace/repos" }).input(CloneRepoSchema).output(CloneResultSchema),
    // Force-fetch + guarded fast-forward every repo with a remote (mutates the tree ⇒ POST). The turn hook syncs
    // automatically each turn; this is the on-demand refresh (and how you re-sync a dirty/diverged repo after committing).
    sync: oc.route({ method: "POST", path: "/workspace/sync" }).output(WorkspaceSyncSchema),
    // The addable app types the configured source repo offers (its templates.json) — drives the apps
    // extension's Add-app picker.
    templates: oc.route({ method: "GET", path: "/workspace/templates" }).output(TemplatesListSchema),
    // Per-monorepo apps, driven by the web app's apps extension (owner-authed; {repo} is validated in the
    // handler): add one or more apps into an existing monorepo, list them with per-app preview URL + status,
    // and start/stop each app's preview dev server. `addApps` kicks off a one-shot tmux job (session
    // panel-<repo>--add_apps) that runs `intentic scaffold add-app` — the attachable terminal is the progress/error
    // surface; the extension polls the session's `running` for completion. It returns immediately (an ack).
    addApps: oc.route({ method: "POST", path: "/workspace/repos/{repo}/apps" }).input(AddAppsSchema).output(OkSchema),
    appsList: oc.route({ method: "GET", path: "/workspace/repos/{repo}/apps" }).input(RepoAppsParamSchema).output(AppsListSchema),
    // The monorepo's workspace package dependency graph (pnpm-workspace.yaml globs + per-package package.json
    // workspace deps) — drives the apps extension's Dependencies view.
    packageGraph: oc.route({ method: "GET", path: "/workspace/repos/{repo}/graph" }).input(RepoAppsParamSchema).output(WorkspaceGraphSchema),
    startApp: oc.route({ method: "POST", path: "/workspace/repos/{repo}/apps/{app}/start" }).input(AppParamSchema).output(OkSchema),
    stopApp: oc.route({ method: "POST", path: "/workspace/repos/{repo}/apps/{app}/stop" }).input(AppParamSchema).output(OkSchema),
    // Run vitest for the given repo-relative project dirs in a one-shot tmux panel session
    // (panel-<repo>--<session>) — drives the apps extension's per-app / per-package / library Run-tests actions.
    // Mirrors addApps: it returns an ack; the attachable terminal is the result surface.
    runTests: oc.route({ method: "POST", path: "/workspace/repos/{repo}/tests" }).input(RunTestsSchema).output(OkSchema),
};
