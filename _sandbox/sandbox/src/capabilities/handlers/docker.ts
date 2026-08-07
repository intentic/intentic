import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import type { CapabilityStatus, DockerConfig, IntenticLine } from "@intentic/sandbox-contract";
import { packFragment } from "../../environment/packs.js";
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

// The privilege half of the fragment — always present: baking this directive into the overlay is what records
// the owner's privilege grant (and what flips the derived environment state to "rebuild required"). The ENGINE
// half is the docker feature pack (packs/docker.Dockerfile), resolved per compose: nothing when the running
// base image bakes it (the standard image does), the install itself on a core image.
const DOCKER_DIRECTIVE = `# docker capability: this directive grants dockerd the privileges it needs
# (translated to a --privileged run by the allowlisted rebuild executors).
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

// Whether this entry asked for GPU passthrough. The config is the OWNER'S ASK, not a fact about the host — what
// actually happened to the ask is SANDBOX_GPU (see gpuState).
const gpuAsked = (config: unknown): boolean => (config as DockerConfig | undefined)?.gpu === "on";

/* ——— The ENGINE family: options dockerd reads, not the image ————————————————————————————————————————————
 *
 * These land in /etc/docker/daemon.json and take effect on a dockerd restart — seconds, no rebuild, no new
 * image. That is the whole reason they are a separate family from `gpu` (DockerConfigSchema explains the
 * split): asking someone to rebuild a container for a registry mirror would be charging five minutes for a
 * value the daemon re-reads every time it starts.
 *
 * MERGED into whatever is already in the file, never written over it. The GPU fragment's `nvidia-ctk runtime
 * configure` writes its `runtimes.nvidia` entry into this same file at BUILD time, so a wholesale write here
 * would silently un-register the nvidia runtime — turning the GPU option off from inside, with no diff and no
 * message, the first time somebody set a registry mirror. Owning exactly our keys is also what makes clearing
 * a field work: a key we no longer want is deleted rather than left behind to outlive the form. */
const DAEMON_JSON = "/etc/docker/daemon.json";

/* One CIDR → docker's `default-address-pools` entry. `size` is the prefix each container network gets carved
 * at, and 24 (254 usable addresses) is docker's own default shape; a pool declared smaller than that carves at
 * its own prefix instead, so a /26 yields one network rather than an impossible request. Undefined for
 * anything that isn't a CIDR — the form validates, but a manifest edited by hand must not take dockerd down. */
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

// Registries arrive as one field because people paste them as a list; commas and whitespace both separate.
const registryList = (value: string | undefined): string[] => (value ?? "").split(/[\s,]+/).filter((entry) => entry !== "");

/* The daemon.json this config wants, given what the file already holds. Pure, so the merge rules — ours win,
 * ours disappear when cleared, everything else is untouched — are testable without a docker daemon. */
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

// A daemon.json that is missing, empty or corrupt reads as {} — the merge then writes a clean file, which is
// the only useful response to any of the three.
const readDaemonJson = async (): Promise<Record<string, unknown>> => {
    const raw = await readFile(DAEMON_JSON, "utf8").catch(() => "");
    try {
        const parsed: unknown = JSON.parse(raw);
        return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
    } catch {
        return {};
    }
};

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

/* Bring /etc/docker/daemon.json in line with the engine options, and restart dockerd if that changed anything.
 * Returns what to tell the user, or undefined when the file already said what the config says — the ordinary
 * case on every apply that only touched the GPU switch, and the reason this compares instead of always
 * writing: restarting dockerd stops whatever the agent has running on it, which is far too rude to do on an
 * apply that changed nothing.
 *
 * Best-effort by design. dockerd not running yet (pre-rebuild, or mid-boot) is not a failure: the file is what
 * matters, and the next start reads it. */
const applyEngineSettings = async (ctx: CapabilityCtx, config: unknown): Promise<string | undefined> => {
    const current = await readDaemonJson();
    const next = withEngineSettings(current, config);
    if (JSON.stringify(next) === JSON.stringify(current)) {
        return undefined;
    }
    // node's writeFile, not ctx.files: that service is the WORKSPACE's, and /etc is not the workspace.
    await writeFile(DAEMON_JSON, `${JSON.stringify(next, null, 4)}\n`);
    if (!(await dockerUp())) {
        return "Engine settings saved — they apply when the Docker Engine starts.";
    }
    ctx.panels.stop(DOCKER_PANEL_KEY);
    return (await startDockerd(ctx))
        ? "Engine settings applied — the Docker Engine restarted, so anything it was running has stopped."
        : "Engine settings saved, but dockerd did not come back within 30s — check the panel-docker terminal.";
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

/* WHAT THE OPTIONS HAVE TO SAY, each naming itself. The engine's own state is a separate question, answered
 * separately below: an engine can be up with a GPU missing, and a card that says only "active" or only
 * "dockerd not running" leaves the user to find out which of the two they're in.
 *
 * A LIST rather than one answer, because options are independent and the honest report of two broken things
 * is two sentences. `status` picks the worst to put on its single line — but it prefixes the option's name, so
 * "which one" is answerable without opening anything. Every entry names its option first for that reason.
 *
 * "unsupported" is the state this whole design exists to make legible, and it is deliberately `error`, not
 * `pending`: pending renders as a spinner and a rebuild button, and no amount of rebuilding puts a GPU in a
 * machine that has none. */
const optionStatuses = async (config: unknown): Promise<CapabilityStatus[]> => {
    if (!gpuAsked(config)) {
        return [];
    }
    const state = gpuState();
    if (state === undefined) {
        return [{ state: "pending", detail: "GPU access: rebuild required" }];
    }
    if (state === "unsupported") {
        return [{ state: "error", detail: "GPU access: this host's Docker has no nvidia runtime — install nvidia-container-toolkit on it" }];
    }
    return (await gpuVisible()) ? [] : [{ state: "error", detail: "GPU access: passed through but no device answers — check the host's driver" }];
};

// An error outranks a pending: of two things to say on one line, the one that will never fix itself wins.
const worst = (statuses: readonly CapabilityStatus[]): CapabilityStatus | undefined =>
    statuses.find((status) => status.state === "error") ?? statuses[0];

// What an apply owes the user about the options, on EVERY path where the engine is up — including the one
// where it was already running, which is the ordinary path for someone who just changed a switch and whose
// only feedback would otherwise be "the Docker Engine is already running".
const reportOptions = async function* (config: unknown): AsyncGenerator<IntenticLine> {
    for (const status of await optionStatuses(config)) {
        yield { kind: "log", message: `${status.detail}.` };
    }
};

export const dockerHandler: CapabilityHandler = {
    // The ASKS, not their outcomes — a summary field is what the browser may see of the config, and what
    // became of an ask belongs in `optionStatuses`. The engine options echo as present/absent rather than by
    // value: nothing here is a secret, but a card that re-opens knowing WHICH fields are set is all the
    // instance strip needs, and the form re-reads the values from the manifest anyway.
    echo: (config) => {
        const docker = config as DockerConfig | undefined;
        return {
            gpu: gpuAsked(config),
            registryMirror: docker?.registryMirror ?? "",
            insecureRegistries: docker?.insecureRegistries ?? "",
            addressPool: docker?.addressPool ?? "",
        };
    },
    // ONLY the image family may be read here: a fragment is the thing whose hash decides whether the owner is
    // asked to rebuild, so an engine option leaking into it would charge a rebuild for a value dockerd rereads
    // on restart (DockerConfigSchema makes the argument).
    fragment: async (config) => {
        const engine = await packFragment("docker");
        const directive = gpuAsked(config) ? `${DOCKER_DIRECTIVE}\n${GPU_FRAGMENT}` : DOCKER_DIRECTIVE;
        return engine === undefined ? directive : `${engine}\n${directive}`;
    },
    apply: async function* (ctx, id, config) {
        if (await cliMissing()) {
            // Two worlds have no docker CLI: a bare dev run (nothing to do — the engine exists in a real
            // sandbox) and a core image (the docker pack rides the overlay — same rebuild that grants the
            // privilege). /opt/sandbox is the in-image sentinel: only the baked daemon tree lives there.
            yield existsSync("/opt/sandbox")
                ? {
                      kind: "log" as const,
                      message: `Stored ${id} — this image doesn't carry the Docker Engine yet. Rebuild the sandbox from the Environment card; the engine installs and starts with the rebuild.`,
                  }
                : { kind: "log" as const, message: `Stored ${id} — no docker CLI in this dev run; the engine starts in a real sandbox container.` };
            return;
        }
        if (await dockerUp()) {
            yield { kind: "log", message: "The Docker Engine is already running." };
            // Before the option report, because this is the branch that can CHANGE what the options say.
            const engine = await applyEngineSettings(ctx, config);
            if (engine !== undefined) {
                yield { kind: "log", message: engine };
            }
            yield* reportOptions(config);
            return;
        }
        // Pre-rebuild bootstrap: the add must still land in the manifest (that's what puts the directive into
        // the overlay), so an unprivileged container is a soft outcome, not a failure. The engine settings are
        // still written — the file outlives this container, and the dockerd that eventually starts reads it.
        if (!(await privileged())) {
            await applyEngineSettings(ctx, config);
            yield {
                kind: "log",
                message: `Stored ${id} — this sandbox isn't running privileged yet. Rebuild it from the Environment card; the Docker Engine starts automatically when it restarts.`,
            };
            return;
        }
        await applyEngineSettings(ctx, config);
        yield { kind: "log", message: "Starting the Docker Engine (its output is in the panel-docker terminal)…" };
        if (await startDockerd(ctx)) {
            yield { kind: "log", message: "Docker Engine up — docker and docker compose now work in the workspace." };
            yield* reportOptions(config);
            return;
        }
        yield { kind: "log", message: "dockerd did not become ready within 30s — check the panel-docker terminal." };
    },
    // The engine's own state first — an option caveat on a card that reads "active" is a caveat; on one that
    // reads "dockerd not running" it is noise in front of the thing actually broken.
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
