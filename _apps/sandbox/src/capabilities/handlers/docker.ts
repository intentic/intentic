import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import type { CapabilityCtx, CapabilityHandler } from "../capability.js";

// The in-sandbox Docker Engine. The base image bakes Docker + Compose, but the engine stays dormant — and the
// container unprivileged — until this capability is added: its fragment is a single `--privileged` runtime
// directive the rebuild executors translate into the docker run flag (allowlisted there — see recreate.sh / the
// workspace provider), and dockerd runs as the visible panel-docker tmux session, started by `apply` once the
// container is privileged and restored on boot (startDockerdIfEnabled). The HOST's Docker socket is never
// mounted, so the agent's containers live inside this nested engine. No remove — deliberately: the engine's
// state (/var/lib/docker) and whatever runs on it make a silent de-privilege more destructive than useful.
// The daemon runs as root, so no sudo is involved.

const exec = promisify(execFile);

// The panel key behind the visible dockerd session (panel-docker) — shared with main.ts's boot adopt.
export const DOCKER_PANEL_KEY = "docker";

// The engine is baked into the base image — this directive IS the fragment; baking it into the overlay is what
// records the owner's privilege grant (and what flips the derived environment state to "rebuild required").
const DOCKER_FRAGMENT = `# docker capability: the engine is baked into the base image — this directive alone grants dockerd
# the privileges it needs (translated to a --privileged run by the allowlisted rebuild executors).
# intentic:runtime --privileged`;

// `docker info` succeeds only when dockerd is up and answering.
const dockerUp = async (): Promise<boolean> =>
    exec("docker", ["info"]).then(
        () => true,
        () => false,
    );

// A bare dev run (`tsx watch` outside the image) may carry no docker CLI — a soft outcome, not an error.
const cliMissing = async (): Promise<boolean> =>
    exec("docker", ["--version"]).then(
        () => false,
        (error) => (error as NodeJS.ErrnoException).code === "ENOENT",
    );

// Was this container run --privileged? CAP_SYS_MODULE is the sentinel, because --privileged is the only thing
// that grants it: SANDBOX_CAPABILITIES gives EVERY sandbox SYS_ADMIN + SYS_PTRACE (turn isolation needs its own
// mount namespace), and the only other runtime directive an overlay may carry is the vpn's NET_ADMIN.
//
// Reading SYS_ADMIN instead — which this probe did until it was measured — is true in every sandbox, privileged
// or not. So "rebuild required" was unreachable: an unprivileged sandbox with the capability added reported
// `error: dockerd not running`, and apply() spent 30s waiting on a dockerd that had already died. Unprivileged,
// dockerd gets as far as the network controller and then fails on the three things only --privileged supplies:
// a writable /sys/fs/cgroup, NET_ADMIN for the bridge + iptables, and seccomp relief for runc's keyctl.
// Bit 16 = CAP_SYS_MODULE.
export const isPrivileged = (procStatus: string): boolean => {
    const hex = /^CapEff:\s*([0-9a-fA-F]+)$/m.exec(procStatus)?.[1];
    return hex !== undefined && (BigInt(`0x${hex}`) & (1n << 16n)) !== 0n;
};
const privileged = async (): Promise<boolean> => isPrivileged(await readFile("/proc/self/status", "utf8").catch(() => ""));

// Start dockerd as the persistent panel-docker session and wait for it to answer. False on timeout — the
// startup output stays in the panel's terminal either way.
const startDockerd = async (ctx: CapabilityCtx): Promise<boolean> => {
    await ctx.panels.start(DOCKER_PANEL_KEY, { command: "dockerd", cwd: ctx.workspace.root });
    for (let attempt = 0; attempt < 30; attempt++) {
        await delay(1000);
        if (await dockerUp()) {
            ctx.logger.info("docker: daemon started");
            return true;
        }
    }
    ctx.logger.warn("docker: dockerd did not become ready within 30s — its output is in the panel-docker terminal");
    return false;
};

export const dockerHandler: CapabilityHandler = {
    fragment: () => DOCKER_FRAGMENT,
    apply: async function* (ctx, id) {
        if (await cliMissing()) {
            yield { kind: "log", message: `Stored ${id} — no docker CLI in this dev run; the engine starts in a real sandbox container.` };
            return;
        }
        if (await dockerUp()) {
            yield { kind: "log", message: "The Docker Engine is already running." };
            return;
        }
        // Pre-rebuild bootstrap: the add must still land in the manifest (that's what puts the directive into
        // the overlay), so an unprivileged container is a soft outcome, not a failure.
        if (!(await privileged())) {
            yield {
                kind: "log",
                message: `Stored ${id} — this sandbox isn't running privileged yet. Rebuild it from the Environment card; the Docker Engine starts automatically when it restarts.`,
            };
            return;
        }
        yield { kind: "log", message: "Starting the Docker Engine (its output is in the panel-docker terminal)…" };
        if (await startDockerd(ctx)) {
            yield { kind: "log", message: "Docker Engine up — docker and docker compose now work in the workspace." };
            return;
        }
        yield { kind: "log", message: "dockerd did not become ready within 30s — check the panel-docker terminal." };
    },
    status: async (ctx) => {
        if (await dockerUp()) {
            return { state: "active" };
        }
        if (!(await privileged())) {
            return { state: "pending", detail: "rebuild required" };
        }
        if (ctx.panels.running(DOCKER_PANEL_KEY)) {
            return { state: "pending", detail: "starting" };
        }
        return { state: "error", detail: "dockerd not running" };
    },
};

// Boot restore (beside reconnectVpns): dockerd dies with the container while the manifest survives on /work —
// bring it back when a docker capability is enabled. Best-effort: a failure lands in the panel-docker terminal
// and the daemon log, never the boot path.
export const startDockerdIfEnabled = async (ctx: CapabilityCtx): Promise<void> => {
    if (!(await ctx.capabilities.list()).some((capability) => capability.kind === "docker")) {
        return;
    }
    if ((await cliMissing()) || (await dockerUp())) {
        return;
    }
    if (!(await privileged())) {
        ctx.logger.warn("docker: capability enabled but the container is not privileged — rebuild from the Environment card");
        return;
    }
    await startDockerd(ctx);
};
