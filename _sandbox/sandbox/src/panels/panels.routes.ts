import { existsSync } from "node:fs";
import { join } from "node:path";
import { STATE_DIR } from "@intentic/constants";
import { ARTIFACT_FILE, CONFIG_FILE, REPO_ROLES, type RepoRole } from "@intentic/scaffold";
import { panelsContract } from "@intentic/sandbox-contract/contracts/panels.contract";
import type { PanelLaunch, PanelSummary } from "@intentic/sandbox-contract/schemas/panels";
import { previewUrl } from "@intentic/sandbox-contract/ids/hostnames";
import { implement, ORPCError } from "@orpc/server";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../app-env.js";
import { resolvePanelUpstream } from "./panel-upstream.js";
import { discoverPanels, listenerDir, listenersByRepo, oneServerPerDir, panelKey, windowsByRepo } from "./panels.js";
import { type ProgramWindow, programWindows } from "../desktop/program-windows.js";
import type { RunPlan } from "./run-plan.js";
import { cachedScheme } from "../ports/port-probe.js";
import type { ListeningPort } from "../ports/port-scan.js";
import { panelSession } from "@intentic/sandbox-contract/session-names";
import { publicAddressOf } from "../env.config.js";
import { testRunnerOf } from "../workspace/layout/test-runner.js";
import { sandboxTargetsAt } from "../workspace/layout/run-file.js";

// Per-repository panel routes. `list` reports each repo's runtime status and the content facts extensions detect on
// (role, marker files, evidence, not identity); `start`/`stop` drive the repo's dev server, whose tmux session shows on
// GET /system/terminals. Panels authenticate to the daemon via the injected INTENTIC_PANEL_TOKEN.

// Acceptance evidence: one user-story file per feature; a directory since the stories are the evidence.
const USER_STORIES_DIR = join("docs", "user-stories");

// Architecture docs directory; same evidence shape as USER_STORIES_DIR, the documents themselves are the fact.
const ARCHITECTURE_DIR = join("docs", "architecture");

export type PanelsRoutesDeps = Pick<Services, "config" | "panelToken" | "processes" | "scanPorts" | "workspace">;

export interface PanelsRoutesOptions {
    // The windows open on the sandbox desktop with where each program runs; the real desktop's unless a test says.
    readonly windows?: () => Promise<readonly ProgramWindow[]>;
}

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

// Facts computed once so the browser never N+1-scans /work; each extension reads its own presence here.
const contentFacts = (dir: string) => ({
    deployConfig: existsSync(join(dir, CONFIG_FILE)),
    desiredState: existsSync(join(dir, ARTIFACT_FILE)),
    directoryUi: existsSync(join(dir, STATE_DIR, "ui", "index.html")),
    monorepo: existsSync(join(dir, "pnpm-workspace.yaml")) && existsSync(join(dir, "turbo.json")),
    tests: testRunnerOf(dir) !== undefined,
    userStories: existsSync(join(dir, USER_STORIES_DIR)),
    docs: existsSync(join(dir, ARCHITECTURE_DIR)),
});

// The summary's fields that apply only sometimes, each one there only when it does; optional on the wire.
const presentFacts = (facts: {
    readonly repo: string;
    readonly plan: RunPlan | undefined;
    readonly opened: readonly { readonly id: string; readonly title: string }[];
    readonly launch: PanelLaunch | undefined;
    readonly port: number | undefined;
    readonly url: string | undefined;
}): Partial<PanelSummary> => {
    const present: Partial<PanelSummary> = {};
    if (facts.launch !== undefined) {
        present.launch = facts.launch;
    }
    if (facts.plan !== undefined) {
        present.start = { from: facts.plan.source, command: facts.plan.shown };
    }
    if (facts.opened.length > 0) {
        present.windows = [...facts.opened];
    }
    // SAFETY: REPO_ROLES is the RepoRole tuple, so a name it includes is a RepoRole; widened only to ask about any string.
    if ((REPO_ROLES as readonly string[]).includes(facts.repo)) {
        // SAFETY: just checked to be one of REPO_ROLES.
        present.role = facts.repo as RepoRole;
    }
    if (facts.port !== undefined) {
        present.port = facts.port;
    }
    if (facts.url !== undefined) {
        present.previewUrl = facts.url;
    }
    return present;
};

export const createPanelsRoutes = (services: PanelsRoutesDeps, { windows: readWindows = programWindows }: PanelsRoutesOptions = {}) => {
    const i = implement(panelsContract).$context<OrpcContext>();
    const { zone, sandboxId } = publicAddressOf(services.config);

    return {
        list: i.list.handler(async () => {
            const discovered = await discoverPanels(services.workspace);
            // One procfs walk for the whole list; scanning per repo would re-read every process's fd table repeatedly.
            const [listeners, windows] = await Promise.all([services.scanPorts(), readWindows()]);
            const repos = discovered.map(({ repo }) => repo);
            const attributed = listenersByRepo(listeners, services.workspace.root, repos);
            const windowsOf = windowsByRepo(windows, services.workspace.root, repos);
            const dirs = discovered.map(({ repo }) => join(services.workspace.root, repo));
            const panels = await Promise.all(
                discovered.map(async ({ repo, plan }) => {
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
                    // A window is the other way a run shows it is up: a game or a desktop app serves nothing.
                    const opened = (windowsOf.get(repo) ?? []).map(({ id, title }) => ({ id, title }));
                    // `launch` matters only until upstream serves or a window opens; the iframe or the window is the
                    // state after that, so no lingering "starting".
                    const launch =
                        key !== undefined && upstream.state !== "serving" && opened.length === 0 ? services.processes.launchOf(key) : undefined;
                    return Object.assign(
                        {
                            repo,
                            hasPanel: plan !== undefined,
                            running: port !== undefined,
                            // True whenever the repo answers, including a hand-started server (acceptance just needs an
                            // address) and a program whose window is open.
                            healthy: servers.length > 0 || opened.length > 0,
                            servers,
                            // Nothing runnable means nothing to install for.
                            installed: plan?.installed ?? true,
                            ...contentFacts(dir),
                        },
                        presentFacts({ repo, plan, opened, launch, port, url }),
                        // Its run.json's sandbox targets are its apps; said only when it has some.
                        sandboxTargetsAt(dir).length > 0 ? { sandboxTargets: true } : {},
                    );
                }),
            );
            return { panels };
        }),
        start: i.start.handler(async ({ input }) => {
            const found = (await discoverPanels(services.workspace)).find((entry) => entry.repo === input.repo);
            if (found === undefined) {
                throw new ORPCError("NOT_FOUND", { message: "no repository with that name" });
            }
            const key = panelKey(input.repo);
            if (key === undefined) {
                throw new ORPCError("BAD_REQUEST", { message: `${input.repo} has no preview-safe name, only letters, digits, hyphens and / work` });
            }
            if (found.plan === undefined) {
                throw new ORPCError("BAD_REQUEST", {
                    message: `${input.repo} has nothing to start: declare a target with a command in .intentic/run.json, or add a Procfile, a dev or start script, or a Cargo binary`,
                });
            }
            await services.processes.start(key, {
                durable: true,
                command: found.plan.command,
                cwd: found.plan.cwd,
                // Whatever it turns out to be: a window it opens lands on the sandbox desktop, where the Browsers view shows it.
                desktop: true,
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
                await services.processes.stop(key);
            }
            return { ok: true } as const;
        }),
    };
};
