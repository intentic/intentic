import { forkedExec } from "@intentic/base/git";
import type { Logger } from "pino";
// Type only: a value import from system/ would close a cycle between the subsystems (daemon-boundaries).
import { type Chore, DAY_MS } from "../../system/chore-clock.js";
import { DOCKER_PANEL_KEY } from "../../ports/panel-keys.js";

// THE AGENTS' DOCKER, KEPT FROM GROWING WITHOUT END (2026-10-05). Nothing removed what the nested engine accumulates:
// every stopped container an agent left and every image a rebuild replaced stays in its data root (13 GB on one
// sandbox). Daily, while no turn runs and only while the dockerd this daemon started (or adopted at boot) is running,
// stopped containers older than a day and dangling images older than three days are pruned, as docker's own prune
// decides; a tagged image is never touched (no `--all`), nor a volume, a network or the build cache. Never starts
// dockerd to prune: an engine that is not running holds nothing that grows.

// The engine the docker capability starts (`dockerd` with no `-H`, docker.handler.ts) listens here. Named rather than
// inherited, so an agent's DOCKER_HOST or docker context can never point a prune at some other engine.
export const AGENTS_DOCKER_HOST = "unix:///var/run/docker.sock";

// A prune walks every container or image; generous, and still bounded.
const PRUNE_TIMEOUT_MS = 10 * 60_000;

export const DOCKER_PRUNES: readonly { readonly what: "containers" | "images"; readonly args: readonly string[] }[] = [
    { what: "containers", args: ["container", "prune", "--force", "--filter", "until=24h"] },
    // Dangling only: without `--all` an image some tag still names is never a candidate.
    { what: "images", args: ["image", "prune", "--force", "--filter", "until=72h"] },
];

// Whether now is a time to prune: no turn mid-flight (a prune contends with an agent's own docker work), and the
// agents' dockerd running under this daemon.
export const shouldPruneDocker = (liveTurns: number, dockerdRunning: boolean): boolean => liveTurns === 0 && dockerdRunning;

// docker's own summary line, `Total reclaimed space: 1.2GB`, as it says it; undefined when it printed none.
export const reclaimedSpace = (stdout: string): string | undefined => /^Total reclaimed space:\s*(\S.*?)\s*$/mu.exec(stdout)?.[1];

export interface DockerPruneDeps {
    // services.processes: whether the dockerd session (DOCKER_PANEL_KEY) is running, started or adopted at boot.
    readonly processes: { readonly running: (key: string) => boolean };
    readonly conversations: { readonly liveSessionIds: () => readonly string[] };
    readonly logger: Pick<Logger, "info" | "warn">;
    readonly exec?: (
        command: string,
        args: readonly string[],
        options: { readonly timeout: number; readonly env: Readonly<Record<string, string>> },
    ) => Promise<{ readonly stdout: string }>;
}

// Daily, held back while turns run or the engine is down; container-scoped, since the engine is the container's.
export const dockerPruneChore = (deps: DockerPruneDeps): Chore => ({
    name: "docker-prune",
    everyMs: DAY_MS,
    when: () => shouldPruneDocker(deps.conversations.liveSessionIds().length, deps.processes.running(DOCKER_PANEL_KEY)),
    run: async () => {
        const exec = deps.exec ?? forkedExec;
        for (const prune of DOCKER_PRUNES) {
            try {
                const { stdout } = await exec("docker", prune.args, { timeout: PRUNE_TIMEOUT_MS, env: { DOCKER_HOST: AGENTS_DOCKER_HOST } });
                deps.logger.info(
                    { what: prune.what, reclaimed: reclaimedSpace(stdout) ?? "0B" },
                    "docker: pruned what the agents' engine no longer uses",
                );
            } catch (error) {
                deps.logger.warn({ err: error, what: prune.what }, "docker: prune failed, the next one tries again");
            }
        }
    },
});
