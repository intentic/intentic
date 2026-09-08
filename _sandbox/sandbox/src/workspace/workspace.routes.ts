import { existsSync } from "node:fs";
import { join } from "node:path";
import { HEALTH_LIMIT, includeGlobs, MAX_REF_CANDIDATES, previewUrl, workspaceContract, zoneFromUrl } from "@intentic/sandbox-contract";
import { sandboxIdFromToken } from "@intentic/sandbox-contract/tunnel-ids";
import { implement, ORPCError } from "@orpc/server";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../app-env.js";
import { repoGitDir } from "../history/history.js";
import { cachedScheme } from "../ports/port-probe.js";
import { shellQuote } from "@intentic/sandbox-run/quote";
import { appPanelKey, buildAppSpec, discoverApps } from "./layout/app-previews.js";
import { classifyWorkspace } from "./deps/classify.js";
import { readModules } from "./deps/modules.js";
import { readPackageGraph } from "./deps/package-graph.js";
import { discoverRepos, isValidRepoId, isValidRepoName } from "./layout/repo-discovery.js";
import { resolveReference } from "./files/resolve-reference.js";
import { missingCount } from "./layout/workspace-setup.js";
import { syncWorkspaceRepos } from "./layout/sync-repos.js";
import { listTemplates, loadManifest, readTemplatesConfig } from "../scaffold/templates-config.js";
import { isControlPlanePath, resolveWithin } from "./files/workspace-files-paths.js";
import { containedIn, scopedTarget, workspaceRootFor } from "./layout/workspace-scope.js";

// Row cap for one /workspace/search page, sized to the virtualized list's visible rows.
const GUI_SEARCH_HITS = 1_000;
const GUI_SEARCH_FILES = 300;
// Token budget for the paths named in a zero-hit hint; nothing else reads it.
const GUI_SEARCH_BUDGET = 2_000;

// Routes for the full /work view and extra-repo cloning. The binary /workspace/raw preview is a plain Hono route in
// app.ts; a streamed body doesn't fit oRPC.
export const createWorkspaceRoutes = (services: Services) => {
    const i = implement(workspaceContract).$context<OrpcContext>();
    // Resolves a write target inside the shared tree; no write route can ever target a conversation's checkout.
    const contained = async (relPath: string): Promise<string> => containedIn(services.workspace.root, relPath);
    // Read scope shared with the byte routes in app.ts; two resolvers here would disagree on a file's contents.
    const scope = services.workspaceScope;
    // Zone and sandbox id used to build per-app preview URLs (preview-<panel>-<id>.<zone>).
    const zone = services.config.zone !== "" ? services.config.zone : zoneFromUrl(services.config.sandbox.publicUrl);
    const sandboxId = sandboxIdFromToken(services.config.connectToken);
    // Resolves and validates the {repo} path param for the apps extension's routes; the repo must already exist.
    const monorepoOf = (repo: string): string => {
        if (!isValidRepoName(repo)) {
            throw new ORPCError("BAD_REQUEST", { message: "missing or invalid repo" });
        }
        if (!existsSync(join(services.workspace.root, repo))) {
            throw new ORPCError("NOT_FOUND", { message: `no monorepo named "${repo}"` });
        }
        return repo;
    };
    return {
        // input.agent picks whose copy to walk, with no fallback; a file the walk misses can still be opened via
        // `file`.
        tree: i.tree.handler(async ({ input }) => services.workspaceTree(await workspaceRootFor(scope, input.agent))),
        // Lazy-loads children of a dir the tree skipped (node_modules, .git, ...), or a bounded subtree for a consumer
        // avoiding per-directory requests.
        children: i.children.handler(async ({ input }) =>
            services.workspaceChildren(
                await workspaceRootFor(scope, input.agent),
                input.path,
                input.depth === undefined ? undefined : { depth: input.depth },
            ),
        ),
        // Returns a window of the file with its total size, not the whole file. An absent file is a 200 with
        // present:false, not a 404; scopedTarget still throws on an escape or control-plane path.
        file: i.file.handler(async ({ input }) => {
            const { target, shared } = await scopedTarget(scope, input.agent, input.path);
            const window = await services.files.readWindow(target, input.offset, input.limit);
            return window === undefined
                ? { present: false as const, path: input.path }
                : { present: true as const, path: input.path, shared, ...window };
        }),
        // Mints the ticket presented to GET /workspace/media, guarded like a read so it can only name a file already
        // readable. Binds the resolved file, not its shared-tree namesake.
        mediaTicket: i.mediaTicket.handler(async ({ input }) => {
            const { target } = await scopedTarget(scope, input.agent, input.path);
            if ((await services.files.size(target)) === undefined) {
                throw new ORPCError("NOT_FOUND", { message: "not found" });
            }
            return services.mediaTickets.mint(target);
        }),
        // Resolves which workspace file a named reference means (chat prose, terminal output, a tool chip); wires
        // resolveReference to the workspace's guards and to iq's in-memory glob.
        resolve: i.resolve.handler(async ({ input, signal }) => {
            // Checks the conversation's checkout for existence first; a file just written there exists nowhere else.
            const roots = [...new Set([await workspaceRootFor(scope, input.agent), services.workspace.root])];
            return resolveReference(
                input.path,
                services.workspace.root,
                (relPath) =>
                    roots.some((dir) => {
                        const abs = resolveWithin(dir, relPath);
                        return abs !== undefined && !isControlPlanePath(dir, abs) && existsSync(abs);
                    }),
                async (glob) => {
                    const outcome = await services.iq.run(
                        {
                            verb: "files",
                            query: glob,
                            scope: {},
                            render: { budget: 400, limit: MAX_REF_CANDIDATES },
                            options: { globExact: true },
                            echo: `files "${glob}" --exact`,
                        },
                        signal,
                    );
                    return outcome.result.groups.map((group) => group.path);
                },
            );
        }),
        // Runs the resident iq engine in-process, minus the per-query spawn and sweep. A GUI caller asks for a `list`
        // page (rows), skipping the capsule, symbol lookup and continuation spool.
        search: i.search.handler(async ({ input, signal }) => {
            const verb = input.mode ?? "q";
            const ignored = input.includeIgnored === true;
            const options = {
                ...(input.literal === true ? { literal: true } : {}),
                ...(input.word === true ? { word: true } : {}),
                ...(input.caseSensitive === true ? { caseSensitive: true } : {}),
            };
            // Parses the include field the same way the editor does, then hands the globs to the engine's scope.
            const { globs, notGlobs } = includeGlobs(input.include);
            const outcome = await services.iq.run(
                {
                    verb,
                    query: input.query,
                    scope: {
                        ...(ignored ? { ignored: true } : {}),
                        ...(globs.length > 0 ? { globs } : {}),
                        ...(notGlobs.length > 0 ? { notGlobs } : {}),
                    },
                    render: {
                        budget: GUI_SEARCH_BUDGET,
                        list: { hits: GUI_SEARCH_HITS, files: Math.min(input.limit ?? GUI_SEARCH_FILES, GUI_SEARCH_FILES) },
                        ...(input.after !== undefined ? { after: input.after } : {}),
                    },
                    options,
                    // Echo mirrors the CLI form and seeds the cursor id; must stay stable for the same
                    // query+mode+scope+globs.
                    echo: `${verb === "q" ? "" : `${verb} `}"${input.query}"${ignored ? " --ignored" : ""}${input.literal === true ? " --literal" : ""}${input.word === true ? " --word" : ""}${input.caseSensitive === true ? " --case" : ""}${globs.map((glob) => ` --glob '${glob}'`).join("")}${notGlobs.map((glob) => ` --not-glob '${glob}'`).join("")}`,
                },
                signal,
            );
            return outcome.result;
        }),
        // One repo's churn x complexity, index stats and import graph, keyed like the management panel and git-history
        // graph. An undiscovered repo is NOT_FOUND, not zeros reading as healthy.
        health: i.health.handler(async ({ input }) => {
            if (input.repo !== "root" && !isValidRepoId(input.repo)) {
                throw new ORPCError("BAD_REQUEST", { message: "invalid repo" });
            }
            if (input.repo !== "root" && !(await discoverRepos(services.workspace.root)).includes(input.repo)) {
                throw new ORPCError("NOT_FOUND", { message: `no repo named "${input.repo}"` });
            }
            const report = await services.iq.health({
                scope: { repo: input.repo === "root" ? "" : input.repo },
                ...(input.since !== undefined ? { since: input.since } : {}),
                limit: input.limit ?? HEALTH_LIMIT,
            });
            return { repo: input.repo, ...report };
        }),
        // Read-only classification of the workspace into coarse buckets, over the same filtered tree the file view
        // uses. Mutates nothing; the browser applies moves via `move`.
        classify: i.classify.handler(async () => classifyWorkspace(services.workspace.root, await services.workspaceTree(services.workspace.root))),
        // Direct file management over /work (byte writes go through POST /workspace/upload). Move/copy resolve both
        // endpoints through `contained`; every mutation pings history.
        mkdir: i.mkdir.handler(async ({ input }) => {
            await services.files.mkdir(await contained(input.path));
            services.history.notifyUserWrite();
            return { ok: true } as const;
        }),
        delete: i.delete.handler(async ({ input }) => {
            await services.files.remove(await contained(input.path));
            services.history.notifyUserWrite();
            return { ok: true } as const;
        }),
        move: i.move.handler(async ({ input }) => {
            await services.files.move(await contained(input.from), await contained(input.to));
            services.history.notifyUserWrite();
            return { ok: true } as const;
        }),
        copy: i.copy.handler(async ({ input }) => {
            await services.files.copy(await contained(input.from), await contained(input.to));
            services.history.notifyUserWrite();
            return { ok: true } as const;
        }),
        // Dependency readiness per project; flattens the recipe and drops its `marker`. A stale project reports how
        // many names fail to resolve, not which, since that list is longest when least useful.
        setup: i.setup.handler(async () => ({
            projects: (await services.dependencies.status()).map((project) =>
                Object.assign(
                    {
                        dir: project.dir,
                        ecosystem: project.recipe.ecosystem,
                        manager: project.recipe.manager,
                        command: project.recipe.command,
                        evidence: project.recipe.evidence,
                        state: project.state,
                    },
                    project.state === "stale" ? { missing: missingCount(project) } : {},
                ),
            ),
        })),
        // Queues the named projects on the coordinator an agent's install also uses, so two package managers never run
        // over one tree; an already-ready project is a no-op.
        install: i.install.handler(async ({ input }) => {
            const result = await services.dependencies.requestInstall(input.dirs, { kind: "request", title: "Workspace import" });
            return { queued: [...result.queued] };
        }),
        repos: i.repos.handler(async () => ({ repos: await discoverRepos(services.workspace.root) })),
        // Every repo's modules in one read: 'root' (workspace root) plus each discovered repo, the same set the Changes
        // review scans.
        modules: i.modules.handler(async () => {
            const repoIds = await discoverRepos(services.workspace.root);
            return {
                repos: [
                    { repo: "root", modules: readModules(services.workspace.root) },
                    ...repoIds.map((repo) => ({ repo, modules: readModules(join(services.workspace.root, repo)) })),
                ],
            };
        }),
        addRepo: i.addRepo.handler(async ({ input }) => {
            if (!isValidRepoName(input.name)) {
                throw new ORPCError("BAD_REQUEST", { message: "invalid or reserved repo name" });
            }
            if (existsSync(join(services.workspace.root, input.name))) {
                throw new ORPCError("CONFLICT", { message: `"${input.name}" already exists in the workspace` });
            }
            await services.git.clone(services.workspace.root, input.name, input.cloneUrl, {
                ...(input.branch !== undefined ? { branch: input.branch } : {}),
                separateGitDir: repoGitDir(services.config.historyRoot, input.name),
            });
            services.history.notifyUserWrite();
            return { name: input.name, path: input.name };
        }),
        // Force-fetches and fast-forwards every repo with a remote, returning per-repo outcomes; pings history since a
        // fast-forward changes tracked files.
        sync: i.sync.handler(async () => {
            const repos = (await syncWorkspaceRepos(services, 0)).map(({ repo, outcome }) => Object.assign({ repo }, outcome));
            services.history.notifyUserWrite();
            return { repos };
        }),
        // Addable app types from the configured source repo, for the Add-app picker.
        templates: i.templates.handler(async () => ({ templates: await listTemplates(services) })),
        // Adds named app instances to a monorepo as a one-shot job (key `<repo>--add_apps`, underscore so it can't
        // collide with an app panel key `<repo>--<app>`); a running job makes a second call a no-op.
        addApps: i.addApps.handler(async ({ input }) => {
            const repo = monorepoOf(input.repo);
            const repoDir = join(services.workspace.root, repo);
            const { source, ref } = await readTemplatesConfig(services);
            const apps = input.apps.map((app) => (app.name === app.template ? app.template : `${app.template}:${app.name}`)).join(",");
            const command = `intentic scaffold add-app --dir ${shellQuote(repoDir)} --apps ${shellQuote(apps)} --source ${shellQuote(source)} --ref ${shellQuote(ref)}`;
            await services.processes.start(`${repo}--add_apps`, { command, cwd: repoDir, oneShot: true });
            return { ok: true } as const;
        }),
        // App instances in this monorepo with preview URL and live status, for the apps extension's list; scans
        // `_apps/` for scaffolded instances and dev-server packages.
        appsList: i.appsList.handler(async ({ input }) => {
            const repo = monorepoOf(input.repo);
            const repoDir = join(services.workspace.root, repo);
            const manifest = await loadManifest(services);
            // Apps install at their monorepo's root, so one read of node_modules answers for every row.
            const installed = existsSync(join(repoDir, "node_modules"));
            const apps = await Promise.all(
                discoverApps(repoDir, manifest).map(async ({ app, kind }) => {
                    const port = services.processes.portOf(appPanelKey(repo, app));
                    // Probe settles which scheme answers the assigned port; an unprobed https dev server would read as
                    // down.
                    const healthy = port !== undefined && (await cachedScheme(port)) !== undefined;
                    const url = previewUrl(appPanelKey(repo, app), zone, sandboxId);
                    // Launch progress reported until the app is healthy, then omitted.
                    const launch = healthy ? undefined : services.processes.launchOf(appPanelKey(repo, app));
                    // `kind`, `previewUrl` and `launch` are optional on the wire; each is omitted when it doesn't
                    // apply.
                    const summary = { app, running: port !== undefined, healthy, installed };
                    return Object.assign(
                        summary,
                        kind !== undefined ? { kind } : {},
                        url !== undefined ? { previewUrl: url } : {},
                        launch !== undefined ? { launch } : {},
                    );
                }),
            );
            return { apps };
        }),
        // Monorepo's workspace package dependency graph, for the apps extension's Dependencies view.
        packageGraph: i.packageGraph.handler(({ input }) => readPackageGraph(join(services.workspace.root, monorepoOf(input.repo)))),
        // Starts one app instance's dev server: its own process, port and preview-<repo>--<app>-<id>.<zone> host.
        startApp: i.startApp.handler(async ({ input }) => {
            const repo = monorepoOf(input.repo);
            const repoDir = join(services.workspace.root, repo);
            const manifest = await loadManifest(services);
            const found = discoverApps(repoDir, manifest).find(({ app }) => app === input.app);
            if (found === undefined) {
                throw new ORPCError("NOT_FOUND", { message: `no app "${input.app}" in ${repo}` });
            }
            await services.processes.start(
                appPanelKey(repo, input.app),
                buildAppSpec({ repo, repoDir, pkg: found.pkg, app: input.app, preview: found.preview, zone, sandboxId }),
            );
            return { ok: true } as const;
        }),
        stopApp: i.stopApp.handler(async ({ input }) => {
            const repo = monorepoOf(input.repo);
            services.processes.stop(appPanelKey(repo, input.app));
            return { ok: true } as const;
        }),
        // Runs vitest for the given repo-relative dirs as a one-shot tmux session (panel-<repo>--<session>); `dirs` are
        // repo-contained ("" = repo root), the session exists before the process starts.
        runTests: i.runTests.handler(async ({ input }) => {
            const repo = monorepoOf(input.repo);
            if (!/^[a-z0-9][a-z0-9_-]*$/.test(input.session)) {
                throw new ORPCError("BAD_REQUEST", { message: "invalid session" });
            }
            const repoDir = join(services.workspace.root, repo);
            const command = input.dirs
                .map((dir) => {
                    const abs = dir === "" ? repoDir : resolveWithin(repoDir, dir);
                    if (abs === undefined) {
                        throw new ORPCError("BAD_REQUEST", { message: `invalid test dir "${dir}"` });
                    }
                    return `(cd ${shellQuote(abs)} && pnpm vitest run)`;
                })
                .join("; ");
            await services.processes.start(`${repo}--${input.session}`, { command, cwd: repoDir, oneShot: true });
            return { ok: true } as const;
        }),
    };
};
