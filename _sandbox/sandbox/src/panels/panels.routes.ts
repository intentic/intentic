import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { STATE_DIR } from "@intentic/constants";
import { ARTIFACT_FILE, CONFIG_FILE, REPO_ROLES, type RepoRole } from "@intentic/scaffold";
import { panelsContract, previewUrl, zoneFromUrl } from "@intentic/sandbox-contract";
import { sandboxIdFromToken } from "@intentic/sandbox-contract/tunnel-ids";
import { implement, ORPCError } from "@orpc/server";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../context.js";
import { resolvePanelUpstream } from "./panel-upstream.js";
import { discoverPanels, listenerDir, listenersByRepo, oneServerPerDir, panelKey, panelRunDir } from "./panels.js";
import { cachedScheme } from "../ports/port-probe.js";
import type { ListeningPort } from "../ports/port-scan.js";
import { panelSession } from "../processes/managed-processes.js";

// The per-repository panel routes. `list` enumerates every repo with its runtime status + the content FACTS
// the web app's extensions detect on (role, marker files, evidence, not identity); `start`/`stop` drive the
// repo's dev server (its tmux session lists on the global GET /system/terminals). Panels talk back to the
// daemon via the injected INTENTIC_PANEL_TOKEN.

// Vitest evidence for repos without a root config: the workspace catalog / root manifest names it.
// ponytail: substring match, not a manifest parse, parse catalog/devDependencies if a stray mention ever bites.
const mentionsVitest = (file: string): boolean => existsSync(file) && readFileSync(file, "utf8").includes("vitest");

// The convention the acceptance extension detects on: a repo describing its features as user stories,
// one file each. A directory rather than a marker file because the stories ARE the evidence.
const USER_STORIES_DIR = join("docs", "user-stories");

// Where a repo's architecture documentation lands (the map; each package's page is its own README beside its
// code). Its sibling above, and the same shape of evidence: the documents ARE the fact.
const ARCHITECTURE_DIR = join("docs", "architecture");

export type PanelsRoutesDeps = Pick<Services, "config" | "panelToken" | "processes" | "scanPorts" | "workspace">;

/* The repo's answering dev servers, each probed for the scheme it speaks, named by the package that bound it,
 * and carrying the terminal it is running in.
 *
 * The panel's ASSIGNED port is probed alongside the attributed ones even when the scan didn't claim it: a dev
 * server that honors PORT is the ordinary case, and a cwd procfs wouldn't give up must not turn a serving app
 * into a dead one. That synthesized candidate takes the panel's own session, which is not a guess, the daemon
 * started it there.
 *
 * THE SESSION IS WHY THIS LIST IS ACTIONABLE. Every address here is something occupying a port, and the only
 * useful next question is where it is running: a repo the daemon started answers "the panel's terminal", a dev
 * server someone launched by hand answers with THEIR terminal, and something outside the sandbox answers
 * nothing, which a surface must be able to say out loud rather than offering a terminal that never existed.
 * Ordered by port so the list is stable across polls. */
const detectServers = async (
    workspaceRoot: string,
    repo: string,
    listeners: readonly ListeningPort[],
    panel: { readonly port: number; readonly session: string } | undefined,
): Promise<{ port: number; url: string; dir?: string; session?: string }[]> => {
    /* GATING THIS ON "IS THE PORT IN THE SCAN" WAS TRIED AND BACKED OUT, which is worth recording so the next
     * reader does not spend the afternoon re-deriving it. The idea was that a probe against a port the scan
     * never saw is guaranteed to fail, so it could be skipped. It is wrong twice.
     *
     * It breaks the case this candidate EXISTS for: the scan is one procfs walk, and when it comes back short
     * (or empty, which an unreadable /proc makes it) the daemon still knows it started this panel on this port,
     * which is the fact the synthesized candidate carries. Gating on the scan would make every running panel go
     * dark whenever the scan had a bad moment, trading a robust answer for a faster wrong one.
     *
     * And it does not even buy the latency: a port with NOTHING listening refuses the TCP connect immediately,
     * so the dead case was already fast. The three-second case is a port that ACCEPTS and then does not speak
     * HTTP (a WebSocket-only server, or one still coming up), and such a port is in the scan, so the gate would
     * have skipped exactly the probes that were already cheap. `cachedScheme` below is what actually addresses
     * the slow one. */
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
                // `localhost`, not the address the daemon dialed: the dev cert is issued for that name and an
                // app's CORS allowlist and auth origin are written with it, so handing out 127.0.0.1 would fail
                // the very checks a story walks through. The family the scan recorded is for OUR dial only.
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
            // ONE procfs walk for the whole list: the scan is a per-sandbox fact, and asking it per repo would
            // re-read every process's fd table once per repository.
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
                    // The panel the daemon runs, when it runs one: its assigned port and the terminal it put it in.
                    const panel = key !== undefined && port !== undefined ? { port, session: panelSession(key) } : undefined;
                    // The port rides along with the URL: a repo answering on several of them is previewable
                    // only by forwarding one, and that call takes the number, not a localhost address.
                    const servers = await detectServers(services.workspace.root, repo, attributed.get(repo) ?? [], panel);
                    /* THE PREVIEW URL IS A PROMISE, so it is only made where the proxy can keep it: the same
                     * resolution the proxy routes on (panel-upstream.ts), off the scan already in hand. A repo
                     * whose `dev` fans out across packages that pin their own ports is answering and NOT
                     * previewable at this one hostname, and the panel above has a screen for exactly that,
                     * which it can only show if this is honest. `assignedAnswers` comes from the dial above
                     * rather than the scan: it is the stronger evidence, and it is already paid for. */
                    const upstream = resolvePanelUpstream({
                        dir,
                        siblings: dirs,
                        listeners,
                        assignedPort: port,
                        assignedAnswers: port !== undefined && servers.some((server) => server.port === port),
                    });
                    const url = key !== undefined && upstream.state === "serving" ? previewUrl(key, zone, sandboxId) : undefined;
                    // What a Start would cost, read off the directory it runs in (the same one `start` runs
                    // in): dependencies on disk means seconds, their absence means an install first. A repo
                    // with nothing runnable has nothing to install for, and must not read as "needs an install".
                    const runDir = hasPanel ? await panelRunDir(services.workspace, repo) : undefined;
                    const installed = runDir === undefined ? true : existsSync(join(runDir, "node_modules"));
                    // Where a start the daemon runs has got to, only until the proxy has something to serve:
                    // from then on the iframe is the state, and "starting" beside it would be a contradiction.
                    const launch = key !== undefined && upstream.state !== "serving" ? services.processes.launchOf(key) : undefined;
                    // Content facts, computed in one pass so the browser never N+1-scans /work: each extension
                    // decides its own presence from this evidence (see the web app's extensions/extension.ts).
                    const summary = {
                        repo,
                        hasPanel,
                        running: port !== undefined,
                        // Something the repo owns is answering, which a repo whose dev server someone started
                        // in their own terminal also satisfies, deliberately: the acceptance run only needs an
                        // address that responds, and offering Start for an app already serving would collide on
                        // the very ports it pinned.
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
                // Install deps on first start (async, the terminal + "starting" badge cover it), then run the dev
                // server; skipped once installed. No --ignore-workspace: an app repo IS its own pnpm monorepo (its
                // dev runs turbo across _apps/*) so the whole workspace must install; the flat operator/ panels
                // have no ancestor workspace, so it's a standalone install there either way.
                // ponytail: assumes NODE_ENV != "production" (dev tooling lives in devDependencies), if a base
                // image ever pins it, inject NODE_ENV=development into the panel env below.
                // `&&` (left-assoc: `(test || install) && dev`) so a failed install stops with ITS error above
                // the prompt instead of burying it under the dev command's cascading failure. No `exec`, the
                // chain runs inside the pane's interactive shell (see managed-processes launch), which must
                // survive the command so Ctrl+C lands at a prompt and ↑ re-runs it.
                command: "test -d node_modules || pnpm install && pnpm dev",
                cwd: runDir,
                // The panel's backend calls the daemon with these (server-side, inside the sandbox), no browser
                // token flows into the iframe.
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
