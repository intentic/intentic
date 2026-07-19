import { execFile } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import type { Services } from "../composition.js";

// Docker is part of the base sandbox: the image bakes Docker Engine + Compose and every runner starts the
// container --privileged, so a full-stack app's `pnpm db:up` runs its dev Postgres exactly like a local dev
// machine. dockerd runs as a persistent, watchable panel-docker tmux session — its startup output is the
// terminals panel's, not a detached void; main.ts re-adopts a live one across daemon restarts (the tmux server
// outlives the daemon) and calls startDockerd once at boot. The daemon runs as root, so no sudo is involved.

const exec = promisify(execFile);

// The panel key behind the visible dockerd session (panel-docker) — shared with main.ts's boot adopt/start.
export const DOCKER_PANEL_KEY = "docker";

// `docker info` succeeds only when dockerd is up and answering.
const dockerUp = async (): Promise<boolean> =>
    exec("docker", ["info"]).then(
        () => true,
        () => false,
    );

// Best-effort boot start — a failure lands in the log and the panel-docker terminal, never takes the daemon
// down. A bare dev run (`tsx watch` outside the image) carries no docker CLI: skip silently.
export const startDockerd = async (services: Services): Promise<void> => {
    const missing = await exec("docker", ["--version"]).then(
        () => false,
        (error) => (error as NodeJS.ErrnoException).code === "ENOENT",
    );
    if (missing || (await dockerUp())) {
        return;
    }
    await services.processes.start(DOCKER_PANEL_KEY, { command: "dockerd", cwd: services.workspace.root });
    for (let attempt = 0; attempt < 30; attempt++) {
        await delay(1000);
        if (await dockerUp()) {
            services.logger.info("docker: daemon started");
            return;
        }
    }
    services.logger.warn("docker: dockerd did not become ready within 30s — its output is in the panel-docker terminal");
};
