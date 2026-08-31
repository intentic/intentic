import { oc } from "@orpc/contract";
import { WorkspaceHealthQuerySchema, WorkspaceHealthSchema } from "../schemas/codebase-health.js";
import { WorkspaceModulesSchema } from "../schemas/git.js";
import { OkSchema } from "../schemas/shared.js";
import {
    AddAppsSchema,
    AppParamSchema,
    AppsListSchema,
    CloneRepoSchema,
    CloneResultSchema,
    RepoAppsParamSchema,
    ReposListSchema,
    RunTestsSchema,
    TemplatesListSchema,
    WorkspaceGraphSchema,
    WorkspaceSyncSchema,
} from "../schemas/workspace-repos.js";
import { WorkspaceSearchQuerySchema, WorkspaceSearchResultSchema } from "../schemas/workspace-search.js";
import { WorkspaceInstallResultSchema, WorkspaceInstallSchema, WorkspaceSetupSchema } from "../schemas/workspace-setup.js";
import {
    WorkspaceChildrenQuerySchema,
    WorkspaceChildrenSchema,
    WorkspaceClassificationSchema,
    WorkspaceDirSchema,
    WorkspaceFileQuerySchema,
    WorkspaceFileReadQuerySchema,
    WorkspaceFileSchema,
    WorkspaceMediaTicketQuerySchema,
    WorkspaceMediaTicketSchema,
    WorkspaceMoveSchema,
    WorkspaceResolveQuerySchema,
    WorkspaceResolveSchema,
    WorkspaceScopeSchema,
    WorkspaceTreeSchema,
} from "../schemas/workspace-tree.js";

// The full /work view + extra-repo cloning. The binary preview (/workspace/raw) is intentionally NOT here, it
// stays a plain Hono route serving raw bytes with a Content-Type header (oRPC's request/response shape doesn't
// fit a streamed binary body). External MCP tools moved to the unified capabilities manifest (mcp kind).
export const workspaceContract = {
    // `agent` names whose copy of the workspace to read (WorkspaceScopeSchema); omitted is the shared /work
    // tree. Every read route below takes it, so a link into a conversation's own checkout browses as one tree
    // rather than as one openable file surrounded by the shared one.
    tree: oc
        .route({
            method: "GET",
            path: "/workspace/tree",
            summary: "The workspace file tree",
            description:
                "Every folder and file under the workspace root, as one walk. Name a conversation to read its own private copy of the tree instead of the shared one. Folders the daemon skips, such as installed packages, come back without their contents; ask for those separately.",
        })
        .input(WorkspaceScopeSchema)
        .output(WorkspaceTreeSchema),
    // Lazy-load one directory's children, the tree returns ignored dirs (node_modules, .git, …) without children,
    // and the client fetches them here on expand so a giant node_modules can't blow the tree walk's entry budget.
    // Bounded depth is for consumers that need a small subtree as data rather than one explorer row at a time.
    children: oc
        .route({
            method: "GET",
            path: "/workspace/children",
            summary: "A bounded folder listing",
            description:
                "The entries inside a folder as one flat list. Direct children are the default, which is how the explorer opens a folder the full tree walk left closed; callers that need a small subtree can ask for up to five levels without a request per directory.",
        })
        .input(WorkspaceChildrenQuerySchema)
        .output(WorkspaceChildrenSchema),
    // One WINDOW of a file's text (plus the file's total size), never the whole file: the browser reads text
    // through here, and an unbounded read on an HTTP route is a way for any open log to stall the daemon.
    file: oc
        .route({
            method: "GET",
            path: "/workspace/file",
            summary: "Read part of a text file",
            description:
                "A window of one file's text, plus how large the whole file is. Never the entire file: an unbounded read is how a single enormous log stalls the daemon for everyone, so ask for the slice you mean to show and page through if you need more.",
        })
        .input(WorkspaceFileReadQuerySchema)
        .output(WorkspaceFileSchema),
    /* The ticket a media element presents to GET /workspace/media (a plain Hono route, like /workspace/raw,
     * it answers a streamed byte RANGE, which oRPC has no shape for). Minting is here rather than beside it so
     * it rides the bearer middleware and the contract's route advertisement: a browser can tell whether the
     * sandbox in front of it can stream video at all, instead of learning it from a 404 mid-playback. */
    mediaTicket: oc
        .route({
            method: "POST",
            path: "/workspace/media-ticket",
            summary: "Get a pass for streaming a media file",
            description:
                "Mints the short-lived ticket a video or audio element hands to the streaming route, which serves byte ranges and so cannot carry an ordinary header. Minting it here means a caller can tell whether this sandbox streams media at all, rather than discovering it mid-playback.",
        })
        .input(WorkspaceMediaTicketQuerySchema)
        .output(WorkspaceMediaTicketSchema),
    // Which file a NAMED reference means, the lookup behind every clickable path in the UI. A path an agent
    // wrote in prose is often only a suffix of the real one, so it is matched against the workspace tree rather
    // than trusted as root-relative.
    resolve: oc
        .route({
            method: "GET",
            path: "/workspace/resolve",
            summary: "Turn a written path into a real file",
            description:
                "Matches a path somebody wrote in prose against the real tree and says which file it means. A path mentioned in a message is often only the tail of the real one, so this is the lookup behind every clickable file reference rather than a plain existence check.",
        })
        .input(WorkspaceResolveQuerySchema)
        .output(WorkspaceResolveSchema),
    // Ranked groups, match-reason tags, freshness, resumable cursor. `mode` narrows to one verb; default is
    // auto-mode fusion. (Implementation detail: the daemon backs this with a resident in-process iq engine.)
    search: oc
        .route({
            method: "GET",
            path: "/workspace/search",
            summary: "Search the code",
            description:
                "Ranked results across the whole workspace, grouped, each carrying why it matched and how fresh it is. Left alone it blends plain text, structure, meaning and history in one pass; narrow it to a single kind of search when you already know which you want. Long result sets resume from the cursor it hands back.",
        })
        .input(WorkspaceSearchQuerySchema)
        .output(WorkspaceSearchResultSchema),
    // One repository's health in numbers: churn × complexity per file, index totals, and the import graph's
    // top modules, the `hotspots` and `map` rankings the CLI prints, shaped for a panel. Repo-scoped, because
    // "the codebase" is a repo, not the whole /work drop.
    health: oc
        .route({
            method: "GET",
            path: "/workspace/health",
            summary: "A repo's shape in numbers",
            description:
                "Where one repo's risk sits: the files that change often and are complicated at once, what the index holds, and which modules the rest of the code leans on most. Scoped to a repo, because a codebase is a repo rather than the whole drop.",
        })
        .input(WorkspaceHealthQuerySchema)
        .output(WorkspaceHealthSchema),
    // Deterministic, no-LLM classification of the dropped workspace into coarse buckets (repositories / documents
    // / media / archives / other). Read-only proposal: the browser renders it and applies accepted moves via the
    // existing /workspace/move route, this route never touches the tree.
    classify: oc
        .route({
            method: "GET",
            path: "/workspace/classify",
            summary: "Sort a messy drop into buckets",
            description:
                "Proposes which of the loose things in the workspace are code, documents, media or archives. A read-only suggestion by fixed rules, with no model involved: nothing moves until a caller applies the moves it likes through the move call.",
        })
        .output(WorkspaceClassificationSchema),
    // Direct file management the browser drives against the /work tree (byte writes go through POST
    // /workspace/upload). oRPC's OpenAPI codec reads non-GET input from the JSON body, so delete sends {path}
    // in the body too (not the query), same as the POST routes.
    mkdir: oc
        .route({
            method: "POST",
            path: "/workspace/dir",
            summary: "Create a folder",
            description: "Makes a folder, and any missing folders above it.",
        })
        .input(WorkspaceDirSchema)
        .output(OkSchema),
    delete: oc
        .route({
            method: "DELETE",
            path: "/workspace/entry",
            summary: "Delete a file or folder",
            description:
                "Removes one entry and everything under it. The path travels in the body rather than the address, the same as every other write in this group.",
        })
        .input(WorkspaceFileQuerySchema)
        .output(OkSchema),
    move: oc
        .route({
            method: "POST",
            path: "/workspace/move",
            summary: "Move or rename something",
            description: "Moves one entry to a new path, which is also how you rename it.",
        })
        .input(WorkspaceMoveSchema)
        .output(OkSchema),
    copy: oc
        .route({
            method: "POST",
            path: "/workspace/copy",
            summary: "Copy a file or folder",
            description: "Duplicates one entry at a new path, recursively for a folder.",
        })
        .input(WorkspaceMoveSchema)
        .output(OkSchema),
    // Dependency readiness for every project under /work, and the install that fixes it. An imported project
    // arrives without node_modules/.venv (the drop omits them), so "the files landed" is not "this works":
    // until setup says ready, its type-checks and tests can only lie. The install runs as a one-shot tmux panel
    // like a dev server or add-app, attachable, survives a reload, output kept in the terminal logs.
    setup: oc
        .route({
            method: "GET",
            path: "/workspace/setup",
            summary: "Which projects have their dependencies installed",
            description:
                "Per project, whether its dependencies are actually present. A project that arrives by import comes without them, so files landing is not the same as the project working: until this says a project is ready, its type checks and tests can only mislead you.",
        })
        .output(WorkspaceSetupSchema),
    install: oc
        .route({
            method: "POST",
            path: "/workspace/setup/install",
            summary: "Install a project's dependencies",
            description:
                "Starts the install for one or more projects in a terminal you can attach to, and answers immediately. The run survives a page reload and its output stays in the terminal history.",
        })
        .input(WorkspaceInstallSchema)
        .output(WorkspaceInstallResultSchema),
    repos: oc
        .route({
            method: "GET",
            path: "/workspace/repos",
            summary: "Repos in the workspace",
            description: "Every git repo the daemon found in the workspace, with where each one sits and what it is called.",
        })
        .output(ReposListSchema),
    addRepo: oc
        .route({
            method: "POST",
            path: "/workspace/repos",
            summary: "Clone a repo in",
            description: "Clones a repository into the workspace beside the others, using whatever forge credentials the sandbox already holds.",
        })
        .input(CloneRepoSchema)
        .output(CloneResultSchema),
    // Force-fetch + guarded fast-forward every repo with a remote (mutates the tree ⇒ POST). The turn hook syncs
    // automatically each turn; this is the on-demand refresh (and how you re-sync a dirty/diverged repo after committing).
    sync: oc
        .route({
            method: "POST",
            path: "/workspace/sync",
            summary: "Pull every repo up to date",
            description:
                "Fetches every repo that has a remote and fast-forwards the ones that can move safely, reporting what happened to each. This runs by itself at the start of a turn; call it directly to refresh on demand, or to re-sync a repo that had drifted.",
        })
        .output(WorkspaceSyncSchema),
    // The addable app types the configured source repo offers (its templates.json), drives the apps
    // extension's Add-app picker.
    templates: oc
        .route({
            method: "GET",
            path: "/workspace/templates",
            summary: "App templates you can add",
            description: "The kinds of app the configured source repo knows how to scaffold, which is what an add-app picker lists.",
        })
        .output(TemplatesListSchema),
    // Per-monorepo apps, driven by the web app's apps extension (owner-authed; {repo} is validated in the
    // handler): add one or more apps into an existing monorepo, list them with per-app preview URL + status,
    // and start/stop each app's preview dev server. `addApps` kicks off a one-shot tmux job (session
    // panel-<repo>--add_apps) that runs `intentic scaffold add-app`, the attachable terminal is the progress/error
    // surface; the extension polls the session's `running` for completion. It returns immediately (an ack).
    addApps: oc
        .route({
            method: "POST",
            path: "/workspace/repos/{repo}/apps",
            summary: "Scaffold new apps into a repo",
            description:
                "Starts scaffolding one or more apps inside an existing multi-package repo and answers straight away. Watch the terminal it opens for progress and for anything that goes wrong.",
        })
        .input(AddAppsSchema)
        .output(OkSchema),
    appsList: oc
        .route({
            method: "GET",
            path: "/workspace/repos/{repo}/apps",
            summary: "Apps inside a repo",
            description: "The apps in one multi-package repo, each with its preview address and whether its dev server is up.",
        })
        .input(RepoAppsParamSchema)
        .output(AppsListSchema),
    // The monorepo's workspace package dependency graph (pnpm-workspace.yaml globs + per-package package.json
    // workspace deps), drives the apps extension's Dependencies view.
    packageGraph: oc
        .route({
            method: "GET",
            path: "/workspace/repos/{repo}/graph",
            summary: "How a repo's packages depend on each other",
            description: "Every package in one multi-package repo and which of its siblings each one uses, which is what a dependency view draws.",
        })
        .input(RepoAppsParamSchema)
        .output(WorkspaceGraphSchema),
    // Every repo's modules (the dirs owning a named package.json), what the review panels group changed files
    // under when the reader has asked for modules instead of paths. Whole-workspace rather than per-repo: a
    // review list spans repos, and one request per repo group would be a fan-out the panel pays on every open.
    modules: oc
        .route({
            method: "GET",
            path: "/workspace/modules",
            summary: "Every package across every repo",
            description:
                "The named packages in the whole workspace, which is what a review list groups changed files under when a reader wants packages rather than paths. Whole-workspace in one answer, because a review spans repos and asking per repo would be a fan-out on every open.",
        })
        .output(WorkspaceModulesSchema),
    startApp: oc
        .route({
            method: "POST",
            path: "/workspace/repos/{repo}/apps/{app}/start",
            summary: "Start an app's dev server",
            description: "Brings up one app's preview server in an attachable terminal, so its address starts answering.",
        })
        .input(AppParamSchema)
        .output(OkSchema),
    stopApp: oc
        .route({
            method: "POST",
            path: "/workspace/repos/{repo}/apps/{app}/stop",
            summary: "Stop an app's dev server",
            description: "Shuts one app's preview server down and frees its port.",
        })
        .input(AppParamSchema)
        .output(OkSchema),
    // Run vitest for the given repo-relative project dirs in a one-shot tmux panel session
    // (panel-<repo>--<session>), drives the apps extension's per-app / per-package / library Run-tests actions.
    // Mirrors addApps: it returns an ack; the attachable terminal is the result surface.
    runTests: oc
        .route({
            method: "POST",
            path: "/workspace/repos/{repo}/tests",
            summary: "Run a project's tests",
            description:
                "Starts the test run for the projects you name in an attachable terminal and answers straight away. The terminal is where the results appear.",
        })
        .input(RunTestsSchema)
        .output(OkSchema),
};
