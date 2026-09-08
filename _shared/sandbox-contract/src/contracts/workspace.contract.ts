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

// The full /work view plus extra-repo cloning. /workspace/raw stays a plain Hono route (a streamed binary body doesn't
// fit oRPC's request/response shape).
// External MCP tools live in the capabilities manifest (mcp kind), not here.
export const workspaceContract = {
    // `agent` picks whose workspace copy to read (WorkspaceScopeSchema); omitted means the shared /work tree.
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
    // Lazy-loads a folder's children the tree walk skipped (node_modules, .git…) to bound its entry budget.
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
    // One window of a file's text plus its size, never the whole file: an unbounded read can stall the daemon.
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
    // Mints the ticket GET /workspace/media (a plain Hono byte-range route, no oRPC shape) requires to stream.
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
    // Matches a prose-written path, often just a suffix, against the tree rather than trusting it as root-relative.
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
    // `mode` narrows the search to one kind; default fuses text, structure, meaning and history in one pass.
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
    // Per-file churn × complexity, index totals, top modules; scoped to a repo, not the whole /work drop.
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
    // Deterministic, no-LLM classification into coarse buckets; read-only, applied only via the move route.
    classify: oc
        .route({
            method: "GET",
            path: "/workspace/classify",
            summary: "Sort a messy drop into buckets",
            description:
                "Proposes which of the loose things in the workspace are code, documents, media or archives. A read-only suggestion by fixed rules, with no model involved: nothing moves until a caller applies the moves it likes through the move call.",
        })
        .output(WorkspaceClassificationSchema),
    // Delete sends `{path}` in the body, not the query: oRPC's OpenAPI codec reads non-GET input from the body.
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
    // An imported project lacks node_modules/.venv; until this says ready, its type checks and tests can mislead.
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
    // Mutates the tree (fetch + fast-forward), which is why this is POST rather than GET.
    sync: oc
        .route({
            method: "POST",
            path: "/workspace/sync",
            summary: "Pull every repo up to date",
            description:
                "Fetches every repo that has a remote and fast-forwards the ones that can move safely, reporting what happened to each. This runs by itself at the start of a turn; call it directly to refresh on demand, or to re-sync a repo that had drifted.",
        })
        .output(WorkspaceSyncSchema),
    // The source repo's templates.json app types; drives the apps extension's Add-app picker.
    templates: oc
        .route({
            method: "GET",
            path: "/workspace/templates",
            summary: "App templates you can add",
            description: "The kinds of app the configured source repo knows how to scaffold, which is what an add-app picker lists.",
        })
        .output(TemplatesListSchema),
    // Runs as a one-shot tmux job named `panel-<repo>--add_apps`, executing `intentic scaffold add-app`.
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
    // The monorepo's package dependency graph, from pnpm-workspace.yaml globs and each package.json's deps.
    packageGraph: oc
        .route({
            method: "GET",
            path: "/workspace/repos/{repo}/graph",
            summary: "How a repo's packages depend on each other",
            description: "Every package in one multi-package repo and which of its siblings each one uses, which is what a dependency view draws.",
        })
        .input(RepoAppsParamSchema)
        .output(WorkspaceGraphSchema),
    // Every repo's package dirs in one call, since a review spans repos and per-repo would fan out per open.
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
    // Runs tests for the named dirs in a one-shot tmux panel; mirrors addApps: an ack, terminal as result surface.
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
