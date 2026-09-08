import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { pollUntil } from "@intentic/base/async";
import type { CapabilityStatus, DockerConfig, IntenticLine } from "@intentic/sandbox-contract";
import { packFragment } from "../../environment/packs.js";
import type { CapabilityCtx, CapabilityHandler } from "../capability.js";

// In-sandbox Docker Engine, dormant and unprivileged until this capability is added. Its fragment is a single
// `--privileged` runtime directive; `apply` starts dockerd as the panel-docker session once privileged, restored on
// boot. No remove: de-privileging live engine state is too destructive to do silently.

const exec = promisify(execFile);

// Panel key for the dockerd session; must match what main.ts's boot adopt uses.
export const DOCKER_PANEL_KEY = "docker";

// Always present; the engine half is the docker pack, composed only when the base image lacks it.
const DOCKER_DIRECTIVE = `# docker capability: this directive grants dockerd the privileges it needs
# (translated to a --privileged run by the allowlisted rebuild executors).
# intentic:runtime --privileged`;

// Writes daemon.json's nvidia runtime at build time; boot restore starts dockerd without running apply.
const GPU_FRAGMENT = `# docker capability, gpu option: the host's NVIDIA GPUs, passed through to the nested engine.
# The toolkit registers the nvidia runtime with the dockerd that runs INSIDE this container: the outer
# --gpus below only gets the devices as far as this container's own /dev.
RUN install -m 0755 -d /etc/apt/keyrings \\
    && curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey -o /etc/apt/keyrings/nvidia-container-toolkit.asc \\
    && chmod a+r /etc/apt/keyrings/nvidia-container-toolkit.asc \\
    && curl -fsSL https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list \\
        | sed 's#deb https://#deb [signed-by=/etc/apt/keyrings/nvidia-container-toolkit.asc] https://#g' \\
        > /etc/apt/sources.list.d/nvidia-container-toolkit.list \\
    && apt-get update && apt-get install -y --no-install-recommends nvidia-container-toolkit \\
    && rm -rf /var/lib/apt/lists/*
RUN nvidia-ctk runtime configure --runtime=docker
# intentic:runtime --gpus=all`;

// The owner's ask, not a fact about the host; what actually happened is SANDBOX_GPU (gpuState).
const gpuAsked = (config: unknown): boolean => (config as DockerConfig | undefined)?.gpu === "on";

// Where engine options (mirrors, pools) live; dockerd re-reads this on restart, no rebuild needed.
const DAEMON_JSON = "/etc/docker/daemon.json";

// Parses one CIDR into docker's `default-address-pools` shape; carves at /24 (docker's default) unless the pool itself
// is smaller. Undefined for anything that isn't a valid CIDR, so a hand-edited manifest can't take dockerd down.
export const addressPoolOf = (cidr: string | undefined): { base: string; size: number } | undefined => {
    const match = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec((cidr ?? "").trim());
    if (match?.[1] === undefined || match[2] === undefined) {
        return undefined;
    }
    const prefix = Number(match[2]);
    if (prefix < 8 || prefix > 30 || match[1].split(".").some((octet) => Number(octet) > 255)) {
        return undefined;
    }
    return { base: `${match[1]}/${prefix}`, size: Math.max(prefix, 24) };
};

// One field split into entries: commas and whitespace both separate, since people paste this as a list.
const registryList = (value: string | undefined): string[] => (value ?? "").split(/[\s,]+/).filter((entry) => entry !== "");

// Pure merge: config's fields overwrite, a cleared field deletes its key, everything else (including the GPU option's
// runtimes.nvidia, written at build time) is left alone.
export const withEngineSettings = (current: Record<string, unknown>, config: unknown): Record<string, unknown> => {
    const docker = config as DockerConfig | undefined;
    const next = { ...current };
    const insecure = registryList(docker?.insecureRegistries);
    const pool = addressPoolOf(docker?.addressPool);
    const settings: Record<string, unknown> = {
        "registry-mirrors": docker?.registryMirror === undefined || docker.registryMirror === "" ? undefined : [docker.registryMirror],
        "insecure-registries": insecure.length === 0 ? undefined : insecure,
        "default-address-pools": pool === undefined ? undefined : [pool],
    };
    for (const [key, value] of Object.entries(settings)) {
        if (value === undefined) {
            delete next[key];
            continue;
        }
        next[key] = value;
    }
    return next;
};

// Missing, empty or corrupt all read as {}; the merge then writes back a clean file, the only useful response to any of
// the three.
const readDaemonJson = async (): Promise<Record<string, unknown>> => {
    const raw = await readFile(DAEMON_JSON, "utf8").catch(() => "");
    try {
        const parsed: unknown = JSON.parse(raw);
        return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
    } catch {
        return {};
    }
};

// `docker info` succeeds only when dockerd is up and answering requests.
const dockerUp = async (): Promise<boolean> =>
    exec("docker", ["info"]).then(
        () => true,
        () => false,
    );

// A bare dev run (`tsx watch` outside the image) may carry no docker CLI, a soft outcome, not an error.
const cliMissing = async (): Promise<boolean> =>
    exec("docker", ["--version"]).then(
        () => false,
        (error) => (error as NodeJS.ErrnoException).code === "ENOENT",
    );

// Bit 16 (CAP_SYS_MODULE) is the sentinel: only --privileged grants it, unlike SYS_ADMIN/SYS_PTRACE which every sandbox
// already has. Hosted VM root holds the full set, so this correctly reads true with no directive.
export const isPrivileged = (procStatus: string): boolean => {
    const hex = /^CapEff:\s*([0-9a-fA-F]+)$/m.exec(procStatus)?.[1];
    return hex !== undefined && (BigInt(`0x${hex}`) & (1n << 16n)) !== 0n;
};
const privileged = async (): Promise<boolean> => isPrivileged(await readFile("/proc/self/status", "utf8").catch(() => ""));

// Starts dockerd as the panel-docker session and waits for it to answer; false on timeout (output stays in the panel
// terminal either way).
const startDockerd = async (ctx: CapabilityCtx): Promise<boolean> => {
    await ctx.panels.start(DOCKER_PANEL_KEY, { command: "dockerd", cwd: ctx.workspace.root });
    if (await pollUntil(dockerUp, { intervalMs: 1_000, timeoutMs: 30_000 })) {
        ctx.logger.info("docker: daemon started");
        return true;
    }
    ctx.logger.warn("docker: dockerd did not become ready within 30s, its output is in the panel-docker terminal");
    return false;
};

// Syncs daemon.json to the engine options and restarts dockerd only if that changed something (restarting stops
// whatever's running on it). Best-effort: dockerd not running yet is not a failure, the next start reads the file.
const applyEngineSettings = async (ctx: CapabilityCtx, config: unknown): Promise<string | undefined> => {
    const current = await readDaemonJson();
    const next = withEngineSettings(current, config);
    if (JSON.stringify(next) === JSON.stringify(current)) {
        return undefined;
    }
    // node's writeFile, not ctx.files: that service is scoped to the workspace, and /etc isn't in it.
    await writeFile(DAEMON_JSON, `${JSON.stringify(next, null, 4)}\n`);
    if (!(await dockerUp())) {
        return "Engine settings saved: they apply when the Docker Engine starts.";
    }
    ctx.panels.stop(DOCKER_PANEL_KEY);
    return (await startDockerd(ctx))
        ? "Engine settings applied: the Docker Engine restarted, so anything it was running has stopped."
        : "Engine settings saved, but dockerd did not come back within 30s, check the panel-docker terminal.";
};

// SANDBOX_GPU, the runner's answer to the ask, read fresh each call so tests need not fight module order:
//   undefined the container predates the ask (not rebuilt yet)
//   "all" the flag rode; devices should be present
//   "unsupported" host docker has no nvidia runtime; no rebuild fixes it
const gpuState = (): string | undefined => process.env["SANDBOX_GPU"];

// `nvidia-smi -L` lists the GPUs the toolkit injects; it fails exactly when passthrough didn't really happen (a host
// driver/toolkit mismatch, the case every earlier check missed).
const gpuVisible = async (): Promise<boolean> =>
    exec("nvidia-smi", ["-L"]).then(
        () => true,
        () => false,
    );

// Per-option status, separate from the engine's own state (up, but a GPU may still be missing). A list, since each
// option names itself; `unsupported` is `error`, not `pending`: no rebuild adds a missing GPU.
const optionStatuses = async (config: unknown): Promise<CapabilityStatus[]> => {
    if (!gpuAsked(config)) {
        return [];
    }
    const state = gpuState();
    if (state === undefined) {
        return [{ state: "pending", detail: "GPU access: rebuild required" }];
    }
    if (state === "unsupported") {
        return [{ state: "error", detail: "GPU access: this host's Docker has no nvidia runtime, install nvidia-container-toolkit on it" }];
    }
    return (await gpuVisible()) ? [] : [{ state: "error", detail: "GPU access: passed through but no device answers, check the host's driver" }];
};

// Error beats pending: only one fact fits on the status line.
const worst = (statuses: readonly CapabilityStatus[]): CapabilityStatus | undefined =>
    statuses.find((status) => status.state === "error") ?? statuses[0];

// Reports each option's status on every path where the engine is up, including one already running, so a switch flip
// gets feedback beyond "already running".
const reportOptions = async function* (config: unknown): AsyncGenerator<IntenticLine> {
    for (const status of await optionStatuses(config)) {
        yield { kind: "log", message: `${status.detail}.` };
    }
};

export const dockerHandler: CapabilityHandler = {
    rename: { refuse: "Docker is part of the sandbox itself, not a connection you name." },
    // Echoes the asks, not their outcomes (those are `optionStatuses`). Engine options echo present/absent, not their
    // value: nothing here is secret, but the form re-reads values from the manifest anyway.
    echo: (config) => {
        const docker = config as DockerConfig | undefined;
        return {
            gpu: gpuAsked(config),
            registryMirror: docker?.registryMirror ?? "",
            insecureRegistries: docker?.insecureRegistries ?? "",
            addressPool: docker?.addressPool ?? "",
        };
    },
    // Only the image family belongs here: the fragment's hash decides whether a rebuild is asked for, and an engine
    // option leaking in would charge one for a value dockerd rereads live.
    fragment: async (config) => {
        const engine = await packFragment("docker");
        const directive = gpuAsked(config) ? `${DOCKER_DIRECTIVE}\n${GPU_FRAGMENT}` : DOCKER_DIRECTIVE;
        return engine === undefined ? directive : `${engine}\n${directive}`;
    },
    async *apply(ctx, id, config) {
        if (await cliMissing()) {
            // /opt/sandbox exists only in a real image, telling a dev run from a core image awaiting rebuild.
            yield existsSync("/opt/sandbox")
                ? {
                      kind: "log" as const,
                      message: `Stored ${id}, this image doesn't carry the Docker Engine yet. Rebuild the sandbox from the Environment card; the engine installs and starts with the rebuild.`,
                  }
                : { kind: "log" as const, message: `Stored ${id}, no docker CLI in this dev run; the engine starts in a real sandbox container.` };
            return;
        }
        if (await dockerUp()) {
            yield { kind: "log", message: "The Docker Engine is already running." };
            // Runs before the option report: this branch is the one that can change what the options say.
            const engine = await applyEngineSettings(ctx, config);
            if (engine !== undefined) {
                yield { kind: "log", message: engine };
            }
            yield* reportOptions(config);
            return;
        }
        // Unprivileged is a soft outcome: the add still lands in the manifest, and the file outlives this container.
        if (!(await privileged())) {
            await applyEngineSettings(ctx, config);
            yield {
                kind: "log",
                message: `Stored ${id}, this sandbox isn't running privileged yet. Rebuild it from the Environment card; the Docker Engine starts automatically when it restarts.`,
            };
            return;
        }
        await applyEngineSettings(ctx, config);
        yield { kind: "log", message: "Starting the Docker Engine (its output is in the panel-docker terminal)…" };
        if (await startDockerd(ctx)) {
            yield { kind: "log", message: "Docker Engine up, docker and docker compose now work in the workspace." };
            yield* reportOptions(config);
            return;
        }
        yield { kind: "log", message: "dockerd did not become ready within 30s, check the panel-docker terminal." };
    },
    // Engine state first: an option caveat matters on a card that reads active, but is noise in front of one that reads
    // dockerd not running.
    status: async (ctx, _id, config) => {
        if (await dockerUp()) {
            return worst(await optionStatuses(config)) ?? { state: "active" };
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

// Boot restore: dockerd dies with the container while the manifest survives on /work; restarts it if a docker
// capability is enabled. Best-effort: a failure lands in the panel-docker terminal and daemon log, never the boot path.
export const startDockerdIfEnabled = async (ctx: CapabilityCtx): Promise<void> => {
    if (!(await ctx.capabilities.list()).some((capability) => capability.kind === "docker")) {
        return;
    }
    if ((await cliMissing()) || (await dockerUp())) {
        return;
    }
    if (!(await privileged())) {
        ctx.logger.warn("docker: capability enabled but the container is not privileged, rebuild from the Environment card");
        return;
    }
    await startDockerd(ctx);
};
