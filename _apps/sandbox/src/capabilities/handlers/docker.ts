import { execFile } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import type { DockerConfig } from "@intentic/sandbox-contract";
import { panelSession } from "../../panels/panel-processes.js";
import type { CapabilityCtx, CapabilityHandler } from "../capability.js";

// A Docker capability: an in-sandbox Docker Engine + Compose so a full-stack app's `pnpm db:up` runs a dev
// Postgres exactly like a local dev machine. Docker needs a privileged runtime, so — like the vpn capability —
// the tooling and the `--privileged` flag arrive via this capability's environment-overlay fragment + runtime
// directive, applied by an owner-run rebuild; until then the entry reports "pending". The daemon runs as root,
// so no sudo is involved. One docker capability per sandbox (there is a single Docker daemon), and dockerd
// runs as a persistent, watchable panel-docker tmux session — its startup output is the terminals panel's,
// not a detached void; main.ts re-adopts a live one across daemon restarts.

const exec = promisify(execFile);

// The panel key behind the visible dockerd session (panel-docker) — shared with main.ts's boot adopt/start.
export const DOCKER_PANEL_KEY = "docker";

// The composed-overlay fragment: Docker Engine + Compose v2 from Docker's apt repo, plus the runtime directive
// the rebuild executors translate into a docker run flag (allowlisted there — see rebuild.sh / the provider).
const DOCKER_FRAGMENT = `# docker capability: Docker Engine + Compose v2, so a full-stack app's \`pnpm db:up\` runs a dev Postgres in-sandbox.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl gnupg \\
    && install -m 0755 -d /etc/apt/keyrings \\
    && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \\
    && chmod a+r /etc/apt/keyrings/docker.asc \\
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian bookworm stable" > /etc/apt/sources.list.d/docker.list \\
    && apt-get update && apt-get install -y --no-install-recommends docker-ce docker-ce-cli containerd.io docker-compose-plugin \\
    && rm -rf /var/lib/apt/lists/*
# intentic:runtime --privileged`;

// ENOENT on spawn ⇒ docker isn't on PATH (the rebuild hasn't baked the tooling in yet).
const dockerMissing = async (): Promise<boolean> =>
    exec("docker", ["--version"]).then(
        () => false,
        (error) => (error as NodeJS.ErrnoException).code === "ENOENT",
    );
// `docker info` succeeds only when dockerd is up and answering.
const dockerUp = async (): Promise<boolean> =>
    exec("docker", ["info"]).then(
        () => true,
        () => false,
    );

// Start dockerd in its visible panel session (no-op when already answering) and wait for it to answer.
const startDaemon = async (ctx: CapabilityCtx): Promise<void> => {
    if (await dockerUp()) {
        return;
    }
    await ctx.panels.start(DOCKER_PANEL_KEY, { command: "dockerd", cwd: ctx.workspace.root });
    for (let attempt = 0; attempt < 30; attempt++) {
        await delay(1000);
        if (await dockerUp()) {
            return;
        }
    }
    throw new Error("dockerd did not become ready within 30s — its output is in the panel-docker terminal");
};

export const dockerHandler: CapabilityHandler = {
    fragment: () => DOCKER_FRAGMENT,
    apply: async function* (ctx, id, config) {
        if ((config as DockerConfig).enabled === "off") {
            // Switching off also stops a running daemon — "off" means off, not "stored but still running".
            ctx.panels.stop(DOCKER_PANEL_KEY);
            yield { kind: "log", message: `Docker ${id} stored, switched off. Re-add it enabled to start the daemon.` };
            return;
        }
        // Pre-rebuild bootstrap: the add must still land in the manifest (that's what puts the fragment +
        // --privileged into the overlay), so a missing docker is a soft outcome, not a failure.
        if (await dockerMissing()) {
            yield {
                kind: "log",
                message: `Stored ${id} — this sandbox doesn't carry Docker yet. Rebuild it from the Environment card; the daemon starts automatically when it restarts.`,
            };
            return;
        }
        yield { kind: "log", message: `Starting the Docker daemon…` };
        yield { kind: "terminal", session: panelSession(DOCKER_PANEL_KEY) };
        await startDaemon(ctx);
        yield { kind: "log", message: `Docker is up — \`pnpm db:up\` and \`docker compose\` now work in the workspace.` };
    },
    status: async (_ctx, _id, config) => {
        if (await dockerUp()) {
            return { state: "active" };
        }
        if (await dockerMissing()) {
            return { state: "pending", detail: "rebuild required" };
        }
        if ((config as DockerConfig).enabled !== "on") {
            return { state: "inactive" };
        }
        return { state: "error", detail: "docker daemon down" };
    },
};

// Boot start: dockerd dies with the container while the manifest survives on /work, so main.ts calls this once
// at startup (after the boot sweep adopted or cleared panel-docker) to bring the daemon back for an enabled
// docker capability. Best-effort — a failure lands in status, it never takes the sandbox daemon down.
export const startEnabledDocker = async (ctx: CapabilityCtx): Promise<void> => {
    const enabled = (await ctx.capabilities.list()).some((capability) => capability.kind === "docker" && capability.config.enabled === "on");
    if (!enabled || (await dockerMissing())) {
        return;
    }
    try {
        await startDaemon(ctx);
        ctx.logger.info("docker: daemon started");
    } catch (error) {
        ctx.logger.warn(`docker: could not start the daemon: ${error instanceof Error ? error.message : String(error)}`);
    }
};
