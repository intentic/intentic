import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { STATE_DIR } from "@intentic/constants";
import { ARTIFACT_FILE, CONFIG_FILE, REPO_ROLES, type RepoRole } from "@intentic/scaffold";
import { panelsContract, previewUrl, zoneFromUrl } from "@intentic/sandbox-contract";
import { sandboxIdFromToken } from "@intentic/sandbox-contract/tunnel-ids";
import { implement, ORPCError } from "@orpc/server";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../app-env.js";
import { resolvePanelUpstream } from "./panel-upstream.js";
import { discoverPanels, listenerDir, listenersByRepo, oneServerPerDir, panelKey, panelRunDir } from "./panels.js";
import { cachedScheme } from "../ports/port-probe.js";
import type { ListeningPort } from "../ports/port-scan.js";
import { panelSession } from "../processes/managed-processes.js";

// Per-repository panel routes. `list` reports each repo's runtime status and the content facts extensions detect on
// (role, marker files, evidence, not identity); `start`/`stop` drive the repo's dev server, whose tmux session shows on
// GET /system/terminals. Panels authenticate to the daemon via the injected INTENTIC_PANEL_TOKEN.

// Vitest evidence when a repo has no root config: the workspace catalog or root manifest names it (substring match, not
// a parse). If a stray mention ever false-positives, parse catalog/devDependencies instead.
const mentionsVitest = (file: string): boolean => existsSync(file) && readFileSync(file, "utf8").includes("vitest");

// Acceptance evidence: one user-story file per feature; a directory since the stories are the evidence.
const USER_STORIES_DIR = join("docs", "user-stories");

// Architecture docs directory; same evidence shape as USER_STORIES_DIR, the documents themselves are the fact.
const ARCHITECTURE_DIR = join("docs", "architecture");

export type PanelsRoutesDeps = Pick<Services, "config" | "panelToken" | "processes" | "scanPorts" | "workspace">;

// Repo's answering dev servers, each probed for its scheme and tagged with its terminal. The assigned port is probed
// even when the scan missed it, carrying the panel's own session as fact; ordered by port for stability.
const detectServers = async (
    workspaceRoot: string,
    repo: string,
    listeners: readonly ListeningPort[],
    panel: { readonly port: number; readonly session: string } | undefined,
): Promise<{ port: number; url: string; dir?: string; session?: string }[]> => {
    // Not gated on the scan seeing the port: that would blind every panel when one procfs walk comes up short.
    const candidates =
        panel === undefined || listeners.some((listener) => listener.port === panel.port)
            ? listeners
            : [...listeners, { port: panel.port, host: "127.0.0.1" as const, forwardable: true, session: panel.session }];
    const probed = await Promise.all(
        candidates
            .toSorted((a, b) => a.port - b.port)
            .map(async (listener) => {
                const scheme = await cachedScheme(listener.port, listener.host);
                if (scheme === undefined) {
                    return undefined;
                }
                // Always `localhost`: the dev cert, CORS allowlist and auth origin are issued for it, not the dialed
                // address.
                const url = `${scheme}://localhost:${listener.port}`;
                const dir = listenerDir(listener, workspaceRoot, repo);
                const server: { port: number; url: string; dir?: string; session?: string } = { port: listener.port, url };
                if (dir !== undefined) {
                    server.dir = dir;
                }
                if (listener.session !== undefined) {
                    server.session = listener.session;
                }
                return server;
            }),
    );
    return oneServerPerDir(probed.filter((server) => server !== undefined));
};

export const createPanelsRoutes = (services: PanelsRoutesDeps) => {
    const i = implement(panelsContract).$context<OrpcContext>();
    const zone = services.config.zone !== "" ? services.config.zone : zoneFromUrl(services.config.sandbox.publicUrl);
    const sandboxId = sandboxIdFromToken(services.config.connectToken);

    return {
        list: i.list.handler(async () => {
            const discovered = await discoverPanels(services.workspace);
            // One procfs walk for the whole list; scanning per repo would re-read every process's fd table repeatedly.
            const listeners = await services.scanPorts();
            const attributed = listenersByRepo(
                listeners,
                services.workspace.root,
                discovered.map(({ repo }) => repo),
            );
            const dirs = discovered.map(({ repo }) => join(services.workspace.root, repo));
            const panels = await Promise.all(
                discovered.map(async ({ repo, hasPanel }) => {
                    const key = panelKey(repo);
                    const port = key !== undefined ? services.processes.portOf(key) : undefined;
                    const dir = join(services.workspace.root, repo);
                    // The panel the daemon runs, if any: its assigned port and the terminal the daemon put it in.
                    const panel = key !== undefined && port !== undefined ? { port, session: panelSession(key) } : undefined;
                    // Passed alongside the URL: forwarding needs the port number, not a localhost address, when several
                    // answer.
                    const servers = await detectServers(services.workspace.root, repo, attributed.get(repo) ?? [], panel);
                    // `assignedAnswers` reuses the dial already done above, stronger evidence than the scan and already
                    // paid for.
                    const upstream = resolvePanelUpstream({
                        dir,
                        siblings: dirs,
                        listeners,
                        assignedPort: port,
                        assignedAnswers: port !== undefined && servers.some((server) => server.port === port),
                    });
                    const url = key !== undefined && upstream.state === "serving" ? previewUrl(key, zone, sandboxId) : undefined;
                    // Install cost read from the same directory `start` runs in; nothing runnable means nothing to
                    // install for.
                    const runDir = hasPanel ? await panelRunDir(services.workspace, repo) : undefined;
                    const installed = runDir === undefined ? true : existsSync(join(runDir, "node_modules"));
                    // `launch` matters only until upstream serves; the iframe is the state after that, so no lingering
                    // "starting".
                    const launch = key !== undefined && upstream.state !== "serving" ? services.processes.launchOf(key) : undefined;
                    // Facts computed once so the browser never N+1-scans /work; each extension reads its own presence
                    // here.
                    const summary = {
                        repo,
                        hasPanel,
                        running: port !== undefined,
                        // True whenever the repo answers, including a hand-started server: acceptance just needs an
                        // address.
                        healthy: servers.length > 0,
                        servers,
                        installed,
                        ...(launch === undefined ? {} : { launch }),
                        deployConfig: existsSync(join(dir, CONFIG_FILE)),
                        desiredState: existsSync(join(dir, ARTIFACT_FILE)),
                        directoryUi: existsSync(join(dir, STATE_DIR, "ui", "index.html")),
                        monorepo: existsSync(join(dir, "pnpm-workspace.yaml")) && existsSync(join(dir, "turbo.json")),
                        vitest:
                            existsSync(join(dir, "vitest.config.ts")) ||
                            mentionsVitest(join(dir, "pnpm-workspace.yaml")) ||
                            mentionsVitest(join(dir, "package.json")),
                        userStories: existsSync(join(dir, USER_STORIES_DIR)),
                        docs: existsSync(join(dir, ARCHITECTURE_DIR)),
                    };
                    const withRole = (REPO_ROLES as readonly string[]).includes(repo) ? Object.assign(summary, { role: repo as RepoRole }) : summary;
                    const withPort = port !== undefined ? Object.assign(withRole, { port }) : withRole;
                    return url !== undefined ? Object.assign(withPort, { previewUrl: url }) : withPort;
                }),
            );
            return { panels };
        }),
        start: i.start.handler(async ({ input }) => {
            if (!(await discoverPanels(services.workspace)).some((entry) => entry.repo === input.repo)) {
                throw new ORPCError("NOT_FOUND", { message: "no repository with that name" });
            }
            const key = panelKey(input.repo);
            if (key === undefined) {
                throw new ORPCError("BAD_REQUEST", { message: `${input.repo} has no preview-safe name, only letters, digits, hyphens and / work` });
            }
            const runDir = await panelRunDir(services.workspace, input.repo);
            if (runDir === undefined) {
                throw new ORPCError("BAD_REQUEST", { message: `${input.repo} has no runnable panel, add an operator/ dev server or a dev script` });
            }
            await services.processes.start(key, {
                // No `exec`: keeps the interactive shell so Ctrl+C and re-running with ↑ still work through
                // install-then-dev.
                command: "test -d node_modules || pnpm install && pnpm dev",
                cwd: runDir,
                // Server-side only, inside the sandbox; the panel token never reaches the browser iframe.
                env: {
                    INTENTIC_DAEMON: `http://127.0.0.1:${services.config.sandbox.port}`,
                    INTENTIC_PANEL_TOKEN: services.panelToken,
                },
            });
            return { ok: true } as const;
        }),
        stop: i.stop.handler(async ({ input }) => {
            if (!(await discoverPanels(services.workspace)).some((entry) => entry.repo === input.repo)) {
                throw new ORPCError("NOT_FOUND", { message: "no repository with that name" });
            }
            const key = panelKey(input.repo);
            if (key !== undefined) {
                services.processes.stop(key);
            }
            return { ok: true } as const;
        }),
    };
};
