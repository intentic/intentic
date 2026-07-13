import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { WorkspaceSearchResultSchema, previewUrl, workspaceContract, zoneFromUrl } from "@intentic/sandbox-contract";
import { sandboxIdFromToken } from "@intentic/sandbox-contract/tunnel-ids";
import { implement, ORPCError } from "@orpc/server";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../context.js";
import { repoGitDir } from "../history/history.js";
import { probePort } from "../panels/panel-processes.js";
import { shellQuote } from "../system/terminal-run.js";
import { appPanelKey, buildAppSpec, discoverApps } from "./app-previews.js";
import { classifyWorkspace } from "./classify.js";
import { isValidRepoName, listRepos } from "./repos.js";
import { syncWorkspaceRepos } from "./sync-repos.js";
import { listTemplates, loadManifest, readTemplatesConfig } from "./templates-config.js";
import { resolveWithin } from "./workspace-files.js";

const exec = promisify(execFile);

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
        if (!existsSync(join(services.workspace.repositories, repo))) {
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
        // Shells into the iq CLI (on PATH in the image): one search implementation for the agent's Bash calls
        // and this route. Exit 1 = zero hits, still a valid WorkspaceSearchResult document.
        search: i.search.handler(async ({ input }) => {
            const args = [input.mode ?? "q", input.query, "--json"];
            if (input.includeIgnored === true) {
                args.push("--ignored");
            }
            if (input.limit !== undefined) {
                args.push("--limit", String(input.limit));
            }
            if (input.after !== undefined) {
                args.push("--after", input.after);
            }
            const { stdout } = await exec("iq", args, {
                cwd: services.workspace.root,
                env: { ...process.env, WORKSPACE_ROOT: services.workspace.root },
                maxBuffer: 8 * 1024 * 1024,
            }).catch((error: Error & { code?: unknown; stdout?: string }) => {
                if (error.code === 1 && error.stdout !== undefined) {
                    return { stdout: error.stdout };
                }
                throw error;
            });
            return WorkspaceSearchResultSchema.parse(JSON.parse(stdout));
        }),
        // Read-only, no-LLM classification of the dropped workspace into coarse buckets. Runs over the same
        // filtered tree the file view uses, so it never sees .git/secrets/node_modules. The browser turns the
        // proposal into accepted moves via the move route below — nothing here mutates /work.
        classify: i.classify.handler(async () => classifyWorkspace(services.workspace.root, await services.workspaceTree(services.workspace.root))),
        // Direct file management over /work (byte writes go through POST /workspace/upload). Both endpoints of a
        // move/copy are guarded, so neither source nor target can escape or touch a secret/`.git` path. Every
        // mutation pings history so it lands as a user-authored snapshot (debounced per gesture).
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
        repos: i.repos.handler(async () => ({ repos: await listRepos(services.workspace.repositories) })),
        addRepo: i.addRepo.handler(async ({ input }) => {
            if (!isValidRepoName(input.name)) {
                throw new ORPCError("BAD_REQUEST", { message: "invalid or reserved repo name" });
            }
            if ((await listRepos(services.workspace.repositories)).includes(input.name)) {
                throw new ORPCError("CONFLICT", { message: `a repo named "${input.name}" already exists` });
            }
            // The repositories/ dir may not exist yet on a fresh sandbox; git clone needs its parent present.
            await services.files.mkdir(services.workspace.repositories);
            await services.git.clone(services.workspace.repositories, input.name, input.cloneUrl, {
                ...(input.branch !== undefined ? { branch: input.branch } : {}),
                separateGitDir: repoGitDir(services.config.historyRoot, input.name),
            });
            // Mint the preview route at clone time — hostnames must predate the first browser lookup (an early
            // NXDOMAIN gets negative-cached for the zone's SOA TTL).
            void services.ensurePreviewRoute(input.name);
            services.history.notifyUserWrite();
            return { name: input.name, path: input.name };
        }),
        // On-demand refresh: force-fetch (no throttle) + guarded fast-forward every repo with a remote, returning
        // per-repo outcomes. A fast-forward changes tracked files, so ping history to snapshot it as a user write.
        sync: i.sync.handler(async () => {
            const repos = (await syncWorkspaceRepos(services, 0)).map(({ repo, outcome }) => ({ repo, ...outcome }));
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
            const repoDir = join(services.workspace.repositories, repo);
            const { source, ref } = await readTemplatesConfig(services);
            const apps = input.apps.map((app) => (app.name === app.template ? app.template : `${app.template}:${app.name}`)).join(",");
            const command = `intentic add-app --dir ${shellQuote(repoDir)} --apps ${shellQuote(apps)} --source ${shellQuote(source)} --ref ${shellQuote(ref)}`;
            // Mint each app's preview route up front — idempotent, and hostnames must predate the first browser
            // lookup (an early NXDOMAIN gets negative-cached for the zone's SOA TTL).
            for (const app of input.apps) {
                void services.ensurePreviewRoute(appPanelKey(repo, app.name));
            }
            await services.panelProcesses.start(`${repo}--add_apps`, { command, cwd: repoDir, oneShot: true });
            return { ok: true } as const;
        }),
        // The app instances present in this monorepo, each with its own preview URL + live status — drives
        // the apps extension's list. Scans `_apps/` and resolves each to its template type.
        appsList: i.appsList.handler(async ({ input }) => {
            const repo = monorepoOf(input.repo);
            const repoDir = join(services.workspace.repositories, repo);
            const manifest = await loadManifest(services);
            const apps = await Promise.all(
                discoverApps(repoDir, manifest).map(async ({ app, template }) => {
                    const port = services.panelProcesses.portOf(appPanelKey(repo, app));
                    const healthy = port !== undefined && (await probePort(port));
                    const url = previewUrl(appPanelKey(repo, app), zone, sandboxId);
                    const summary = { app, template, running: port !== undefined, healthy };
                    return url !== undefined ? Object.assign(summary, { previewUrl: url }) : summary;
                }),
            );
            return { apps };
        }),
        // Start one app instance's preview dev server (its own process + port + preview-<repo>--<app>-<id>.<zone> host).
        startApp: i.startApp.handler(async ({ input }) => {
            const repo = monorepoOf(input.repo);
            const repoDir = join(services.workspace.repositories, repo);
            const manifest = await loadManifest(services);
            const found = discoverApps(repoDir, manifest).find(({ app }) => app === input.app);
            if (found === undefined) {
                throw new ORPCError("NOT_FOUND", { message: `no app "${input.app}" in ${repo}` });
            }
            // Mint the preview route before the app is observable as running (see panels/preview-route.ts).
            await services.ensurePreviewRoute(appPanelKey(repo, input.app));
            await services.panelProcesses.start(
                appPanelKey(repo, input.app),
                buildAppSpec({ repo, repoDir, pkg: found.pkg, app: input.app, preview: found.preview, zone, sandboxId }),
            );
            return { ok: true } as const;
        }),
        stopApp: i.stopApp.handler(async ({ input }) => {
            const repo = monorepoOf(input.repo);
            services.panelProcesses.stop(appPanelKey(repo, input.app));
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
            const repoDir = join(services.workspace.repositories, repo);
            const command = input.dirs
                .map((dir) => {
                    const abs = dir === "" ? repoDir : resolveWithin(repoDir, dir);
                    if (abs === undefined) {
                        throw new ORPCError("BAD_REQUEST", { message: `invalid test dir "${dir}"` });
                    }
                    return `(cd ${shellQuote(abs)} && pnpm vitest run)`;
                })
                .join("; ");
            await services.panelProcesses.start(`${repo}--${input.session}`, { command, cwd: repoDir, oneShot: true });
            return { ok: true } as const;
        }),
    };
};
