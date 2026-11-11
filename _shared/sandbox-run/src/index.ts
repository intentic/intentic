import { DAEMON_PORT, HISTORY_ROOT, LOCAL_PORT, WORKSPACE_ROOT } from "@intentic/constants";
import { shellQuote } from "./quote.js";
import { SANDBOX_SWAP_ENV } from "./replay.js";
import { SANDBOX_CONTAINER_PREFIX } from "./slug.js";

export { parseNulEnv, REPLAY_ENV, REPLAY_SECRET_ENV, REPLAY_VARS, replayableEnv, SANDBOX_SWAP_ENV } from "./replay.js";

// The sandbox container's run contract: every way a sandbox starts, composed from one definition instead of four
// hand-copied dialects. TS consumers import it (drift is a compile error); scripts that can't import execute `intentic
// sandbox run`'s printed command instead, so a stale script still runs a new image correctly.

// The in-network hostname the tunnel sidecar dials; every flow must derive it identically.
export const ORIGIN_HOST = "intentic-sandbox-workspace";

// SANDBOX_MANAGER's value on a container Docker Compose owns (the setup page's Compose file sets it). Such a sandbox
// updates the way any Compose service does, from the folder holding its file. Not in REPLAY_VARS: `ic` decides it from
// the container's own Compose labels instead, and a swap it makes of a Compose container (an environment rebuild) sets
// it again and hands the replacement back to Compose (_sandbox/ic/src/sandbox/compose.rs).
export const COMPOSE_MANAGER = "compose";
export const COMPOSE_UPDATE_COMMAND = "docker compose pull && docker compose up -d";

export interface SandboxNames {
    readonly container: string;
    readonly tunnelContainer: string;
    readonly workspaceVolume: string;
    readonly historyVolume: string;
    readonly dockerVolume: string;
    readonly network: string;
}

// The name and slug readers live in slug.ts, which the browser imports on its own; re-exported here for Node callers.
export { SANDBOX_CONTAINER_PREFIX, sandboxIdOfToken, sandboxSlugOf, slugOfDaemonUrl, slugOfHostname } from "./slug.js";
export const SANDBOX_TUNNEL_PREFIX = `${SANDBOX_CONTAINER_PREFIX}tunnel-`;

export const sandboxNames = (slug: string): SandboxNames => ({
    container: `${SANDBOX_CONTAINER_PREFIX}${slug}`,
    tunnelContainer: `${SANDBOX_TUNNEL_PREFIX}${slug}`,
    workspaceVolume: `intentic-workspace-${slug}`,
    historyVolume: `intentic-history-${slug}`,
    dockerVolume: `intentic-docker-${slug}`,
    network: `intentic-workspace-${slug}`,
});

// Where a dev sandbox's shared AI-provider logins are mounted, a mount and AGENT_AUTH_DIR together (`mounts` carries it).
export const AGENT_AUTH_ROOT = "/agent-auth";

// Where the daemon reads its at-rest key, and the variable naming that path (the daemon's at-rest.ts keyFromFile). `ic`
// mounts the key read-only there on every run line (at_rest.rs KEY_MOUNT, KEY_ENV, held to golden/at-rest.json); the
// Compose rendering mounts it from the host path it is given.
export const AT_REST_KEY_MOUNT = "/run/secrets/intentic-at-rest-key";
export const AT_REST_KEY_ENV = "INTENTIC_AT_REST_KEY_FILE";

// The registry digest of the base an image was built on, stamped on the container for the daemon. ic hands it to the
// run command as an env var on the probe rather than a flag: an older image's run command ignores an env var it does
// not know, where it would refuse an unknown flag, so a rollback onto one still runs.
export const BASE_DIGEST_ENV = "SANDBOX_BASE_DIGEST";

// A digest as docker prints one: what a runner's reading is held to before it is stamped.
export const baseDigestOf = (value: string | undefined): string | undefined => {
    const trimmed = value?.trim() ?? "";
    return /^sha256:[0-9a-f]{64}$/u.test(trimmed) ? trimmed : undefined;
};

// Where the sandbox's own Docker engine keeps its images, containers and their volumes.
export const DOCKER_ROOT = "/var/lib/docker";

// One named volume of a sandbox, and what each reader of the run contract needs to know about it.
export interface SandboxVolume {
    readonly destination: string;
    // Its name, as sandboxNames spells it for a slug.
    readonly volume: "workspaceVolume" | "historyVolume" | "dockerVolume";
    // What a compose file calls it in its `volumes:` table (the editor's setupCompose.ts).
    readonly composeKey: "work" | "history" | "docker-engine";
    // The state planner's flag (the daemon's state-plan.ts) for a volume holding files the daemon converts.
    readonly planner?: "--workspace" | "--history";
    // Why an environment bundle leaves the volume out, shown to the owner in the bundle's report. Absent for a volume
    // the bundle walks, file by file, through the contract's state tables.
    readonly unbundled?: string;
}

// Every named volume a sandbox runs on, in the order `docker run` mounts them: the one list of what a sandbox's
// storage is. A swap must carry each over unchanged (ic's storage.rs holds its copy to golden/volumes.json), the run
// line mounts each, and an environment bundle either walks one or says why it does not.
export const SANDBOX_VOLUMES: readonly SandboxVolume[] = [
    // Never optional: the owner's files and every repo's working tree.
    { destination: WORKSPACE_ROOT, volume: "workspaceVolume", composeKey: "work", planner: "--workspace" },
    // Never optional: holds the fleet registry, transcripts, every repo's git dir, the checkpoints.
    { destination: HISTORY_ROOT, volume: "historyVolume", composeKey: "history", planner: "--history" },
    {
        destination: DOCKER_ROOT,
        volume: "dockerVolume",
        composeKey: "docker-engine",
        unbundled:
            "The sandbox's own Docker engine (its images, containers and their volumes) does not travel. A database kept in a container volume is only there: dump it into the workspace before exporting, or recreate the containers in the target.",
    },
];

// Where a sandbox's stored data lives inside its container, and the state planner's flag for each (the daemon's
// state-plan.ts): every file the daemon converts is on one of these. The update pre-flight (ic, preflight.rs) mounts
// exactly these from the running container, read-only, and plans against them; its copy is held to this list by
// golden/data-mounts.json. `required: false` rides only where the container has it.
export const DATA_MOUNTS: readonly { readonly destination: string; readonly planner: string; readonly required: boolean }[] = [
    ...SANDBOX_VOLUMES.flatMap(({ destination, planner }) => (planner === undefined ? [] : [{ destination, planner, required: true }])),
    { destination: AGENT_AUTH_ROOT, planner: "--auth", required: false },
];

// Container-scoped capabilities every sandbox gets: SYS_ADMIN for mount namespaces, SYS_PTRACE for diagnosis.
export const SANDBOX_CAPABILITIES = ["SYS_ADMIN", "SYS_PTRACE"] as const;

// Fallback cap for an unmeasured machine; a flow that can measure passes `memory` instead.
export const LOCAL_SANDBOX_MEMORY = "7g";

const GIB = 1024 ** 3;
// What the derived cap leaves the engine (distro, docker, sibling containers); an owner's ask may take it.
const SANDBOX_MEMORY_RESERVE = 3 * GIB;
// Below this any cap, derived or asked, breaks the image's own toolchain.
const SANDBOX_MEMORY_FLOOR = 4 * GIB;
// Swap a capped sandbox may page into: runway for a peak past the cap, never the engine's whole swap. Unbounded (`-1`),
// one sandbox paged 24 of a WSL guest's 28 GiB of swap until the guest itself ran dry; bounded, an overrun ends in an OOM
// kill inside the sandbox's own cgroup. Never zero: a no-swap cgroup livelocks reclaiming file-backed pages rather than
// triggering OOM.
//
// (2026-11-05) A quarter of the cap, 1 to 4 GiB, where it was half the cap: on rog one process paged 33 GB at about 7 GB a
// minute, so half of an 18 GiB cap was over a minute of thrashing where 4 GiB is gone in seconds and the sandbox's own OOM
// fires. The owner may ask for another amount (SANDBOX_SWAP, `<n>g`, the swap alone), which `ic` sets on the container
// and a recreate replays. `defaultSandboxSwapGib` below is the formula's source: the sandbox imports it to hold its own
// workload leaf to the same number whatever the engine does with `--memory-swap` (rog's engine ignores it; the
// sandbox's system/resources/daemon-cgroup.ts). What cannot import it copies it: the sandbox's docker-entrypoint.sh, run
// before any Node, and ic's shape.rs `default_swap_gib`, in Rust; the editor's resources form (sandboxResources.ts)
// mirrors it for its placeholder. Change it here, change the copies.
const SANDBOX_SWAP_SHARE = 0.25;
const SANDBOX_SWAP_MAX_GIB = 4;

// The default swap in whole GiB for a cap of `capGib` GiB, floored to whole GiB first (the sandbox passes its cgroup's
// bytes over a GiB): a quarter of it, rounded up, at least 1 and at most 4.
export const defaultSandboxSwapGib = (capGib: number): number =>
    Math.min(SANDBOX_SWAP_MAX_GIB, Math.max(1, Math.ceil(Math.max(1, Math.floor(capGib)) * SANDBOX_SWAP_SHARE)));

// The owner's swap ask in whole GiB, or undefined for the default; a malformed one throws, never falls back to unbounded.
const swapAskGib = (swap: string | undefined): number | undefined => {
    if (swap === undefined || swap.trim() === "") {
        return undefined;
    }
    const asked = /^(\d+)g$/u.exec(swap.trim());
    if (asked === null || Number(asked[1]) < 1) {
        throw new Error(`${SANDBOX_SWAP_ENV} must be whole GiB of swap spelled '<n>g', at least '1g' (e.g. '4g'), got '${swap}'`);
    }
    return Number(asked[1]);
};

// Formats a byte cap as docker's `<n>g`; shared so a derived and an explicit ask round identically.
const capString = (capBytes: number): string => `${Math.max(1, Math.floor(capBytes / GIB))}g`;

// An owner's explicit cap in bytes: the number typed, raised only to the floor; a malformed value throws, never falls back.
const overrideCapBytes = (override: string): number => {
    const asked = /^(\d+)g$/u.exec(override.trim());
    if (asked === null) {
        throw new Error(`SANDBOX_MEMORY must be whole GiB spelled '<n>g' (e.g. '10g'), got '${override}'`);
    }
    return Math.max(Number(asked[1]) * GIB, SANDBOX_MEMORY_FLOOR);
};

// The cap as docker's `<n>g`, from engine bytes the caller measured: `override` (SANDBOX_MEMORY, replayed) replaces the derived cap.
export const localSandboxMemory = (totalBytes: number, override?: string): string => {
    // Empty is absent, not invalid: replayableEnv drops empty values, so an unset cap arrives either way.
    if (override !== undefined && override.trim() !== "") {
        return capString(overrideCapBytes(override));
    }
    if (!Number.isFinite(totalBytes) || totalBytes <= 0) {
        return LOCAL_SANDBOX_MEMORY;
    }
    return capString(Math.max(totalBytes - SANDBOX_MEMORY_RESERVE, SANDBOX_MEMORY_FLOOR));
};

// Docker's `--memory-swap` for a `<n>g` cap: the cap plus the swap, which is the owner's `swap` ask (SANDBOX_SWAP) or the
// default above. Docker's flag is memory PLUS swap, where SANDBOX_SWAP is the swap alone. Every cap this package emits is
// `<n>g`; anything else throws, since falling back to unbounded is the failure above.
export const localSandboxMemorySwap = (memory: string, swap?: string): string => {
    const cap = /^(\d+)g$/u.exec(memory.trim());
    if (cap === null) {
        throw new Error(`a sandbox memory cap must be whole GiB spelled '<n>g' (e.g. '10g'), got '${memory}'`);
    }
    const capGib = Number(cap[1]);
    return `${capGib + (swapAskGib(swap) ?? defaultSandboxSwapGib(capGib))}g`;
};

// No derived cap, unlike memory: 'nothing asked' means every core, since `--cpus` is a hard CFS ceiling, not a share.
// Whole cores only, bounded by the engine's count when measurable; a malformed or out-of-range ask throws.
export const localSandboxCpus = (engineCpus: number, override?: string): string | undefined => {
    if (override === undefined || override.trim() === "") {
        return undefined;
    }
    const asked = /^(\d+)$/u.exec(override.trim());
    if (asked === null || Number(asked[1]) < 1) {
        throw new Error(`SANDBOX_CPUS must be a whole number of CPUs, at least 1 (e.g. '4'), got '${override}'`);
    }
    const measured = Number.isFinite(engineCpus) && engineCpus >= 1;
    return String(measured ? Math.min(Number(asked[1]), Math.floor(engineCpus)) : Number(asked[1]));
};

// Privileges ride only via allowlisted runtime lines; `--gpus=all`, not `--gpus all` (splits on whitespace).
export const RUNTIME_DIRECTIVE_PREFIX = "# intentic:runtime ";
export const RUNTIME_DIRECTIVES = ["--device=/dev/net/tun", "--cap-add=NET_ADMIN", "--privileged", "--gpus=all"] as const;

// Directives a host may not support: droppable via preflight (unlike the all-or-nothing kind), as data so the check
// works across every host-side dialect. `probe` is a closed vocabulary, not shell:
// - "runtime": the runtime can grant its device request; GPU requests exercise gpuProbeArgv, since the runtime
//   list alone misses CDI and also passes on GPU-less hosts.
// - "device": a device node exists on the host.
export interface OptionalDirective {
    // The allowlisted token, exactly as it appears in RUNTIME_DIRECTIVES.
    readonly token: string;
    // What to call it when telling a person it was dropped.
    readonly name: string;
    // Stamps the ask's fate: "all" if it rode, "unsupported" if not; absent is a third state, not "no".
    readonly env: string;
    readonly probe: { readonly kind: "runtime"; readonly name: string } | { readonly kind: "device"; readonly path: string };
}

export const OPTIONAL_DIRECTIVES: readonly OptionalDirective[] = [
    {
        token: "--gpus=all",
        name: "NVIDIA GPU access",
        env: "SANDBOX_GPU",
        probe: { kind: "runtime", name: "nvidia" },
    },
];

// Exercise the actual Docker device request. A registered runtime or CDI setting alone also exists on GPU-less
// hosts; only a successful device listing proves the launch can use one. The sandbox image is already on the host.
export const gpuProbeArgv = (image: string): string[] => [
    "docker",
    "run",
    "--rm",
    "--pull=never",
    "--network=none",
    "--gpus=all",
    "--entrypoint=nvidia-smi",
    image,
    "-L",
];
// A device line of `nvidia-smi -L` (`GPU 0: … (UUID: GPU-…)`), the same test ic's contract.rs applies at launch, so a
// save this accepts is not dropped by the start that follows; any other mention of "GPU-" proves nothing.
export const gpuProbePassed = (code: number, stdout: string): boolean => code === 0 && /\(UUID: GPU-[0-9a-f-]+\)/iu.test(stdout);

export const optionalDirective = (token: string): OptionalDirective | undefined => OPTIONAL_DIRECTIVES.find((entry) => entry.token === token);

// Validates tokens against the allowlist, or throws naming the first that isn't; `source` names where it came from.
// Deduped, first appearance wins, since two askers may want the same grant and not every flag can repeat.
const allowlistedTokens = (tokens: readonly string[], source: string): string[] => {
    const seen = new Set<string>();
    for (const token of tokens) {
        if (token === "") {
            continue;
        }
        if (!(RUNTIME_DIRECTIVES as readonly string[]).includes(token)) {
            throw new Error(`unsupported runtime directive '${token}' in ${source}`);
        }
        seen.add(token);
    }
    return [...seen];
};

// The allowlisted runtime tokens of an overlay: what the CAPABILITIES the owner approved need.
export const runtimeDirectivesOf = (overlay: string): string[] =>
    allowlistedTokens(
        overlay
            .split("\n")
            .filter((line) => line.startsWith(RUNTIME_DIRECTIVE_PREFIX))
            .flatMap((line) => line.slice(RUNTIME_DIRECTIVE_PREFIX.length).trim().split(/\s+/)),
        "the approved overlay",
    );

// Owner's runtime asks beyond the overlay's, as SANDBOX_RUNTIME; only this half is theirs to withdraw.
export const HOST_RUNTIME_ENV = "SANDBOX_RUNTIME";
export const hostRuntimeOf = (value: string | undefined): string[] => allowlistedTokens((value ?? "").trim().split(/\s+/), HOST_RUNTIME_ENV);

// Stamps the overlay's demand as provenance: inspect alone can't tell overlay privilege from owner's.
export const OVERLAY_RUNTIME_ENV = "SANDBOX_OVERLAY_RUNTIME";

// Every flow gates on /health with the same patience, so a crash-loop never reads as success.
export const HEALTH = { url: `http://localhost:${DAEMON_PORT}/health`, attempts: 15, intervalSeconds: 2 } as const;

// Kept quiet: above default dev-server/db ports, below Linux's ephemeral floor, so nothing collides. The device agent's
// sync SSH ports sit in the band just below (_devices/machine/src/sync/tunnel.ts); names.fixture.json records both, so
// moving either base is a test that fails rather than two bands that quietly overlap.
const LOCAL_PORT_BASE = 28000;
const LOCAL_PORT_SPAN = 4000;

// The host loopback port a sandbox with this 12-hex id publishes its LOOPBACK LISTENER on (container-side
// LOCAL_PORT, never the tunnel's DAEMON_PORT, see @intentic/constants for why the two are separate).
// Deterministic, so a recreate lands on the same port and the browser can derive it without being told.
export const localDaemonPort = (sandboxId: string): number => LOCAL_PORT_BASE + (Number.parseInt(sandboxId.slice(0, 6), 16) % LOCAL_PORT_SPAN);

// The plain address that port answers on; its certified sibling is composed where it's dialled (the editor's
// endpoint.ts), which alone needs both this port and the loopback hostname from sandbox-contract.
export const localDaemonUrlInsecure = (sandboxId: string): string => `http://127.0.0.1:${localDaemonPort(sandboxId)}`;

export interface SandboxRun {
    readonly names: SandboxNames;
    readonly image: string;
    // What the daemon composes overlays against: the official tag, or a pinned dev tag.
    readonly baseImage: string;
    // The approved overlay's hash; stamps SANDBOX_ENVIRONMENT_HASH so recompose checks stay quiet.
    readonly environmentHash?: string;
    // Release channel and prior image, set by recreate.sh; not replayed, so it won't pin forever.
    readonly channel?: string;
    readonly previousImage?: string;
    // The registry digest (`sha256:…`) of the base this image was built on, when the runner could read it off the
    // machine; not replayed, since the next run may be on another base. What makes `baseImage` an exact image.
    readonly baseDigest?: string | undefined;
    // A sandbox.toml an empty workspace seeds from, carried base64 in SANDBOX_DEFINITION_SEED.
    readonly definition?: string;
    // Replayed/wizard env pairs, already filtered through replayableEnv.
    readonly env?: readonly (readonly [string, string])[];
    // Allowlisted directive tokens the overlay asks for: what its capabilities need.
    readonly runtime?: readonly string[];
    // Allowlisted directive tokens the owner asks for; only this half is theirs to withdraw.
    readonly hostRuntime?: readonly string[];
    // The owner's CPU ceiling, or absent for every core (the default); local shape only.
    readonly cpus?: string;
    // Extra -v specs, verbatim: the /agent-auth replay, the dev flow's compiled-tree binds.
    readonly mounts?: readonly string[];
    // The local cgroup cap; omitted falls back to LOCAL_SANDBOX_MEMORY, ignored by the hosted shape.
    readonly memory?: string;
    // Hosted-provider extras: -p specs, --label key=values, --dns resolvers.
    readonly ports?: readonly string[];
    readonly labels?: readonly string[];
    readonly dns?: readonly string[];
    // The sandbox's 12-hex id; absent on a bare dev run with no connect token.
    readonly sandboxId?: string;
    // Publish the loopback shortcut; false retries a launch docker refused for a taken port.
    readonly localPublish?: boolean;
    // Directives this host's probe failed; dropped but stamped, so absence differs from an unbuilt overlay.
    readonly unsupported?: readonly string[];
    // The hosted provider runs without --init or the network alias; every local flow has both by default.
    readonly init?: boolean;
    readonly alias?: boolean;
}

// Cgroup ceilings, local shape only (`init: false` sizes elsewhere). A bounded swap always rides with a cap so an overrun
// pages for a while instead of livelocking, then stops inside the sandbox; a CPU ceiling only when the owner asked.
// The swap comes from the replayed SANDBOX_SWAP, which `env` also puts on the container: an engine that ignores
// `--memory-swap` (one without swap-limit support, rog's on 2026-11-05) still has the sandbox hold its own workload leaf
// to the same number.
const resourcesOf = (run: SandboxRun): SandboxRunSpec["resources"] => {
    if (run.init === false) {
        return undefined;
    }
    const memory = run.memory ?? LOCAL_SANDBOX_MEMORY;
    const swap = run.env?.find(([name]) => name === SANDBOX_SWAP_ENV)?.[1];
    return { memory, memorySwap: localSandboxMemorySwap(memory, swap), cpus: run.cpus };
};

type EnvPair = [string, string];

// One pair when the value was set, none when it was not.
const pairIf = (name: string, value: string | undefined): EnvPair[] => (value === undefined ? [] : [[name, value]]);

// Resolves both directive sources into one deduped union; everything downstream sees only the union, so an owner-asked
// GPU is probed and dropped exactly like a capability-asked one. `stamps` also names the overlay's half alone.
interface ResolvedDirectives {
    readonly flags: string[];
    readonly stamps: EnvPair[];
}

const directivesOf = (run: SandboxRun): ResolvedDirectives => {
    const overlay = run.runtime ?? [];
    const union = new Set<string>([...overlay, ...(run.hostRuntime ?? [])]);
    const asked = OPTIONAL_DIRECTIVES.filter((entry) => union.has(entry.token));
    const dropped = new Set(asked.filter((entry) => (run.unsupported ?? []).includes(entry.token)).map((entry) => entry.token));
    return {
        flags: Array.from(union).filter((token) => !dropped.has(token)),
        stamps: [
            ...asked.map((entry): EnvPair => [entry.env, dropped.has(entry.token) ? "unsupported" : "all"]),
            ...pairIf(OVERLAY_RUNTIME_ENV, overlay.length === 0 ? undefined : Array.from(new Set(overlay)).join(" ")),
        ],
    };
};

// The hosted provider's real ingress ports, then the loopback shortcut; the one part of the run allowed to drop on
// retry, since its failure doesn't mean a broken sandbox.
const publishOf = (run: SandboxRun): string[] => [
    ...(run.ports ?? []),
    ...(run.sandboxId !== undefined && run.localPublish !== false ? [`127.0.0.1:${localDaemonPort(run.sandboxId)}:${LOCAL_PORT}`] : []),
];

// UTF-8 text as base64 without Node's Buffer, so the spec renders in a browser too (the setup page's Compose file).
const base64Utf8 = (text: string): string => {
    let binary = "";
    for (const byte of new TextEncoder().encode(text)) {
        binary += String.fromCharCode(byte);
    }
    return btoa(binary);
};

// What this container is, as env: name, image, base image, plus the runner-decided facts (hash, channel, rollback
// target, seed) when set.
const identityEnv = (run: SandboxRun): EnvPair[] => [
    ["SANDBOX_NAME", run.names.container],
    ["SANDBOX_IMAGE", run.image],
    ["SANDBOX_BASE_IMAGE", run.baseImage],
    ...pairIf("SANDBOX_ENVIRONMENT_HASH", run.environmentHash),
    ...pairIf("SANDBOX_CHANNEL", run.channel),
    ...pairIf("SANDBOX_PREVIOUS_IMAGE", run.previousImage),
    ...pairIf(BASE_DIGEST_ENV, run.baseDigest),
    ...pairIf("SANDBOX_DEFINITION_SEED", run.definition === undefined ? undefined : base64Utf8(run.definition)),
];

// How long a stop waits before its SIGKILL: past the 25 s intentic-netd gives the daemon to dispose every subsystem on
// SIGTERM (STOP_GRACE in _sandbox/netd/crates/netd/src/supervise.rs), with room for netd to close its tunnel after,
// where Docker's (and Compose's) default of 10 s cut that stop short.
export const STOP_TIMEOUT_SECONDS = 30;

// The json-file log rotation every sandbox container runs with.
const LOG_OPTIONS = [
    ["max-size", "10m"],
    ["max-file", "3"],
] as const;

// The run contract as data, before any dialect spells it: `sandboxRunArgv` renders it as a `docker run` line and
// compose.ts as a Compose service, so the two cannot disagree about what a sandbox is. Every field is in the order the
// argv has always written it.
export interface SandboxRunSpec {
    readonly container: string;
    readonly init: boolean;
    readonly restart: "unless-stopped";
    readonly stopTimeoutSeconds: number;
    readonly labels: readonly string[];
    readonly network: string;
    readonly networkAlias: string | undefined;
    readonly extraHosts: readonly string[];
    readonly dns: readonly string[];
    readonly logOptions: readonly (readonly [string, string])[];
    // Absent on the hosted shape, which is sized elsewhere; `cpus` only when the owner asked for a ceiling.
    readonly resources: { readonly memory: string; readonly memorySwap: string; readonly cpus: string | undefined } | undefined;
    readonly capabilities: readonly string[];
    // Allowlisted runtime directive tokens that ride (RUNTIME_DIRECTIVES), the dropped optional ones already removed.
    readonly directives: readonly string[];
    // `-p` specs: the hosted ports, then the loopback shortcut.
    readonly publish: readonly string[];
    // The sandbox's own named volumes (SANDBOX_VOLUMES), with the volume each one is.
    readonly volumes: readonly { readonly name: string; readonly destination: string; readonly volume: SandboxVolume }[];
    // Extra `-v` specs, verbatim.
    readonly mounts: readonly string[];
    // Identity, then the directive stamps, then the replayed pairs: the order `-e` has always carried them in.
    readonly env: readonly (readonly [string, string])[];
    readonly image: string;
}

export const sandboxRunSpec = (run: SandboxRun): SandboxRunSpec => {
    const directives = directivesOf(run);
    return {
        container: run.names.container,
        init: run.init !== false,
        restart: "unless-stopped",
        stopTimeoutSeconds: STOP_TIMEOUT_SECONDS,
        labels: run.labels ?? [],
        network: run.names.network,
        networkAlias: run.alias === false ? undefined : ORIGIN_HOST,
        extraHosts: ["host.docker.internal:host-gateway"],
        dns: run.dns ?? [],
        logOptions: LOG_OPTIONS,
        resources: resourcesOf(run),
        capabilities: SANDBOX_CAPABILITIES,
        directives: directives.flags,
        publish: publishOf(run),
        volumes: SANDBOX_VOLUMES.map((volume) => ({ name: run.names[volume.volume], destination: volume.destination, volume })),
        mounts: run.mounts ?? [],
        env: [...identityEnv(run), ...directives.stamps, ...(run.env ?? [])],
        image: run.image,
    };
};

// The `docker …` argv for a sandbox container, ordered the way connect.sh always wrote it; one builder shared by every
// dialect (sh, PowerShell, the SSH provider). golden/run-argv.json holds it byte-for-byte to what it emitted before the
// spec existed.
export const sandboxRunArgv = (run: SandboxRun): string[] => {
    const spec = sandboxRunSpec(run);
    return [
        "run",
        "-d",
        ...(spec.init ? ["--init"] : []),
        "--restart",
        spec.restart,
        "--stop-timeout",
        String(spec.stopTimeoutSeconds),
        "--name",
        spec.container,
        ...spec.labels.flatMap((label) => ["--label", label]),
        "--network",
        spec.network,
        ...(spec.networkAlias === undefined ? [] : ["--network-alias", spec.networkAlias]),
        ...spec.extraHosts.flatMap((host) => ["--add-host", host]),
        ...spec.dns.flatMap((server) => ["--dns", server]),
        ...spec.logOptions.flatMap(([key, value]) => ["--log-opt", `${key}=${value}`]),
        ...(spec.resources === undefined
            ? []
            : [
                  "--memory",
                  spec.resources.memory,
                  "--memory-swap",
                  spec.resources.memorySwap,
                  ...(spec.resources.cpus === undefined ? [] : ["--cpus", spec.resources.cpus]),
              ]),
        ...spec.capabilities.map((cap) => `--cap-add=${cap}`),
        ...spec.directives,
        ...spec.publish.flatMap((port) => ["-p", port]),
        ...spec.volumes.flatMap(({ name, destination }) => ["-v", `${name}:${destination}`]),
        ...spec.mounts.flatMap((mount) => ["-v", mount]),
        ...spec.env.flatMap(([name, value]) => ["-e", `${name}=${value}`]),
        spec.image,
    ];
};

// The complete `docker run …` line for sh consumers: what the CLI verb prints, a host shell executes, and the hosted
// provider splices into its SSH exec.
export const sandboxRunCommand = (run: SandboxRun): string => ["docker", ...sandboxRunArgv(run).map(shellQuote)].join(" ");
