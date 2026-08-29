import { existsSync } from "node:fs";
import { join } from "node:path";
import { HEALTH_LIMIT, includeGlobs, MAX_REF_CANDIDATES, previewLabel, previewUrl, workspaceContract, zoneFromUrl } from "@intentic/sandbox-contract";
import { sandboxIdFromToken } from "@intentic/sandbox-contract/tunnel-ids";
import { implement, ORPCError } from "@orpc/server";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../context.js";
import { repoGitDir } from "../history/history.js";
import { cachedScheme } from "../ports/port-probe.js";
import { shellQuote } from "@intentic/sandbox-run/quote";
import { appPanelKey, buildAppSpec, discoverApps } from "./app-previews.js";
import { classifyWorkspace } from "./classify.js";
import { readModules } from "./modules.js";
import { readPackageGraph } from "./package-graph.js";
import { discoverRepos, isValidRepoId, isValidRepoName } from "./repo-discovery.js";
import { resolveReference } from "./resolve-reference.js";
import { missingCount } from "./workspace-setup.js";
import { syncWorkspaceRepos } from "./sync-repos.js";
import { listTemplates, loadManifest, readTemplatesConfig } from "../scaffold/templates-config.js";
import { isControlPlanePath, resolveWithin } from "./workspace-files.js";
import { containedIn, scopedTarget, workspaceRootFor } from "./workspace-scope.js";

/* What one page of /workspace/search costs, in the unit the caller actually pays: rows in a scrollable list.
 * The engine's other page shape sizes itself by what rendering the results as TEXT would spend, an agent's
 * context window, which here bought nothing (the browser reads the JSON and throws the text away) and made the
 * number of files that came back depend on how long the matched lines happened to be.
 *
 * Sized against the panel's virtualized list, which renders only what is on screen: a thousand rows is a fast
 * scroll, and past that the reader should be refining the query, not scrolling. Whichever ceiling binds first
 * wins, and `truncated` + `cursor` let the panel fetch the next page on demand. */
const GUI_SEARCH_HITS = 1_000;
const GUI_SEARCH_FILES = 300;
// The engine still wants a token budget for the paths it names in a zero-hit hint; nothing else reads it here.
const GUI_SEARCH_BUDGET = 2_000;

// The full /work view + extra-repo cloning. The binary /workspace/raw preview is a plain Hono route in app.ts
// (a streamed binary body doesn't fit oRPC). External MCP tools moved to the unified capabilities manifest.
export const createWorkspaceRoutes = (services: Services) => {
    const i = implement(workspaceContract).$context<OrpcContext>();
    // A write's target: always the shared tree, guarded (see workspace-scope for why no write route can name a
    // conversation's checkout in the first place).
    const contained = async (relPath: string): Promise<string> => containedIn(services.workspace.root, relPath);
    // Whose copy a READ means, composed once (see Services.workspaceScope), because the byte routes in app.ts
    // answer the same question and two resolvers that disagreed would make a file's contents depend on which
    // route the browser happened to use for it.
    const scope = services.workspaceScope;
    // The zone + sandbox id the preview proxy fronts panels under (preview-<panel>-<id>.<zone>), for building
    // per-app preview URLs.
    const zone = services.config.zone !== "" ? services.config.zone : zoneFromUrl(services.config.sandbox.publicUrl);
    const sandboxId = sandboxIdFromToken(services.config.connectToken);
    // The monorepo an apps call targets ({repo} path param from the owner-authed apps extension). Validated +
    // must exist. Shared by the add-apps and per-app preview routes.
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
        // `input.agent` names whose copy to walk, the tree is the one read with no fallback, because a tree is
        // a place rather than a lookup: half of it silently coming from the other checkout is not a view of
        // anything. A file the walk therefore misses still opens, through `file` below.
        tree: i.tree.handler(async ({ input }) => services.workspaceTree(await workspaceRootFor(scope, input.agent))),
        // Lazy-load the children of an ignored dir (node_modules, .git, …) the tree didn't descend into.
        children: i.children.handler(async ({ input }) => services.workspaceChildren(await workspaceRootFor(scope, input.agent), input.path)),
        /* A window, not the file (see readWorkspaceFileWindow). The response carries the file's total size, so
         * the viewer decides how to render from the daemon's number rather than from a tree entry it may not
         * have, the gate can't be skipped by opening a file the tree never listed.
         *
         * NOTHING THERE IS A 200 that says `present: false`, not a 404 (WorkspaceFileAbsentSchema explains why).
         * The guards above this line still refuse: an escape and the control plane throw from scopedTarget, so
         * "absent" here means the caller was allowed to look and there was nothing to read. */
        file: i.file.handler(async ({ input }) => {
            const { target, shared } = await scopedTarget(scope, input.agent, input.path);
            const window = await services.files.readWindow(target, input.offset, input.limit);
            return window === undefined
                ? { present: false as const, path: input.path }
                : { present: true as const, path: input.path, shared, ...window };
        }),
        /* Mint the ticket a media element will present to GET /workspace/media. Guarded exactly like a read,
         * escape, control plane, existence, so a ticket can only ever name a file this caller could already
         * have read, and a mint for a missing file fails HERE rather than as an opaque playback error later.
         * The ticket binds the RESOLVED file, so one minted against a conversation's checkout buys that file
         * and not its shared-tree namesake. */
        mediaTicket: i.mediaTicket.handler(async ({ input }) => {
            const { target } = await scopedTarget(scope, input.agent, input.path);
            if ((await services.files.size(target)) === undefined) {
                throw new ORPCError("NOT_FOUND", { message: "not found" });
            }
            return services.mediaTickets.mint(target);
        }),
        /* Which workspace file a NAMED reference means, the lookup behind every clickable path in the UI (chat
         * prose, terminal output, a tool card's chip). The search itself is resolveReference; this wires it to
         * the workspace (through the same escape + control-plane guards as every other read) and to the iq
         * engine's path glob, an in-memory regex pass over the sweep it already holds, which is why trying a
         * handful of tails costs nothing worth optimizing. */
        resolve: i.resolve.handler(async ({ input, signal }) => {
            // Existence is asked of the conversation's checkout FIRST, a file it created and has not landed
            // exists nowhere else, and answering "no such reference" for the very file the agent just wrote
            // about is the failure this scope exists to end. The glob below stays shared: the iq index is built
            // over /work, and a path it returns is root-relative, so it means the same file in either tree.
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
        /* Runs the resident iq engine in-process (services.iq), same engine the agent's Bash `iq` calls use,
         * minus the per-query process spawn, workspace sweep, and inline revalidation those pay. The request's
         * abort signal kills the engine's rg child when the browser supersedes a search mid-flight.
         *
         * A GUI caller, not a reading agent, so it asks for a `list` page: rows rather than tokens, and with
         * that the engine skips everything only the text capsule needed, the capsule itself, the packed bodies
         * that would fill a match list with lines nothing matched, the per-hit symbol lookup across every
         * matched file, and the continuation spool. See RenderOptions.list. */
        search: i.search.handler(async ({ input, signal }) => {
            const verb = input.mode ?? "q";
            const ignored = input.includeIgnored === true;
            const options = {
                ...(input.literal === true ? { literal: true } : {}),
                ...(input.word === true ? { word: true } : {}),
                ...(input.caseSensitive === true ? { caseSensitive: true } : {}),
            };
            // The files-to-include field, read as the editor reads it (includeGlobs) and handed to the engine as
            // the path globs it scopes by.
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
                    // Echo mirrors the CLI form, it seeds the pagination cursor id, so it must be stable for
                    // the same query+mode+scope across requests, and the glob filter is part of that scope.
                    echo: `${verb === "q" ? "" : `${verb} `}"${input.query}"${ignored ? " --ignored" : ""}${input.literal === true ? " --literal" : ""}${input.word === true ? " --word" : ""}${input.caseSensitive === true ? " --case" : ""}${globs.map((glob) => ` --glob '${glob}'`).join("")}${notGlobs.map((glob) => ` --not-glob '${glob}'`).join("")}`,
                },
                signal,
            );
            return outcome.result;
        }),
        /* One repository's codebase health, off the same resident engine: churn × complexity per file, what the
         * index holds, and the import graph's top modules. The repo-level companion to the management panel and
         * the git-history graph, so it takes the same {repo} ids those do, "root" is the /work repo, which the
         * iq scope calls "" (the sweep tags a file with its enclosing repo's root-relative dir, and the root's
         * is the empty path). Anything that is not a DISCOVERED repo is NOT_FOUND rather than an empty report:
         * every figure here is scoped by the sweep's repo tag, so a plain directory would report zeros, and
         * zeros read as a healthy repository rather than as a wrong question. */
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
        // Read-only, no-LLM classification of the dropped workspace into coarse buckets. Runs over the same
        // filtered tree the file view uses, so it never sees .git/secrets/node_modules. The browser turns the
        // proposal into accepted moves via the move route below, nothing here mutates /work.
        classify: i.classify.handler(async () => classifyWorkspace(services.workspace.root, await services.workspaceTree(services.workspace.root))),
        // Direct file management over /work (byte writes go through POST /workspace/upload). Both endpoints of a
        // move/copy run through `contained`, so neither source nor target can escape /work or reach the daemon's
        // control plane. Every mutation pings history so it lands as a user-authored snapshot (debounced per
        // gesture).
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
        // Dependency readiness per project. The wire shape flattens the recipe and drops its `marker`, the
        // browser renders manager/command/evidence and never needs to know which directory proves an install.
        // A stale project carries HOW MANY names cannot resolve rather than which: the panel's sentence needs a
        // number, and the list is long exactly when it is least worth sending.
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
        // Install the named projects. This UI request joins the same durable coordinator queue as an agent's
        // request; starting a panel directly here would bypass the one owner of installs and could run two
        // package managers over the same tree. The client list is still only a pre-upload guess, so the
        // coordinator re-resolves it and an already-ready project remains a silent no-op.
        install: i.install.handler(async ({ input }) => {
            const result = await services.dependencies.requestInstall(input.dirs, { kind: "request", title: "Workspace import" });
            return { queued: [...result.queued] };
        }),
        repos: i.repos.handler(async () => ({ repos: await discoverRepos(services.workspace.root) })),
        // Every repo's modules, in one read, "root" (the /work repo, whose dir IS the workspace root) plus each
        // discovered repo, exactly the candidate set the Changes review scans.
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
            // Mint the preview route at clone time, hostnames must predate the first browser lookup (an early
            // NXDOMAIN gets negative-cached for the zone's SOA TTL).
            void services.ensurePreviewRoutes([previewLabel(input.name)]);
            services.history.notifyUserWrite();
            return { name: input.name, path: input.name };
        }),
        // On-demand refresh: force-fetch (no throttle) + guarded fast-forward every repo with a remote, returning
        // per-repo outcomes. A fast-forward changes tracked files, so ping history to snapshot it as a user write.
        sync: i.sync.handler(async () => {
            const repos = (await syncWorkspaceRepos(services, 0)).map(({ repo, outcome }) => Object.assign({ repo }, outcome));
            services.history.notifyUserWrite();
            return { repos };
        }),
        // The addable app types the configured source repo offers, drives the apps extension's Add-app picker.
        templates: i.templates.handler(async () => ({ templates: await listTemplates(services) })),
        // Add one or more named app instances into an EXISTING monorepo, from the web app's apps extension.
        // Each entry is a { template, name } object; each instance previews at preview-<repo>--<name>-<id>.<zone>.
        // Runs as a one-shot tmux job (session panel-<repo>--add_apps), mirroring /intentic/apply: `intentic
        // add-app` runs the SAME @intentic/scaffold path in an attachable, detached terminal, so the minutes-long
        // pnpm install survives refresh/navigation and its output stays in scrollback above a live prompt.
        // Completion is observed by the apps extension polling the session's `running` on the global terminals
        // list. The `--add_apps` key uses an underscore so it can never collide with an app panel key
        // (<repo>--<app>, where an app name is a lowercase slug); `start` no-ops while the job runs, so a second
        // Add to the same repo can't spawn a concurrent install.
        addApps: i.addApps.handler(async ({ input }) => {
            const repo = monorepoOf(input.repo);
            const repoDir = join(services.workspace.root, repo);
            const { source, ref } = await readTemplatesConfig(services);
            const apps = input.apps.map((app) => (app.name === app.template ? app.template : `${app.template}:${app.name}`)).join(",");
            const command = `intentic scaffold add-app --dir ${shellQuote(repoDir)} --apps ${shellQuote(apps)} --source ${shellQuote(source)} --ref ${shellQuote(ref)}`;
            // Mint every app's preview route up front in one batch, idempotent, and hostnames must predate the
            // first browser lookup (an early NXDOMAIN gets negative-cached for the zone's SOA TTL).
            void services.ensurePreviewRoutes(input.apps.map((app) => previewLabel(appPanelKey(repo, app.name))));
            await services.processes.start(`${repo}--add_apps`, { command, cwd: repoDir, oneShot: true });
            return { ok: true } as const;
        }),
        // The app instances present in this monorepo, each with its own preview URL + live status, drives
        // the apps extension's list. Scans `_apps/` for scaffolded instances and dev-server packages alike.
        appsList: i.appsList.handler(async ({ input }) => {
            const repo = monorepoOf(input.repo);
            const repoDir = join(services.workspace.root, repo);
            const manifest = await loadManifest(services);
            const apps = await Promise.all(
                discoverApps(repoDir, manifest).map(async ({ app, kind }) => {
                    const port = services.processes.portOf(appPanelKey(repo, app));
                    // An app preview's port IS the one the daemon assigned (buildAppSpec mirrors it into the
                    // app's own var), so the probe only has to settle which scheme answers on it, a Vite
                    // serving https on a dev cert is up, and used to read as down.
                    // Cached, because this is a POLLED read: the tree is refetched constantly and an app whose
                    // dev server is not up yet costs the probe's full three-second timeout every single time.
                    const healthy = port !== undefined && (await cachedScheme(port)) !== undefined;
                    const url = previewUrl(appPanelKey(repo, app), zone, sandboxId);
                    // `kind` and `previewUrl` are both optional on the wire, an app whose type nothing
                    // identified, and a loopback sandbox with no preview host, each just omit theirs.
                    const summary = { app, running: port !== undefined, healthy };
                    return Object.assign(summary, kind !== undefined ? { kind } : {}, url !== undefined ? { previewUrl: url } : {});
                }),
            );
            return { apps };
        }),
        // The monorepo's workspace package dependency graph, drives the apps extension's Dependencies view.
        packageGraph: i.packageGraph.handler(({ input }) => readPackageGraph(join(services.workspace.root, monorepoOf(input.repo)))),
        // Start one app instance's preview dev server (its own process + port + preview-<repo>--<app>-<id>.<zone> host).
        startApp: i.startApp.handler(async ({ input }) => {
            const repo = monorepoOf(input.repo);
            const repoDir = join(services.workspace.root, repo);
            const manifest = await loadManifest(services);
            const found = discoverApps(repoDir, manifest).find(({ app }) => app === input.app);
            if (found === undefined) {
                throw new ORPCError("NOT_FOUND", { message: `no app "${input.app}" in ${repo}` });
            }
            // Kick off the preview-route mint fire-and-forget (like addApps/addRepo), NOT awaited: the tmux
            // session the browser attaches to must not wait on a platform round-trip. The route resolves long
            // before the dev server is healthy enough for anyone to open its preview URL.
            void services.ensurePreviewRoutes([previewLabel(appPanelKey(repo, input.app))]);
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
        // Run vitest for the given repo-relative project dirs in a one-shot tmux panel session
        // (panel-<repo>--<session>), so it streams into the global terminal panel exactly like a dev server.
        // `session` is a validated slug suffix (an app/package `<name>__test`, or `tests`); `dirs` are
        // repo-contained package dirs ("" = the repo root). The daemon creating the session up front (like
        // startApp) is what lets the browser's openFocused reliably tab+focus it.
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
