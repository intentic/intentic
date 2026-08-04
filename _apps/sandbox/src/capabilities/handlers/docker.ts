import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import type { CapabilityStatus, DockerConfig, IntenticLine } from "@intentic/sandbox-contract";
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

/* The GPU option's half of the fragment (config.gpu === "on"). Two layers have to line up for `docker run
 * --gpus` to work INSIDE this container, and neither implies the other:
 *   - the outer run needs --gpus=all, which is what the directive line asks the rebuild executors for. That
 *     injects the host's driver libraries and /dev/nvidia* into this container.
 *   - the NESTED dockerd needs its own nvidia runtime registered, which is what the toolkit + `nvidia-ctk
 *     runtime configure` below does. Without it the agent's `docker compose up` on a GPU stack fails with
 *     `could not select device driver "nvidia"` inside a container that can see the GPU perfectly well.
 * The second is the one nobody expects, because on an ordinary machine installing the toolkit is the whole job.
 *
 * nvidia-ctk writes /etc/docker/daemon.json at BUILD time rather than the handler doing it at apply time: the
 * file has to be there before dockerd starts, and boot restore starts dockerd without going through apply. */
const GPU_FRAGMENT = `# docker capability, gpu option: the host's NVIDIA GPUs, passed through to the nested engine.
# The toolkit registers the nvidia runtime with the dockerd that runs INSIDE this container — the outer
# --gpus below only gets the devices as far as this container's own /dev.
RUN curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg \\
    && curl -fsSL https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list \\
        | sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' \\
        > /etc/apt/sources.list.d/nvidia-container-toolkit.list \\
    && apt-get update && apt-get install -y --no-install-recommends nvidia-container-toolkit \\
    && rm -rf /var/lib/apt/lists/*
RUN nvidia-ctk runtime configure --runtime=docker
# intentic:runtime --gpus=all`;

// Whether this entry asked for GPU passthrough. The config is the OWNER'S ASK, not a fact about the host — what
// actually happened to the ask is SANDBOX_GPU (see gpuState).
const gpuAsked = (config: unknown): boolean => (config as DockerConfig | undefined)?.gpu === "on";

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

/* WHAT BECAME OF THE GPU ASK — the runner's answer, stamped as SANDBOX_GPU by the run contract, because from
 * in here the three outcomes are one missing device:
 *   undefined     the running container predates the ask — the overlay carrying it hasn't been built yet.
 *   "all"         the flag rode; the devices should be here.
 *   "unsupported" the host's docker has no nvidia runtime, so the flag was dropped and the sandbox started
 *                 without it. Nothing a rebuild fixes — the fix is on the host, or on another host.
 * Read per call rather than cached at import: nothing else in this handler pretends a container's env can
 * change, but a test setting it and a status probe reading it should not need to agree about module order. */
const gpuState = (): string | undefined => process.env["SANDBOX_GPU"];

// Do the GPUs actually answer? `nvidia-smi -L` lists them and is what the toolkit injects alongside the
// devices, so it fails exactly when the passthrough didn't really happen — a driver/toolkit version mismatch
// on the host being the case that survives every check before this one.
const gpuVisible = async (): Promise<boolean> =>
    exec("nvidia-smi", ["-L"]).then(
        () => true,
        () => false,
    );

/* The GPU option's contribution to the capability's status, or undefined when it has nothing to say. Split out
 * because it answers a different question from the engine's own state and the two are independent: an engine
 * can be up with a GPU missing, and the honest card has to say which of the two is wrong.
 *
 * "unsupported" is the state this whole option exists to make legible, and it is deliberately `error`, not
 * `pending`: pending renders as a spinner and a rebuild button, and no amount of rebuilding puts a GPU in a
 * machine that has none. */
const gpuStatus = async (config: unknown): Promise<CapabilityStatus | undefined> => {
    if (!gpuAsked(config)) {
        return undefined;
    }
    const state = gpuState();
    if (state === undefined) {
        return { state: "pending", detail: "rebuild required for GPU access" };
    }
    if (state === "unsupported") {
        return { state: "error", detail: "this host's Docker has no nvidia runtime — install nvidia-container-toolkit on it" };
    }
    return (await gpuVisible()) ? undefined : { state: "error", detail: "GPU passed through but no device answers — check the host's driver" };
};

// The GPU sentence an apply owes the user, on EVERY path where the engine is up — including the one where the
// engine was already running, which is the ordinary path for someone who just turned the switch on and whose
// only feedback would otherwise be "the Docker Engine is already running".
const reportGpu = async function* (config: unknown): AsyncGenerator<IntenticLine> {
    const gpu = await gpuStatus(config);
    if (gpu !== undefined) {
        yield { kind: "log", message: `GPU access: ${gpu.detail}.` };
    }
};

export const dockerHandler: CapabilityHandler = {
    // The ask, not the outcome — a summary field is what the browser may see of the config, and `gpuStatus`
    // is where what became of it belongs.
    echo: (config) => ({ gpu: gpuAsked(config) }),
    fragment: (config) => (gpuAsked(config) ? `${DOCKER_FRAGMENT}\n${GPU_FRAGMENT}` : DOCKER_FRAGMENT),
    apply: async function* (ctx, id, config) {
        if (await cliMissing()) {
            yield { kind: "log", message: `Stored ${id} — no docker CLI in this dev run; the engine starts in a real sandbox container.` };
            return;
        }
        if (await dockerUp()) {
            yield { kind: "log", message: "The Docker Engine is already running." };
            yield* reportGpu(config);
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
            yield* reportGpu(config);
            return;
        }
        yield { kind: "log", message: "dockerd did not become ready within 30s — check the panel-docker terminal." };
    },
    // The engine's own state first — a GPU caveat on a card that reads "active" is a caveat; on one that reads
    // "dockerd not running" it is noise in front of the thing actually broken.
    status: async (ctx, _id, config) => {
        if (await dockerUp()) {
            return (await gpuStatus(config)) ?? { state: "active" };
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
