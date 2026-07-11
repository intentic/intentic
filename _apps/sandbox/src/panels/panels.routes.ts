import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ARTIFACT_FILE, CONFIG_FILE } from "@intentic/scaffold";
import { panelsContract, previewUrl, zoneFromUrl } from "@intentic/sandbox-contract";
import { sandboxIdFromToken } from "@intentic/sandbox-contract/tunnel-ids";
import { implement, ORPCError } from "@orpc/server";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../context.js";
import { REPO_ROLES, type RepoRole } from "../workspace/workspace.js";
import { discoverPanels, panelRunDir } from "./panels.js";
import { probePort } from "./panel-processes.js";

// The per-repository panel routes. `list` enumerates every repo with its runtime status + the content FACTS
// the web app's extensions detect on (role, marker files — evidence, not identity); `start`/`stop` drive the
// repo's dev server (its tmux session lists on the global GET /system/terminals). Panels talk back to the
// daemon via the injected INTENTIC_PANEL_TOKEN.

// Vitest evidence for repos without a root config: the workspace catalog / root manifest names it.
// ponytail: substring match, not a manifest parse — parse catalog/devDependencies if a stray mention ever bites.
const mentionsVitest = (file: string): boolean => existsSync(file) && readFileSync(file, "utf8").includes("vitest");

export const createPanelsRoutes = (services: Services) => {
    const i = implement(panelsContract).$context<OrpcContext>();
    const zone = services.config.zone !== "" ? services.config.zone : zoneFromUrl(services.config.sandbox.publicUrl);
    const sandboxId = sandboxIdFromToken(services.config.connectToken);

    return {
        list: i.list.handler(async () => {
            const discovered = await discoverPanels(services.workspace);
            const panels = await Promise.all(
                discovered.map(async ({ repo, hasPanel }) => {
                    const port = services.panelProcesses.portOf(repo);
                    const url = previewUrl(repo, zone, sandboxId);
                    const dir = join(services.workspace.repositories, repo);
                    // Content facts, computed in one pass so the browser never N+1-scans /work: each extension
                    // decides its own presence from this evidence (see the web app's extensions/extension.ts).
                    const summary = {
                        repo,
                        hasPanel,
                        running: port !== undefined,
                        healthy: port !== undefined && (await probePort(port)),
                        deployConfig: existsSync(join(dir, CONFIG_FILE)),
                        desiredState: existsSync(join(dir, ARTIFACT_FILE)),
                        directoryUi: existsSync(join(dir, ".intentic", "ui", "index.html")),
                        monorepo: existsSync(join(dir, "pnpm-workspace.yaml")) && existsSync(join(dir, "turbo.json")),
                        vitest:
                            existsSync(join(dir, "vitest.config.ts")) ||
                            mentionsVitest(join(dir, "pnpm-workspace.yaml")) ||
                            mentionsVitest(join(dir, "package.json")),
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
            const runDir = await panelRunDir(services.workspace, input.repo);
            if (runDir === undefined) {
                throw new ORPCError("BAD_REQUEST", { message: `${input.repo} has no runnable panel — add an operator/ dev server or a dev script` });
            }
            // Mint the preview route before the panel is observable as running (see preview-route.ts).
            await services.ensurePreviewRoute(input.repo);
            await services.panelProcesses.start(input.repo, {
                // Install deps on first start (async — the terminal + "starting" badge cover it), then run the dev
                // server; skipped once installed. No --ignore-workspace: an app repo IS its own pnpm monorepo (its
                // dev runs turbo across _apps/*) so the whole workspace must install; the flat operator/ panels
                // have no ancestor workspace, so it's a standalone install there either way.
                // ponytail: assumes NODE_ENV != "production" (dev tooling lives in devDependencies) — if a base
                // image ever pins it, inject NODE_ENV=development into the panel env below.
                // `&&` (left-assoc: `(test || install) && dev`) so a failed install stops with ITS error above
                // the prompt instead of burying it under the dev command's cascading failure. No `exec` — the
                // chain runs inside the pane's interactive shell (see panel-processes launch), which must
                // survive the command so Ctrl+C lands at a prompt and ↑ re-runs it.
                command: "test -d node_modules || pnpm install && pnpm dev",
                cwd: runDir,
                // The panel's backend calls the daemon with these (server-side, inside the sandbox) — no browser
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
            services.panelProcesses.stop(input.repo);
            return { ok: true } as const;
        }),
    };
};
