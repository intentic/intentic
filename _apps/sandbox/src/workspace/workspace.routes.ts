import { existsSync } from "node:fs";
import { join } from "node:path";
import { MAX_REF_CANDIDATES, previewLabel, previewUrl, workspaceContract, zoneFromUrl } from "@intentic/sandbox-contract";
import { sandboxIdFromToken } from "@intentic/sandbox-contract/tunnel-ids";
import { implement, ORPCError } from "@orpc/server";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../context.js";
import { repoGitDir } from "../history/history.js";
import { probePort } from "../processes/managed-processes.js";
import { shellQuote } from "../terminal/terminal-run.js";
import { appPanelKey, buildAppSpec, discoverApps } from "./app-previews.js";
import { classifyWorkspace } from "./classify.js";
import { readPackageGraph } from "./package-graph.js";
import { discoverRepos, isValidRepoName } from "./repo-discovery.js";
import { resolveReference } from "./resolve-reference.js";
import { startInstall, workspaceSetup } from "./workspace-setup.js";
import { syncWorkspaceRepos } from "./sync-repos.js";
import { listTemplates, loadManifest, readTemplatesConfig } from "../scaffold/templates-config.js";
import { isControlPlanePath, resolveWithin } from "./workspace-files.js";

// The full /work view + extra-repo cloning. The binary /workspace/raw preview is a plain Hono route in app.ts
// (a streamed binary body doesn't fit oRPC). External MCP tools moved to the unified capabilities manifest.
export const createWorkspaceRoutes = (services: Services) => {
    const i = implement(workspaceContract).$context<OrpcContext>();
    // Resolve a root-relative path to an absolute one inside /work, applying the read routes' escape guard: a
    // `../`/absolute path that climbs out of /work is BAD_REQUEST.
    const contained = (relPath: string): string => {
        const target = resolveWithin(services.workspace.root, relPath);
        if (target === undefined) {
            throw new ORPCError("BAD_REQUEST", { message: "invalid path" });
        }
        // The daemon's credential + auth state is not reachable through the generic file API — read, write, move
        // or delete (see isControlPlanePath). NOT_FOUND rather than FORBIDDEN: the file API simply has nothing
        // there, and a distinct code would confirm what it holds.
        if (isControlPlanePath(services.workspace.root, target)) {
            throw new ORPCError("NOT_FOUND", { message: "not found" });
        }
        return target;
    };
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
        tree: i.tree.handler(() => services.workspaceTree(services.workspace.root)),
        // Lazy-load the children of an ignored dir (node_modules, .git, …) the tree didn't descend into.
        children: i.children.handler(({ input }) => services.workspaceChildren(services.workspace.root, input.path)),
        file: i.file.handler(async ({ input }) => {
            const content = await services.files.read(contained(input.path));
            if (content === undefined) {
                throw new ORPCError("NOT_FOUND", { message: "not found" });
            }
            return { path: input.path, content };
        }),
        /* Which workspace file a NAMED reference means — the lookup behind every clickable path in the UI (chat
         * prose, terminal output, a tool card's chip). The search itself is resolveReference; this wires it to
         * the workspace (through the same escape + control-plane guards as every other read) and to the iq
         * engine's path glob, an in-memory regex pass over the sweep it already holds, which is why trying a
         * handful of tails costs nothing worth optimizing. */
        resolve: i.resolve.handler(({ input, signal }) =>
            resolveReference(
                input.path,
                services.workspace.root,
                (relPath) => {
                    const abs = resolveWithin(services.workspace.root, relPath);
                    return abs !== undefined && !isControlPlanePath(services.workspace.root, abs) && existsSync(abs);
                },
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
            ),
        ),
        // Runs the resident iq engine in-process (services.iq) — same engine the agent's Bash `iq` calls use,
        // minus the per-query process spawn, workspace sweep, and inline revalidation those pay. The request's
        // abort signal kills the engine's rg child when the browser supersedes a search mid-flight.
        search: i.search.handler(async ({ input, signal }) => {
            const verb = input.mode ?? "q";
            const ignored = input.includeIgnored === true;
            const outcome = await services.iq.run(
                {
                    verb,
                    query: input.query,
                    scope: ignored ? { ignored: true } : {},
                    // Budget mirrors the iq CLI's default so the panel's result sizes match a bare `iq` call.
                    render: {
                        budget: 1500,
                        ...(input.limit !== undefined ? { limit: input.limit } : {}),
                        ...(input.after !== undefined ? { after: input.after } : {}),
                    },
                    options: {},
                    // Echo mirrors the CLI form — it seeds the pagination cursor id, so it must be stable for
                    // the same query+mode+scope across requests.
                    echo: `${verb === "q" ? "" : `${verb} `}"${input.query}"${ignored ? " --ignored" : ""}`,
                },
                signal,
            );
            return outcome.result;
        }),
        // Read-only, no-LLM classification of the dropped workspace into coarse buckets. Runs over the same
        // filtered tree the file view uses, so it never sees .git/secrets/node_modules. The browser turns the
        // proposal into accepted moves via the move route below — nothing here mutates /work.
        classify: i.classify.handler(async () => classifyWorkspace(services.workspace.root, await services.workspaceTree(services.workspace.root))),
        // Direct file management over /work (byte writes go through POST /workspace/upload). Both endpoints of a
        // move/copy run through `contained`, so neither source nor target can escape /work or reach the daemon's
        // control plane. Every mutation pings history so it lands as a user-authored snapshot (debounced per
        // gesture).
        mkdir: i.mkdir.handler(async ({ input }) => {
            await services.files.mkdir(contained(input.path));
            services.history.notifyUserWrite();
            return { ok: true } as const;
        }),
        delete: i.delete.handler(async ({ input }) => {
            await services.files.remove(contained(input.path));
            services.history.notifyUserWrite();
            return { ok: true } as const;
        }),
        move: i.move.handler(async ({ input }) => {
            await services.files.move(contained(input.from), contained(input.to));
            services.history.notifyUserWrite();
            return { ok: true } as const;
        }),
        copy: i.copy.handler(async ({ input }) => {
            await services.files.copy(contained(input.from), contained(input.to));
            services.history.notifyUserWrite();
            return { ok: true } as const;
        }),
        // Dependency readiness per project. The wire shape flattens the recipe and drops its `marker` — the
        // browser renders manager/command/evidence and never needs to know which directory proves an install.
        setup: i.setup.handler(async () => ({
            projects: (await workspaceSetup(services.workspace.root, services.processes)).map(({ dir, recipe, state }) => ({
                dir,
                ecosystem: recipe.ecosystem,
                manager: recipe.manager,
                command: recipe.command,
                evidence: recipe.evidence,
                state,
            })),
        })),
        // Install the named projects. The CLIENT's list is a request, not an instruction: it comes from a
        // pre-upload guess made in the browser (which cannot see what's already on disk), so every dir is
        // re-resolved against the real workspace and only genuine `needs-setup` projects run. That is what
        // makes a re-drop of an already-installed repo a silent no-op instead of a redundant reinstall.
        install: i.install.handler(async ({ input }) => {
            const requested = new Set(input.dirs);
            const projects = (await workspaceSetup(services.workspace.root, services.processes)).filter(
                (project) => requested.has(project.dir) && project.state === "needs-setup",
            );
            await Promise.all(projects.map((project) => startInstall(services.workspace.root, project, services.processes)));
            return { started: projects.map((project) => project.dir) };
        }),
        repos: i.repos.handler(async () => ({ repos: await discoverRepos(services.workspace.root) })),
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
            // Mint the preview route at clone time — hostnames must predate the first browser lookup (an early
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
        // The addable app types the configured source repo offers — drives the apps extension's Add-app picker.
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
            // Mint every app's preview route up front in one batch — idempotent, and hostnames must predate the
            // first browser lookup (an early NXDOMAIN gets negative-cached for the zone's SOA TTL).
            void services.ensurePreviewRoutes(input.apps.map((app) => previewLabel(appPanelKey(repo, app.name))));
            await services.processes.start(`${repo}--add_apps`, { command, cwd: repoDir, oneShot: true });
            return { ok: true } as const;
        }),
        // The app instances present in this monorepo, each with its own preview URL + live status — drives
        // the apps extension's list. Scans `_apps/` and resolves each to its template type.
        appsList: i.appsList.handler(async ({ input }) => {
            const repo = monorepoOf(input.repo);
            const repoDir = join(services.workspace.root, repo);
            const manifest = await loadManifest(services);
            const apps = await Promise.all(
                discoverApps(repoDir, manifest).map(async ({ app, template }) => {
                    const port = services.processes.portOf(appPanelKey(repo, app));
                    const healthy = port !== undefined && (await probePort(port));
                    const url = previewUrl(appPanelKey(repo, app), zone, sandboxId);
                    const summary = { app, template, running: port !== undefined, healthy };
                    return url !== undefined ? Object.assign(summary, { previewUrl: url }) : summary;
                }),
            );
            return { apps };
        }),
        // The monorepo's workspace package dependency graph — drives the apps extension's Dependencies view.
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
