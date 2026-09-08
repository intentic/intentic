import { DAEMON_PORT, LOCAL_PORT } from "@intentic/constants";
import { shellQuote } from "./quote.js";

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

export const sandboxNames = (slug: string): SandboxNames => ({
    container: `intentic-sandbox-${slug}`,
    tunnelContainer: `intentic-sandbox-tunnel-${slug}`,
    workspaceVolume: `intentic-workspace-${slug}`,
    historyVolume: `intentic-history-${slug}`,
    dockerVolume: `intentic-docker-${slug}`,
    network: `intentic-workspace-${slug}`,
});

// Container-scoped capabilities every sandbox gets: SYS_ADMIN for mount namespaces, SYS_PTRACE for diagnosis.
export const SANDBOX_CAPABILITIES = ["SYS_ADMIN", "SYS_PTRACE"] as const;

// Fallback cap for an unmeasured machine; a flow that can measure passes `memory` instead.
export const LOCAL_SANDBOX_MEMORY = "7g";

const GIB = 1024 ** 3;
// Host reserve (distro, docker, sibling containers), and the floor below which a cap breaks the toolchain.
const SANDBOX_MEMORY_RESERVE = 3 * GIB;
const SANDBOX_MEMORY_FLOOR = 4 * GIB;
// Unbounded (`-1`): no-swap cgroups livelock reclaiming file-backed pages rather than triggering OOM.
export const SANDBOX_MEMORY_SWAP = "-1";

// Formats a byte cap as docker's `<n>g`; shared so a derived and an explicit ask round identically.
const capString = (capBytes: number): string => `${Math.max(1, Math.floor(capBytes / GIB))}g`;

// An owner's explicit cap, in bytes, held to the same bounds as the derived one; a malformed value throws rather than
// silently falling back. An unmeasurable machine honours the ask as typed.
const overrideCapBytes = (override: string, totalBytes: number): number => {
    const asked = /^(\d+)g$/u.exec(override.trim());
    if (asked === null) {
        throw new Error(`SANDBOX_MEMORY must be whole GiB spelled '<n>g' (e.g. '10g'), got '${override}'`);
    }
    const askedBytes = Math.max(Number(asked[1]) * GIB, SANDBOX_MEMORY_FLOOR);
    const measured = Number.isFinite(totalBytes) && totalBytes > 0;
    return measured ? Math.min(askedBytes, Math.max(totalBytes - SANDBOX_MEMORY_RESERVE, SANDBOX_MEMORY_FLOOR)) : askedBytes;
};

// The per-machine cap, as docker's `<n>g` string, from bytes the caller measured (this module can't read /proc/meminfo
// itself). `override` (SANDBOX_MEMORY, replayed) replaces the derived cap rather than raising a floor.
export const localSandboxMemory = (totalBytes: number, override?: string): string => {
    // Empty is absent, not invalid: replayableEnv drops empty values, so an unset cap arrives either way.
    if (override !== undefined && override.trim() !== "") {
        return capString(overrideCapBytes(override, totalBytes));
    }
    if (!Number.isFinite(totalBytes) || totalBytes <= 0) {
        return LOCAL_SANDBOX_MEMORY;
    }
    return capString(Math.max(totalBytes - SANDBOX_MEMORY_RESERVE, SANDBOX_MEMORY_FLOOR));
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
// - "runtime": docker's own runtime list names it (e.g. the nvidia container runtime).
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

// Vars a recreate replays, in order; image-identity vars are absent, derived from the emitter's own inputs.
export const REPLAY_ENV = [
    "WORKSPACE_ROOT",
    "HISTORY_ROOT",
    "AGENT_AUTH_DIR",
    "SANDBOX_HOST",
    "SANDBOX_PORT",
    "SANDBOX_NAME",
    "PREVIEW_PORT",
    "GOOGLE_CLIENT_ID",
    "CONNECT_TOKEN",
    "OWNER_EMAIL",
    "WEB_ORIGIN",
    "SANDBOX_PUBLIC_URL",
    "PLATFORM_URL",
    // Reachability: the signed grant and the edge it dials; replaying it keeps the same public name.
    "SANDBOX_GRANT",
    "INGRESS_URL",
    "CLOUDFLARE_API_TOKEN",
    "HOST_SSH_KEY",
    "SELF_HOST_USER",
    "SYNC_PAIR_TOKEN",
    // Describes the machine, which a recreate doesn't move off; the daemon can't re-derive it.
    "HOST_PAIR_TOKEN",
    "HOST_PLATFORM",
    "HOST_LABEL",
    "SELF_HOST_ADDRESS",
    "SELF_HOST_VIA",
    // The owner's explicit cgroup cap; replayed so it re-emits, unlike docker update's silent retune.
    "SANDBOX_MEMORY",
    // The owner's other standing asks, replayed like the memory cap: CPU ceiling and runtime directives.
    "SANDBOX_CPUS",
    "SANDBOX_RUNTIME",
    // A runner's parent sandbox and pairing token, replayed since a recreate can't re-derive either.
    "RUNNER_PARENT_URL",
    "RUNNER_PAIR_TOKEN",
] as const;

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

// Kept quiet: above default dev-server/db ports, below Linux's ephemeral floor, so nothing collides.
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
// Cgroup ceilings, local shape only (`init: false` sizes elsewhere). `--memory-swap -1` always rides with a cap so an
// overrun pages instead of livelocking; `--cpus` only when the owner asked.
const resourceArgs = (run: SandboxRun): string[] =>
    run.init === false
        ? []
        : ["--memory", run.memory ?? LOCAL_SANDBOX_MEMORY, "--memory-swap", SANDBOX_MEMORY_SWAP, ...(run.cpus === undefined ? [] : ["--cpus", run.cpus])];

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

export const sandboxRunArgv = (run: SandboxRun): string[] => {
    const directives = directiveArgs(run);
    return [
        "run",
        "-d",
        ...(run.init === false ? [] : ["--init"]),
        "--restart",
        "unless-stopped",
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
        "-v",
        `${run.names.workspaceVolume}:/work`,
        // Never optional: holds the fleet registry, transcripts, every repo's git dir, the checkpoints.
        "-v",
        `${run.names.historyVolume}:/history`,
        "-v",
        `${run.names.dockerVolume}:/var/lib/docker`,
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
