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
    WorkspaceHealthQuerySchema,
    WorkspaceHealthSchema,
    WorkspaceInstallResultSchema,
    WorkspaceInstallSchema,
    WorkspaceMoveSchema,
    WorkspaceResolveQuerySchema,
    WorkspaceResolveSchema,
    WorkspaceSetupSchema,
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
    // Which file a NAMED reference means — the lookup behind every clickable path in the UI. A path an agent
    // wrote in prose is often only a suffix of the real one, so it is matched against the workspace tree rather
    // than trusted as root-relative.
    resolve: oc.route({ method: "GET", path: "/workspace/resolve" }).input(WorkspaceResolveQuerySchema).output(WorkspaceResolveSchema),
    // Ranked groups, match-reason tags, freshness, resumable cursor. `mode` narrows to one verb; default is
    // auto-mode fusion. (Implementation detail: the daemon backs this with a resident in-process iq engine.)
    search: oc.route({ method: "GET", path: "/workspace/search" }).input(WorkspaceSearchQuerySchema).output(WorkspaceSearchResultSchema),
    // One repository's health in numbers: churn × complexity per file, index totals, and the import graph's
    // top modules — the `hotspots` and `map` rankings the CLI prints, shaped for a panel. Repo-scoped, because
    // "the codebase" is a repo, not the whole /work drop.
    health: oc.route({ method: "GET", path: "/workspace/health" }).input(WorkspaceHealthQuerySchema).output(WorkspaceHealthSchema),
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
    // Dependency readiness for every project under /work, and the install that fixes it. An imported project
    // arrives without node_modules/.venv (the drop omits them), so "the files landed" is not "this works":
    // until setup says ready, its type-checks and tests can only lie. The install runs as a one-shot tmux panel
    // like a dev server or add-app — attachable, survives a reload, output kept in the terminal logs.
    setup: oc.route({ method: "GET", path: "/workspace/setup" }).output(WorkspaceSetupSchema),
    install: oc.route({ method: "POST", path: "/workspace/setup/install" }).input(WorkspaceInstallSchema).output(WorkspaceInstallResultSchema),
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
