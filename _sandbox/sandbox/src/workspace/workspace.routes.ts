import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { HEALTH_LIMIT, includeGlobs, MAX_REF_CANDIDATES, previewUrl, workspaceContract, zoneFromUrl } from "@intentic/sandbox-contract";
import { sandboxIdFromToken } from "@intentic/sandbox-contract/tunnel-ids";
import { implement, ORPCError } from "@orpc/server";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../app-env.js";
import { AGENT_GIT_AUTHOR } from "../git-identity.js";
import { repoGitDir, syncRootExcludes } from "../history/history.js";
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
import { UnknownArchiveError } from "./files/workspace-extract.js";
import { childrenForRead, containedForRead, containedIn, insideArchive, scopedTarget, workspaceRootFor } from "./layout/workspace-scope.js";
import {
    fencedChildren,
    fencedClassification,
    fencedRepos,
    fencedTo,
    fencedTree,
    fenceOpens,
    refuseFenced,
    refuseUnlistable,
    searchPaths,
} from "./layout/workspace-fence.js";
import { refuseUnlessVisible } from "../auth/fleet-scope.js";
import { callerFence } from "../areas/area-scope.js";
import type { Fence } from "@intentic/sandbox-contract";

// Row cap for one /workspace/search page, sized to the virtualized list's visible rows.
const GUI_SEARCH_HITS = 1_000;
const GUI_SEARCH_FILES = 300;
// Token budget for the paths named in a zero-hit hint; nothing else reads it.
const GUI_SEARCH_BUDGET = 2_000;

// The literal `iq` command a GUI search stands for. It mirrors the CLI's own flag order (echoOf in iq/lib/flags) and
// seeds the cursor id, so it must stay byte-stable for the same query + mode + scope: two searches that echo alike page
// as one.
const searchEcho = (
    verb: string,
    query: string,
    scope: { readonly dir: string; readonly ignored: boolean; readonly globs: readonly string[]; readonly notGlobs: readonly string[] },
    options: { readonly literal?: boolean; readonly word?: boolean; readonly caseSensitive?: boolean },
): string =>
    [
        `${verb === "q" ? "" : `${verb} `}"${query}"`,
        ...(scope.dir === "" ? [] : [`--in '${scope.dir}'`]),
        ...(scope.ignored ? ["--ignored"] : []),
        ...(options.literal === true ? ["--literal"] : []),
        ...(options.word === true ? ["--word"] : []),
        ...(options.caseSensitive === true ? ["--case"] : []),
        ...scope.globs.map((glob) => `--glob '${glob}'`),
        ...scope.notGlobs.map((glob) => `--not-glob '${glob}'`),
    ].join(" ");

// Routes for the full /work view and extra-repo cloning. The binary /workspace/raw preview is a plain Hono route in
// app.ts; a streamed body doesn't fit oRPC.
export const createWorkspaceRoutes = (services: Services) => {
    const i = implement(workspaceContract).$context<OrpcContext>();
    // Resolves a write target inside the shared tree; no write route can ever target a conversation's checkout, and an
    // archive's contents are read-only: nothing here repacks a zip.
    const contained = async (context: OrpcContext, relPath: string): Promise<string> => {
        if (insideArchive(services.workspace.root, relPath)) {
            throw new ORPCError("BAD_REQUEST", { message: "an archive's contents are read-only; extract it to change them" });
        }
        // The writer tier's whole boundary: the floor (auth/role-floor.ts) admits the route, this decides the path.
        // Maintainer and above are unfenced and pass through.
        refuseFenced(await fenceFor(context), relPath);
        return containedIn(services.workspace.root, relPath);
    };
    // The same guard for a shadow's source, answering the canonical relative path a sidecar is filed under: `./a//b.pdf`
    // and `a/b.pdf` name one file and must not name two shadows. No archive refusal: a member simply has no shadow.
    const derivedRel = async (relPath: string): Promise<string> =>
        relative(services.workspace.root, await containedIn(services.workspace.root, relPath));
    // Read scope shared with the byte routes in app.ts; two resolvers here would disagree on a file's contents.
    const scope = services.workspaceScope;
    // The caller's own fence, read per request so an area edit lands on the very next one rather than at next sign-in.
    const fenceFor = async (context: OrpcContext): Promise<Fence> => callerFence(await services.areas.list(), context.identity);
    // A conversation's checkout is its own. A caller who may not see the conversation may not read out of it either,
    // or every fence would have a second door marked with somebody else's id.
    const refuseUnseenAgent = (context: OrpcContext, agent: string | undefined): void => {
        if (agent === undefined) {
            return;
        }
        const entry = services.agents.entry(agent);
        // An unknown id stays NOT_FOUND from the scope resolver; saying FORBIDDEN here would answer whether it exists.
        if (entry !== undefined) {
            refuseUnlessVisible(context.identity, entry);
        }
    };
    // Every scoped read asks both questions before a path reaches the resolver: whose copy, and whether this caller
    // may look there at all.
    const scopedRead = async (context: OrpcContext, agent: string | undefined, relPath: string) => {
        refuseUnseenAgent(context, agent);
        refuseFenced(await fenceFor(context), relPath);
        return scopedTarget(scope, agent, relPath);
    };
    // Zone and sandbox id used to build per-app preview URLs (preview-<panel>-<id>.<zone>).
    const zone = services.config.zone !== "" ? services.config.zone : zoneFromUrl(services.config.sandbox.publicUrl);
    const sandboxId = sandboxIdFromToken(services.config.connectToken);
    // Resolves and validates the {repo} path param for the apps extension's routes; the repo must already exist.
    const monorepoOf = async (context: OrpcContext, repo: string): Promise<string> => {
        if (!isValidRepoName(repo)) {
            throw new ORPCError("BAD_REQUEST", { message: "missing or invalid repo" });
        }
        if (!existsSync(join(services.workspace.root, repo))) {
            throw new ORPCError("NOT_FOUND", { message: `no monorepo named "${repo}"` });
        }
        refuseFenced(await fenceFor(context), repo);
        return repo;
    };
    return {
        // input.agent picks whose copy to walk, with no fallback; a file the walk misses can still be opened via
        // `file`.
        // A fenced caller is shown their own folders and the ancestors leading to them, rather than the whole tree
        // with most of it refusing on click.
        tree: i.tree.handler(async ({ input, context }) => {
            refuseUnseenAgent(context, input.agent);
            const tree = await services.workspaceTree(await workspaceRootFor(scope, input.agent));
            return fencedTree(await fenceFor(context), tree);
        }),
        // Lazy-loads children of a dir the tree skipped (node_modules, .git, ...), or a bounded subtree for a consumer
        // avoiding per-directory requests. A zip or tar lists like the folder it holds, unpacked on first ask.
        children: i.children.handler(async ({ input, context }) => {
            refuseUnseenAgent(context, input.agent);
            // Reachable, not allowed: opening `finance` to reach the one report inside it is the point of a fence on
            // `finance/reports`, and the listing below is pruned to what leads somewhere.
            const fence = await fenceFor(context);
            refuseUnlistable(fence, input.path);
            const root = await workspaceRootFor(scope, input.agent);
            const options = input.depth === undefined ? undefined : { depth: input.depth };
            const listed = (await childrenForRead(root, input.path, options)) ?? (await services.workspaceChildren(root, input.path, options));
            return fencedChildren(fence, listed);
        }),
        // Returns a window of the file with its total size, not the whole file. An absent file is a 200 with
        // present:false, not a 404; scopedTarget still throws on an escape or control-plane path.
        file: i.file.handler(async ({ input, context }) => {
            const { target, shared } = await scopedRead(context, input.agent, input.path);
            const window = await services.files.readWindow(target, input.offset, input.limit);
            return window === undefined
                ? { present: false as const, path: input.path }
                : { present: true as const, path: input.path, shared, ...window };
        }),
        // A file's markdown shadow as it stands. Shared tree only, since fileq refuses to shadow a checkout, and a
        // shared-tree shadow served under a conversation's scope would describe a different file than the one open.
        derived: i.derived.handler(async ({ input, context }) => {
            refuseFenced(await fenceFor(context), input.path);
            return services.derived.read(services.workspace.root, await derivedRel(input.path));
        }),
        // The same convergence the background pass runs, for the one file someone is looking at.
        derive: i.derive.handler(async ({ input, context }) => {
            refuseFenced(await fenceFor(context), input.path);
            return services.derived.derive(services.workspace.root, await derivedRel(input.path));
        }),
        // In-memory state of a running service, not a disk read: no path to contain, nothing to scope.
        derivedStatus: i.derivedStatus.handler(() => services.derived.status()),
        // Mints the ticket presented to GET /workspace/media, guarded like a read so it can only name a file already
        // readable. Binds the resolved file, not its shared-tree namesake.
        mediaTicket: i.mediaTicket.handler(async ({ input, context }) => {
            const { target } = await scopedRead(context, input.agent, input.path);
            if ((await services.files.size(target)) === undefined) {
                throw new ORPCError("NOT_FOUND", { message: "not found" });
            }
            return services.mediaTickets.mint(target);
        }),
        // Resolves which workspace file a named reference means (chat prose, terminal output, a tool chip); wires
        // resolveReference to the workspace's guards and to iq's in-memory glob.
        resolve: i.resolve.handler(async ({ input, signal, context }) => {
            refuseUnseenAgent(context, input.agent);
            // The fence applies to the ANSWER, not the question: the input is a fragment somebody wrote, and matching
            // it against the tree is exactly how a fenced caller would learn a path outside their folders exists.
            const fence = await fenceFor(context);
            // Checks the conversation's checkout for existence first; a file just written there exists nowhere else.
            const roots = [...new Set([await workspaceRootFor(scope, input.agent), services.workspace.root])];
            const resolved = await resolveReference(
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
            // Unresolvable, not refused: to a fenced reader a file outside their folders simply is not in the
            // workspace, and a refusal here would confirm that it is.
            return resolved.path !== undefined && !fenceOpens(fence, resolved.path) ? {} : resolved;
        }),
        // Runs the resident iq engine in-process, minus the per-query spawn and sweep. A GUI caller asks for a `list`
        // page (rows), skipping the capsule, symbol lookup and continuation spool.
        search: i.search.handler(async ({ input, signal, context }) => {
            // The index covers the whole tree, so a fenced caller searching it would get snippets out of folders they
            // cannot open — the leak that makes a file fence decorative if it is left unsaid. The engine's own path
            // scope is what closes it, narrowed to the caller's folders before the query runs.
            const fence = await fenceFor(context);
            const verb = input.mode ?? "q";
            const ignored = input.includeIgnored === true;
            const options = {
                ...(input.literal === true ? { literal: true } : {}),
                ...(input.word === true ? { word: true } : {}),
                ...(input.caseSensitive === true ? { caseSensitive: true } : {}),
            };
            // Parses the include field the same way the editor does, then hands the globs to the engine's scope.
            const { globs, notGlobs } = includeGlobs(input.include);
            // One subtree, normalized here the way the engine's own prefix filter normalizes it, so the scope and the
            // echo below can't disagree about the same folder.
            const dir = (input.dir ?? "").replace(/^\.\//, "").replace(/\/+$/, "");
            // A named subtree meets the fence: outside it the search runs over nothing rather than over the folder,
            // and inside it the narrower of the two wins.
            const paths = searchPaths(fence, dir);
            const outcome = await services.iq.run(
                {
                    verb,
                    query: input.query,
                    scope: {
                        ...(ignored ? { ignored: true } : {}),
                        ...(paths !== undefined ? { paths } : {}),
                        ...(globs.length > 0 ? { globs } : {}),
                        ...(notGlobs.length > 0 ? { notGlobs } : {}),
                    },
                    render: {
                        budget: GUI_SEARCH_BUDGET,
                        list: { hits: GUI_SEARCH_HITS, files: Math.min(input.limit ?? GUI_SEARCH_FILES, GUI_SEARCH_FILES) },
                        ...(input.after !== undefined ? { after: input.after } : {}),
                    },
                    options,
                    echo: searchEcho(verb, input.query, { dir, ignored, globs, notGlobs }, options),
                },
                signal,
            );
            return outcome.result;
        }),
        // One repo's churn x complexity, index stats and import graph, keyed like the management panel and git-history
        // graph. An undiscovered repo is NOT_FOUND, not zeros reading as healthy.
        health: i.health.handler(async ({ input, context }) => {
            if (input.repo !== "root" && !isValidRepoId(input.repo)) {
                throw new ORPCError("BAD_REQUEST", { message: "invalid repo" });
            }
            // A repo's report is churn and complexity per file: the whole of it, for every path inside.
            refuseFenced(await fenceFor(context), input.repo === "root" ? "" : input.repo);
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
        classify: i.classify.handler(async ({ context }) =>
            fencedClassification(
                await fenceFor(context),
                await classifyWorkspace(services.workspace.root, await services.workspaceTree(services.workspace.root)),
            ),
        ),
        // Direct file management over /work (byte writes go through POST /workspace/upload). Move/copy resolve both
        // endpoints through `contained`; every mutation pings history.
        mkdir: i.mkdir.handler(async ({ input, context }) => {
            await services.files.mkdir(await contained(context, input.path));
            services.history.notifyUserWrite();
            return { ok: true } as const;
        }),
        delete: i.delete.handler(async ({ input, context }) => {
            await services.files.remove(await contained(context, input.path));
            services.history.notifyUserWrite();
            return { ok: true } as const;
        }),
        move: i.move.handler(async ({ input, context }) => {
            await services.files.move(await contained(context, input.from), await contained(context, input.to));
            services.history.notifyUserWrite();
            return { ok: true } as const;
        }),
        // The one write whose source may sit inside an archive: copying out is how a member reaches the workspace
        // without extracting the whole thing. The destination is a write target like any other.
        copy: i.copy.handler(async ({ input, context }) => {
            refuseFenced(await fenceFor(context), input.from);
            await services.files.copy(await containedForRead(services.workspace.root, input.from), await contained(context, input.to));
            services.history.notifyUserWrite();
            return { ok: true } as const;
        }),
        // Unpacks beside the archive, into a name nothing holds yet; the tool it spawns is picked by suffix, so a
        // format this sandbox has no tool for is a refusal rather than an empty folder.
        extract: i.extract.handler(async ({ input, context }) => {
            const archive = await contained(context, input.path);
            try {
                const landed = await services.files.extract(archive);
                services.history.notifyUserWrite();
                return { path: relative(services.workspace.root, landed) };
            } catch (failure) {
                if (failure instanceof UnknownArchiveError) {
                    throw new ORPCError("BAD_REQUEST", { message: failure.message });
                }
                throw failure;
            }
        }),
        // Dependency readiness per project; flattens the recipe and drops its `marker`. A stale project reports how
        // many names fail to resolve, not which, since that list is longest when least useful.
        setup: i.setup.handler(async ({ context }) => ({
            projects: (await services.dependencies.status()).filter(fencedTo(await fenceFor(context), (project) => project.dir)).map((project) =>
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
        install: i.install.handler(async ({ input, context }) => {
            const fence = await fenceFor(context);
            for (const dir of input.dirs) {
                refuseFenced(fence, dir);
            }
            const result = await services.dependencies.requestInstall(input.dirs, { kind: "request", title: "Workspace import" });
            return { queued: [...result.queued] };
        }),
        repos: i.repos.handler(async ({ context }) => ({
            repos: fencedRepos(await fenceFor(context), await discoverRepos(services.workspace.root)),
        })),
        // Every repo's modules in one read: 'root' (workspace root) plus each discovered repo, the same set the Changes
        // review scans.
        // Root's own modules ride only for an unfenced caller: its list spans the whole tree, which is the answer a
        // fence exists to withhold.
        modules: i.modules.handler(async ({ context }) => {
            const fence = await fenceFor(context);
            const repoIds = fencedRepos(fence, await discoverRepos(services.workspace.root));
            return {
                repos: [
                    ...(fence === undefined ? [{ repo: "root", modules: readModules(services.workspace.root) }] : []),
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
        // A repository from nothing: the folder, `git init` with its git dir on /history like a clone's, a README that
        // names it, and one commit so agents have a main line to branch from (a worktree is cut from HEAD). Root's
        // excludes converge at once, so the new folder is never swept into the workspace's own scope.
        createRepo: i.createRepo.handler(async ({ input }) => {
            if (!isValidRepoName(input.name)) {
                throw new ORPCError("BAD_REQUEST", { message: "invalid or reserved repo name" });
            }
            const dir = join(services.workspace.root, input.name);
            if (existsSync(dir)) {
                throw new ORPCError("CONFLICT", { message: `"${input.name}" already exists in the workspace` });
            }
            await mkdir(dir, { recursive: true });
            await services.git.init(dir, repoGitDir(services.config.historyRoot, input.name));
            await writeFile(join(dir, "README.md"), `# ${input.name}\n`);
            await services.git.commitAll(dir, `Start ${input.name}`, AGENT_GIT_AUTHOR);
            await syncRootExcludes(services.config.historyRoot, await discoverRepos(services.workspace.root));
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
        addApps: i.addApps.handler(async ({ input, context }) => {
            const repo = await monorepoOf(context, input.repo);
            const repoDir = join(services.workspace.root, repo);
            const { source, ref } = await readTemplatesConfig(services);
            const apps = input.apps.map((app) => (app.name === app.template ? app.template : `${app.template}:${app.name}`)).join(",");
            const command = `intentic scaffold add-app --dir ${shellQuote(repoDir)} --apps ${shellQuote(apps)} --source ${shellQuote(source)} --ref ${shellQuote(ref)}`;
            await services.processes.start(`${repo}--add_apps`, { command, cwd: repoDir, oneShot: true });
            return { ok: true } as const;
        }),
        // App instances in this monorepo with preview URL and live status, for the apps extension's list; scans
        // `_apps/` for scaffolded instances and dev-server packages.
        appsList: i.appsList.handler(async ({ input, context }) => {
            const repo = await monorepoOf(context, input.repo);
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
        packageGraph: i.packageGraph.handler(async ({ input, context }) =>
            readPackageGraph(join(services.workspace.root, await monorepoOf(context, input.repo))),
        ),
        // Starts one app instance's dev server: its own process, port and preview-<repo>--<app>-<id>.<zone> host.
        startApp: i.startApp.handler(async ({ input, context }) => {
            const repo = await monorepoOf(context, input.repo);
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
        stopApp: i.stopApp.handler(async ({ input, context }) => {
            const repo = await monorepoOf(context, input.repo);
            services.processes.stop(appPanelKey(repo, input.app));
            return { ok: true } as const;
        }),
        // Runs vitest for the given repo-relative dirs as a one-shot tmux session (panel-<repo>--<session>); `dirs` are
        // repo-contained ("" = repo root), the session exists before the process starts.
        runTests: i.runTests.handler(async ({ input, context }) => {
            const repo = await monorepoOf(context, input.repo);
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
