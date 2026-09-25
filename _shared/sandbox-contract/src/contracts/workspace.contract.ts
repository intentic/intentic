import { procedure } from "../protocol/route-meta.js";
import { WorkspaceHealthQuerySchema, WorkspaceHealthSchema } from "../schemas/codebase-health.js";
import { WorkspaceModulesSchema } from "../schemas/git/git.js";
import { OkSchema } from "../schemas/shared.js";
import {
    AddAppsSchema,
    AppParamSchema,
    AppsListSchema,
    CloneRepoSchema,
    CreateRepoSchema,
    CloneResultSchema,
    RepoAppsParamSchema,
    ReposListSchema,
    RunTestsSchema,
    TemplatesListSchema,
    WorkspaceGraphSchema,
    WorkspaceSyncSchema,
} from "../schemas/workspace/workspace-repos.js";
import { MainlineStatusSchema } from "../schemas/workspace/mainline.js";
import { WorkspaceSearchQuerySchema, WorkspaceSearchResultSchema } from "../schemas/workspace/workspace-search.js";
import { WorkspaceInstallResultSchema, WorkspaceInstallSchema, WorkspaceSetupSchema } from "../schemas/workspace/workspace-setup.js";
import {
    WorkspaceChildrenQuerySchema,
    WorkspaceChildrenSchema,
    WorkspaceClassificationSchema,
    SidecarStatusSchema,
    WorkspaceDerivedQuerySchema,
    WorkspaceDerivedSchema,
    WorkspaceDirSchema,
    WorkspaceExtractSchema,
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
} from "../schemas/workspace/workspace-tree.js";

// The full /work view plus extra-repo cloning. /workspace/raw stays a plain Hono route (a streamed binary body doesn't
// fit oRPC's request/response shape).
// External MCP tools live in the capabilities manifest (mcp kind), not here.
export const workspaceContract = {
    // `agent` picks whose workspace copy to read (WorkspaceScopeSchema); omitted means the shared /work tree.
    tree: procedure
        .route({
            method: "GET",
            path: "/workspace/tree",
            summary: "The workspace file tree",
            description:
                "Every folder and file under the workspace root, as one walk. Name a conversation to read its own private copy of the tree instead of the shared one. Folders the daemon skips, such as installed packages, come back without their contents; ask for those separately.",
        })
        .meta({ guest: true })
        .input(WorkspaceScopeSchema)
        .output(WorkspaceTreeSchema),
    // Lazy-loads a folder's children the tree walk skipped (node_modules, .git…) to bound its entry budget.
    children: procedure
        .route({
            method: "GET",
            path: "/workspace/children",
            summary: "A bounded folder listing",
            description:
                "The entries inside a folder as one flat list. Direct children are the default, which is how the explorer opens a folder the full tree walk left closed; callers that need a small subtree can ask for up to five levels without a request per directory.",
        })
        .meta({ guest: true })
        .input(WorkspaceChildrenQuerySchema)
        .output(WorkspaceChildrenSchema),
    // One window of a file's text plus its size, never the whole file: an unbounded read can stall the daemon.
    file: procedure
        .route({
            method: "GET",
            path: "/workspace/file",
            summary: "Read part of a text file",
            description:
                "A window of one file's text, plus how large the whole file is. Never the entire file: an unbounded read is how a single enormous log stalls the daemon for everyone, so ask for the slice you mean to show and page through if you need more.",
        })
        .meta({ guest: true })
        .input(WorkspaceFileReadQuerySchema)
        .output(WorkspaceFileSchema),
    // The markdown shadow fileq keeps of a binary file; the read is a plain file read, no derivation triggered.
    derived: procedure
        .route({
            method: "GET",
            path: "/workspace/derived",
            summary: "Read a file's derived text",
            description:
                "What a document, picture, recording or archive says, as text, from the shadow the sandbox keeps beside it. This is the same rendering an agent reads instead of the bytes, so it is also the way to check what one is working from. Nothing is derived here: a file with no shadow yet answers that it has none, and whether it could have one.",
        })
        .meta({ guest: true })
        .input(WorkspaceDerivedQuerySchema)
        .output(WorkspaceDerivedSchema),
    // The lazy path, on demand: same convergence the background sweep runs, for one file someone is looking at.
    derive: procedure
        .route({
            method: "POST",
            path: "/workspace/derive",
            summary: "Derive a file's text now",
            description:
                "Renders one file to text and answers with the result, for when its shadow is missing or you want it rebuilt. The same work the background pass does when that setting is on, so this is how a reader gets the text without turning it on for the whole workspace. Costs a parse of exactly one file; a format nothing can read says so rather than failing.",
        })
        // Rendering one file as text is reading it: a regenerable cache entry, one parse of a readable file.
        .meta({ floor: "viewer", guest: true })
        .input(WorkspaceDerivedQuerySchema)
        .output(WorkspaceDerivedSchema),
    // Where the background pass stands, with no file in hand: what the setting's own row reports about itself.
    derivedStatus: procedure
        .route({
            method: "GET",
            path: "/workspace/derived-status",
            summary: "How the background rendering is doing",
            description:
                "Whether documents, pictures, recordings and archives are being rendered to text in the background, how many are waiting, which are being read right now, and how many shadows the last whole-tree pass counted. Ask this to tell a file nothing can read from a file whose turn has not come.",
        })
        .meta({ guest: true })
        .output(SidecarStatusSchema),
    // Mints the ticket GET /workspace/media (a plain Hono byte-range route, no oRPC shape) requires to stream.
    mediaTicket: procedure
        .route({
            method: "POST",
            path: "/workspace/media-ticket",
            summary: "Get a pass for streaming a media file",
            description:
                "Mints the short-lived ticket a video or audio element hands to the streaming route, which serves byte ranges and so cannot carry an ordinary header. Minting it here means a caller can tell whether this sandbox streams media at all, rather than discovering it mid-playback.",
        })
        // Opening a media file is a read, and the ticket is strictly narrower than the bearer.
        .meta({ floor: "viewer", guest: true })
        .input(WorkspaceMediaTicketQuerySchema)
        .output(WorkspaceMediaTicketSchema),
    // Matches a prose-written path, often just a suffix, against the tree rather than trusting it as root-relative.
    resolve: procedure
        .route({
            method: "GET",
            path: "/workspace/resolve",
            summary: "Turn a written path into a real file",
            description:
                "Matches a path somebody wrote in prose against the real tree and says which file it means. A path mentioned in a message is often only the tail of the real one, so this is the lookup behind every clickable file reference rather than a plain existence check.",
        })
        .meta({ guest: true })
        .input(WorkspaceResolveQuerySchema)
        .output(WorkspaceResolveSchema),
    // `mode` narrows the search to one kind; default fuses text, structure, meaning and history in one pass.
    search: procedure
        .route({
            method: "GET",
            path: "/workspace/search",
            summary: "Search the code",
            description:
                "Ranked results across the whole workspace, grouped, each carrying why it matched and how fresh it is. Left alone it blends plain text, structure, meaning and history in one pass; narrow it to a single kind of search when you already know which you want. Long result sets resume from the cursor it hands back.",
        })
        .meta({ guest: true, control: "editor" })
        .input(WorkspaceSearchQuerySchema)
        .output(WorkspaceSearchResultSchema),
    // Per-file churn × complexity, index totals, top modules; scoped to a repo, not the whole /work drop.
    health: procedure
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
    classify: procedure
        .route({
            method: "GET",
            path: "/workspace/classify",
            summary: "Sort a messy drop into buckets",
            description:
                "Proposes which of the loose things in the workspace are code, documents, media or archives. A read-only suggestion by fixed rules, with no model involved: nothing moves until a caller applies the moves it likes through the move call.",
        })
        .output(WorkspaceClassificationSchema),
    // Delete sends `{path}` in the body, not the query: oRPC's OpenAPI codec reads non-GET input from the body.
    mkdir: procedure
        .route({
            method: "POST",
            path: "/workspace/dir",
            summary: "Create a folder",
            description: "Makes a folder, and any missing folders above it.",
        })
        // Editing the shared tree is the writer grant; each file route resolves its path inside the caller's fence.
        .meta({ floor: "writer" })
        .input(WorkspaceDirSchema)
        .output(OkSchema),
    delete: procedure
        .route({
            method: "DELETE",
            path: "/workspace/entry",
            summary: "Delete a file or folder",
            description:
                "Removes one entry and everything under it. The path travels in the body rather than the address, the same as every other write in this group.",
        })
        .meta({ floor: "writer" })
        .input(WorkspaceFileQuerySchema)
        .output(OkSchema),
    move: procedure
        .route({
            method: "POST",
            path: "/workspace/move",
            summary: "Move or rename something",
            description: "Moves one entry to a new path, which is also how you rename it.",
        })
        .meta({ floor: "writer" })
        .input(WorkspaceMoveSchema)
        .output(OkSchema),
    copy: procedure
        .route({
            method: "POST",
            path: "/workspace/copy",
            summary: "Copy a file or folder",
            description: "Duplicates one entry at a new path, recursively for a folder.",
        })
        .meta({ floor: "writer" })
        .input(WorkspaceMoveSchema)
        .output(OkSchema),
    extract: procedure
        .route({
            method: "POST",
            path: "/workspace/extract",
            summary: "Unpack an archive",
            description:
                "Unpacks a zip or tar already in the workspace into a new folder beside it, named after the archive. An archive that is one folder of its own name lands as that folder rather than as it twice, and a .gz, .bz2, .xz or .zst holding a single file lands as that file. Nothing is ever written over: the answer says where it landed. Formats with no tool here, such as .7z and .rar, are refused.",
        })
        .meta({ floor: "writer" })
        .input(WorkspaceFileQuerySchema)
        .output(WorkspaceExtractSchema),
    // An imported project lacks node_modules/.venv; until this says ready, its type checks and tests can mislead.
    setup: procedure
        .route({
            method: "GET",
            path: "/workspace/setup",
            summary: "Which projects have their dependencies installed",
            description:
                "Per project, whether its dependencies are actually present. A project that arrives by import comes without them, so files landing is not the same as the project working: until this says a project is ready, its type checks and tests can only mislead you.",
        })
        .output(WorkspaceSetupSchema),
    install: procedure
        .route({
            method: "POST",
            path: "/workspace/setup/install",
            summary: "Install a project's dependencies",
            description:
                "Starts the install for one or more projects in a terminal you can attach to, and answers immediately. The run survives a page reload and its output stays in the terminal history.",
        })
        .input(WorkspaceInstallSchema)
        .output(WorkspaceInstallResultSchema),
    // Nothing is checked inside a turn; this is the check that runs instead, over the main tree after work lands.
    mainline: procedure
        .route({
            method: "GET",
            path: "/workspace/mainline",
            summary: "The checks that run after work lands",
            description:
                "What the main tree's own check is measuring right now, which landed work waits for the next run, what the last run in each project said, and what became of a red one: sent back to the conversation that landed it, handed to a fresh conversation, or waiting on one still working. Nothing here ever holds a land, a commit or a push.",
        })
        .output(MainlineStatusSchema),
    repos: procedure
        .route({
            method: "GET",
            path: "/workspace/repos",
            summary: "Repos in the workspace",
            description: "Every git repo the daemon found in the workspace, with where each one sits and what it is called.",
        })
        .meta({ guest: true })
        .output(ReposListSchema),
    addRepo: procedure
        .route({
            method: "POST",
            path: "/workspace/repos",
            summary: "Clone a repo in",
            description: "Clones a repository into the workspace beside the others, using whatever forge credentials the sandbox already holds.",
        })
        .input(CloneRepoSchema)
        .output(CloneResultSchema),
    createRepo: procedure
        .route({
            method: "POST",
            path: "/workspace/repos/new",
            summary: "Start a new repo",
            description:
                "Makes an empty repository in the workspace: a folder named after it, initialised, with a README that names it and one commit, so an agent can start on it at once. Nothing is cloned and nothing leaves the machine.",
        })
        .input(CreateRepoSchema)
        .output(CloneResultSchema),
    // Mutates the tree (fetch + fast-forward), which is why this is POST rather than GET.
    sync: procedure
        .route({
            method: "POST",
            path: "/workspace/sync",
            summary: "Pull every repo up to date",
            description:
                "Fetches every repo that has a remote and fast-forwards the ones that can move safely, reporting what happened to each. This runs by itself at the start of a turn; call it directly to refresh on demand, or to re-sync a repo that had drifted.",
        })
        .output(WorkspaceSyncSchema),
    // The source repo's templates.json app types; drives the apps extension's Add-app picker.
    templates: procedure
        .route({
            method: "GET",
            path: "/workspace/templates",
            summary: "App templates you can add",
            description: "The kinds of app the configured source repo knows how to scaffold, which is what an add-app picker lists.",
        })
        .output(TemplatesListSchema),
    // Runs as a one-shot tmux job named `panel-<repo>--add_apps`, executing `intentic scaffold add-app`.
    addApps: procedure
        .route({
            method: "POST",
            path: "/workspace/repos/{repo}/apps",
            summary: "Scaffold new apps into a repo",
            description:
                "Starts scaffolding one or more apps inside an existing multi-package repo and answers straight away. Watch the terminal it opens for progress and for anything that goes wrong.",
        })
        .input(AddAppsSchema)
        .output(OkSchema),
    appsList: procedure
        .route({
            method: "GET",
            path: "/workspace/repos/{repo}/apps",
            summary: "Apps inside a repo",
            description: "The apps in one multi-package repo, each with its preview address and whether its dev server is up.",
        })
        .input(RepoAppsParamSchema)
        .output(AppsListSchema),
    // The monorepo's package dependency graph, from pnpm-workspace.yaml globs and each package.json's deps.
    packageGraph: procedure
        .route({
            method: "GET",
            path: "/workspace/repos/{repo}/graph",
            summary: "How a repo's packages depend on each other",
            description: "Every package in one multi-package repo and which of its siblings each one uses, which is what a dependency view draws.",
        })
        .input(RepoAppsParamSchema)
        .output(WorkspaceGraphSchema),
    // Every repo's package dirs in one call, since a review spans repos and per-repo would fan out per open.
    modules: procedure
        .route({
            method: "GET",
            path: "/workspace/modules",
            summary: "Every package across every repo",
            description:
                "The named packages in the whole workspace, which is what a review list groups changed files under when a reader wants packages rather than paths. Whole-workspace in one answer, because a review spans repos and asking per repo would be a fan-out on every open.",
        })
        .output(WorkspaceModulesSchema),
    startApp: procedure
        .route({
            method: "POST",
            path: "/workspace/repos/{repo}/apps/{app}/start",
            summary: "Start an app's dev server",
            description: "Brings up one app's preview server in an attachable terminal, so its address starts answering.",
        })
        .input(AppParamSchema)
        .output(OkSchema),
    stopApp: procedure
        .route({
            method: "POST",
            path: "/workspace/repos/{repo}/apps/{app}/stop",
            summary: "Stop an app's dev server",
            description: "Shuts one app's preview server down and frees its port.",
        })
        .input(AppParamSchema)
        .output(OkSchema),
    // Runs tests for the named dirs in a one-shot tmux panel; mirrors addApps: an ack, terminal as result surface.
    runTests: procedure
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
