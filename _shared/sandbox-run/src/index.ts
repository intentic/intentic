import { DAEMON_PORT, HISTORY_ROOT, LOCAL_PORT, WORKSPACE_ROOT } from "@intentic/constants";
import { shellQuote } from "./quote.js";
import { SANDBOX_CONTAINER_PREFIX } from "./slug.js";

// The sandbox container's run contract: every way a sandbox starts, composed from one definition instead of four
// hand-copied dialects. TS consumers import it (drift is a compile error); scripts that can't import execute `intentic
// sandbox run`'s printed command instead, so a stale script still runs a new image correctly.

// The in-network hostname the tunnel sidecar dials; every flow must derive it identically.
export const ORIGIN_HOST = "intentic-sandbox-workspace";

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

// Where the sandbox's own Docker engine keeps its images, containers and their volumes.
export const DOCKER_ROOT = "/var/lib/docker";

// One named volume of a sandbox, and what each reader of the run contract needs to know about it.
export interface SandboxVolume {
    readonly destination: string;
    // Its name, as sandboxNames spells it for a slug.
    readonly volume: "workspaceVolume" | "historyVolume" | "dockerVolume";
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
    { destination: WORKSPACE_ROOT, volume: "workspaceVolume", planner: "--workspace" },
    // Never optional: holds the fleet registry, transcripts, every repo's git dir, the checkpoints.
    { destination: HISTORY_ROOT, volume: "historyVolume", planner: "--history" },
    {
        destination: DOCKER_ROOT,
        volume: "dockerVolume",
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
// Swap a capped sandbox may page into, as a share of its cap: runway for a peak past the cap, never the engine's whole
// swap. Unbounded (`-1`), one sandbox paged 24 of a WSL guest's 28 GiB of swap until the guest itself ran dry; bounded,
// an overrun ends in an OOM kill inside the sandbox's own cgroup. Never zero: a no-swap cgroup livelocks reclaiming
// file-backed pages rather than triggering OOM.
const SANDBOX_SWAP_SHARE = 0.5;

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

// Docker's `--memory-swap` for a `<n>g` cap: the cap plus its swap share, rounded up to a whole GiB and at least one.
// Every cap this package emits is `<n>g`; anything else throws, since falling back to unbounded is the failure above.
export const localSandboxMemorySwap = (memory: string): string => {
    const cap = /^(\d+)g$/u.exec(memory.trim());
    if (cap === null) {
        throw new Error(`a sandbox memory cap must be whole GiB spelled '<n>g' (e.g. '10g'), got '${memory}'`);
    }
    const capGib = Number(cap[1]);
    return `${capGib + Math.max(1, Math.ceil(capGib * SANDBOX_SWAP_SHARE))}g`;
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

// What a replayed variable says about the sandbox, which decides what a recreate elsewhere keeps of it: a move to another
// machine keeps all but `machine`, a copy keeps neither `identity` nor `machine`.
// - layout: where things are inside the container (roots, key files, the daemon's listeners)
// - platform: which platform, editor and edge it answers to; the same for every sandbox of one deployment
// - identity: who this sandbox is to the platform and the edge, and to the parent it runs for
// - machine: the computer it runs on, and what that computer paired with it at setup
// - choice: the owner's standing asks of the container
// - purpose: what the sandbox was made for
type ReplayRole = "layout" | "platform" | "identity" | "machine" | "choice" | "purpose";

interface ReplayVar {
    readonly name: string;
    readonly role: ReplayRole;
    // A credential: the daemon seals it out of its own environment at boot, alongside its config schema's own secret
    // leaves, so no process it spawns inherits one (sandbox src/seams/sealed-env.ts); a replayed name the daemon's schema
    // also reads must agree with it, which the daemon's suite checks.
    readonly secret?: true;
}

// Vars a recreate replays, in order; image-identity vars are absent, derived from the emitter's own inputs.
export const REPLAY_VARS = [
    { name: "WORKSPACE_ROOT", role: "layout" },
    { name: "HISTORY_ROOT", role: "layout" },
    { name: "AGENT_AUTH_DIR", role: "layout" },
    // The paths of the mounted at-rest keys, never their contents.
    { name: "INTENTIC_AT_REST_KEY_FILE", role: "layout" },
    { name: "INTENTIC_AT_REST_PREVIOUS_KEY_FILE", role: "layout" },
    { name: "SANDBOX_HOST", role: "layout" },
    { name: "SANDBOX_PORT", role: "layout" },
    { name: "SANDBOX_NAME", role: "identity" },
    { name: "PREVIEW_PORT", role: "layout" },
    { name: "GOOGLE_CLIENT_ID", role: "platform" },
    { name: "CONNECT_TOKEN", role: "identity", secret: true },
    { name: "OWNER_EMAIL", role: "identity" },
    { name: "WEB_ORIGIN", role: "platform" },
    { name: "SANDBOX_PUBLIC_URL", role: "identity" },
    { name: "PLATFORM_URL", role: "platform" },
    // Reachability: the signed grant and the edge it dials; replaying it keeps the same public name.
    { name: "SANDBOX_GRANT", role: "identity", secret: true },
    { name: "INGRESS_URL", role: "platform" },
    // The owner's own Cloudflare account, on the path where they mint their own tunnels.
    { name: "CLOUDFLARE_API_TOKEN", role: "platform", secret: true },
    // A multi-line private key for self-hosted deploys: this machine wired as a deploy target.
    { name: "HOST_SSH_KEY", role: "machine", secret: true },
    { name: "SELF_HOST_USER", role: "machine" },
    { name: "SYNC_PAIR_TOKEN", role: "machine", secret: true },
    // Describes the machine, which a recreate doesn't move off; the daemon can't re-derive it.
    { name: "HOST_PAIR_TOKEN", role: "machine", secret: true },
    { name: "HOST_PLATFORM", role: "machine" },
    { name: "HOST_LABEL", role: "machine" },
    { name: "SELF_HOST_ADDRESS", role: "machine" },
    { name: "SELF_HOST_VIA", role: "machine" },
    // The owner's explicit cgroup cap; replayed so it re-emits, unlike docker update's silent retune.
    { name: "SANDBOX_MEMORY", role: "choice" },
    // The owner's other standing asks, replayed like the memory cap: CPU ceiling and runtime directives.
    { name: "SANDBOX_CPUS", role: "choice" },
    { name: "SANDBOX_RUNTIME", role: "choice" },
    // A runner's parent sandbox and pairing token, replayed since a recreate can't re-derive either.
    { name: "RUNNER_PARENT_URL", role: "identity" },
    { name: "RUNNER_PAIR_TOKEN", role: "identity", secret: true },
    // The dev checkout this container was launched from; allowlisted so `INTENTIC_SET_ENV` can deliver it and every
    // later dev recreate keeps it. A path on the host, meaningless in here except as an argument sent back out.
    { name: "SANDBOX_DEV_ROOT", role: "machine" },
    // The arriving profile's own sandbox definition. Replayed rather than consumed, because a recreate is how a
    // workspace that never filled gets a second chance at it; the daemon applies it only to one that arrived empty.
    { name: "SANDBOX_DEFINITION_SEED", role: "purpose" },
    // The folder of the owner's computer this sandbox was made for, synced into `/work/<name>` (connect.rs). What the
    // sandbox IS rather than a setting: a recreate that dropped it would seed a starter site beside the owner's project.
    { name: "SANDBOX_PROJECT_DIR", role: "purpose" },
    // This computer's own sandbox, which folders attach to later (connect.rs). Also what the sandbox is: a recreate that
    // dropped it would seed a starter site and stop taking the folders the machine agent attaches.
    { name: "SANDBOX_PROJECTS_HOST", role: "purpose" },
] as const satisfies readonly ReplayVar[];

type ReplayName = (typeof REPLAY_VARS)[number]["name"];

// The replayed names, in order.
export const REPLAY_ENV: readonly ReplayName[] = REPLAY_VARS.map(({ name }) => name);

// The replayed names whose value is a credential (ReplayVar's `secret`).
export const REPLAY_SECRET_ENV: ReadonlySet<ReplayName> = new Set(REPLAY_VARS.flatMap((entry) => ("secret" in entry ? [entry.name] : [])));

// `printenv -0` / `env -0` output → name/value pairs. NUL framing is the only safe channel for these values:
// HOST_SSH_KEY is a multi-line private key, so anything line-based re-splits it.
export const parseNulEnv = (dump: string): [string, string][] =>
    dump
        .split("\0")
        .filter((entry) => entry.includes("="))
        .map((entry) => {
            const eq = entry.indexOf("=");
            return [entry.slice(0, eq), entry.slice(eq + 1)];
        });

// The pairs a recreate actually replays: allowlisted, empties dropped (an empty secret must not shadow the workspace
// .env), in REPLAY_ENV's canonical order.
export const replayableEnv = (pairs: readonly (readonly [string, string])[]): [string, string][] =>
    REPLAY_ENV.flatMap((name) => {
        const value = pairs.find(([key]) => key === name)?.[1];
        return value === undefined || value === "" ? [] : [[name, value] as [string, string]];
    });

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

// The `docker …` argv for a sandbox container, ordered the way connect.sh always wrote it; one builder shared by every
// dialect (sh, PowerShell, the SSH provider).
// Cgroup ceilings, local shape only (`init: false` sizes elsewhere). A bounded `--memory-swap` always rides with a cap so
// an overrun pages for a while instead of livelocking, then stops inside the sandbox; `--cpus` only when the owner asked.
const resourceArgs = (run: SandboxRun): string[] => {
    if (run.init === false) {
        return [];
    }
    const memory = run.memory ?? LOCAL_SANDBOX_MEMORY;
    return ["--memory", memory, "--memory-swap", localSandboxMemorySwap(memory), ...(run.cpus === undefined ? [] : ["--cpus", run.cpus])];
};

// Resolves both directive sources into one deduped union; everything downstream sees only the union, so an owner-asked
// GPU is probed and dropped exactly like a capability-asked one. `stamps` also names the overlay's half alone.
const directiveArgs = (run: SandboxRun): { readonly flags: string[]; readonly stamps: string[] } => {
    const overlay = run.runtime ?? [];
    const union = new Set<string>([...overlay, ...(run.hostRuntime ?? [])]);
    const asked = OPTIONAL_DIRECTIVES.filter((entry) => union.has(entry.token));
    const dropped = new Set(asked.filter((entry) => (run.unsupported ?? []).includes(entry.token)).map((entry) => entry.token));
    return {
        flags: Array.from(union).filter((token) => !dropped.has(token)),
        stamps: [
            ...asked.flatMap((entry) => ["-e", `${entry.env}=${dropped.has(entry.token) ? "unsupported" : "all"}`]),
            ...(overlay.length === 0 ? [] : ["-e", `${OVERLAY_RUNTIME_ENV}=${Array.from(new Set(overlay)).join(" ")}`]),
        ],
    };
};

// The hosted provider's real ingress ports, then the loopback shortcut; the one part of the run allowed to drop on
// retry, since its failure doesn't mean a broken sandbox.
const publishArgs = (run: SandboxRun): string[] => [
    ...(run.ports ?? []).flatMap((port) => ["-p", port]),
    ...(run.sandboxId !== undefined && run.localPublish !== false ? ["-p", `127.0.0.1:${localDaemonPort(run.sandboxId)}:${LOCAL_PORT}`] : []),
];

// What this container is, as env: name, image, base image, plus the runner-decided facts (hash, channel, rollback
// target, seed) when set.
const identityEnv = (run: SandboxRun): string[] => [
    "-e",
    `SANDBOX_NAME=${run.names.container}`,
    "-e",
    `SANDBOX_IMAGE=${run.image}`,
    "-e",
    `SANDBOX_BASE_IMAGE=${run.baseImage}`,
    ...(run.environmentHash === undefined ? [] : ["-e", `SANDBOX_ENVIRONMENT_HASH=${run.environmentHash}`]),
    ...(run.channel === undefined ? [] : ["-e", `SANDBOX_CHANNEL=${run.channel}`]),
    ...(run.previousImage === undefined ? [] : ["-e", `SANDBOX_PREVIOUS_IMAGE=${run.previousImage}`]),
    ...(run.definition === undefined ? [] : ["-e", `SANDBOX_DEFINITION_SEED=${Buffer.from(run.definition, "utf8").toString("base64")}`]),
];

// How long `docker stop` waits before its SIGKILL: past the 25 s intentic-netd gives the daemon to dispose every
// subsystem on SIGTERM (STOP_GRACE in _sandbox/netd/crates/netd/src/supervise.rs), with room for netd to close
// its tunnel after, where Docker's default of 10 s cut that stop short.
const STOP_TIMEOUT_SECONDS = "30";

export const sandboxRunArgv = (run: SandboxRun): string[] => {
    const directives = directiveArgs(run);
    return [
        "run",
        "-d",
        ...(run.init === false ? [] : ["--init"]),
        "--restart",
        "unless-stopped",
        "--stop-timeout",
        STOP_TIMEOUT_SECONDS,
        "--name",
        run.names.container,
        ...(run.labels ?? []).flatMap((label) => ["--label", label]),
        "--network",
        run.names.network,
        ...(run.alias === false ? [] : ["--network-alias", ORIGIN_HOST]),
        "--add-host",
        "host.docker.internal:host-gateway",
        ...(run.dns ?? []).flatMap((server) => ["--dns", server]),
        "--log-opt",
        "max-size=10m",
        "--log-opt",
        "max-file=3",
        ...resourceArgs(run),
        ...SANDBOX_CAPABILITIES.map((cap) => `--cap-add=${cap}`),
        ...directives.flags,
        ...publishArgs(run),
        ...SANDBOX_VOLUMES.flatMap(({ destination, volume }) => ["-v", `${run.names[volume]}:${destination}`]),
        ...(run.mounts ?? []).flatMap((mount) => ["-v", mount]),
        ...identityEnv(run),
        ...directives.stamps,
        ...(run.env ?? []).flatMap(([name, value]) => ["-e", `${name}=${value}`]),
        run.image,
    ];
};

// The complete `docker run …` line for sh consumers: what the CLI verb prints, a host shell executes, and the hosted
// provider splices into its SSH exec.
export const sandboxRunCommand = (run: SandboxRun): string => ["docker", ...sandboxRunArgv(run).map(shellQuote)].join(" ");
