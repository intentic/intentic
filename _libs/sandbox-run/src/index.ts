import { DAEMON_PORT } from "@intentic/constants";

/* THE SANDBOX CONTAINER'S RUN CONTRACT — every way a sandbox starts, composed from one definition.
 *
 * Seven creation paths in four dialects start the sandbox workspace container: the platform provider's
 * docker run over SSH (providers/host/workspace.ts), the compose generator (web setupCompose.ts), and the
 * curl-served/hand-run scripts (connect.sh, connect.ps1, recreate.sh, plus connect.sh's compose sibling).
 * They used to each restate the whole shape — names, volumes, flags, env list, directive allowlist — behind
 * "keep in lockstep" comments, and the lockstep broke exactly the way hand-sync always breaks: SYS_ADMIN
 * reached one path, then five, then all of them, across three commits, while every sandbox created the
 * ordinary way silently lost turn isolation.
 *
 * Now the contract lives here and travels two roads:
 *   - TS consumers (provider, compose generator, the CLI) import it — drift is a compile error.
 *   - The scripts cannot import anything (they are standalone curl|sh files), so they EXECUTE what the
 *     image emits: `intentic sandbox run` (the CLI verb built on this module) prints the full docker-run
 *     command, and the scripts shrink to their flow-specific pre-steps plus "run what the image said".
 *     The contract thereby ships WITH the image — a stale script still runs a new image correctly, which
 *     is the property hand-copied blocks can never have.
 *
 * The guard for the roads themselves is sandbox-run-contract.test.ts (sandbox app): any file in the repo
 * that hand-rolls a docker run mounting /work — instead of importing this module or invoking the verb —
 * fails there by discovery, not by being on a list. */

// ——— Names ————————————————————————————————————————————————————————————————————————————————————————————
// Every per-sandbox object is derived from the slug with these prefixes, and every flow must derive them
// identically or it targets someone else's container/volumes (cleanup.sh and the coexistence checks match
// on the same shapes). The alias is the stable in-network hostname the tunnel sidecar dials.
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

// ——— Posture ——————————————————————————————————————————————————————————————————————————————————————————
// The Linux capabilities EVERY sandbox container is granted. SYS_ADMIN lets the daemon give each isolated
// agent turn its own mount namespace, with the conversation's worktree standing in for /work (sandbox app
// agents/isolation.ts). Scoped to the container's own mounts — not host access; the docker socket is never
// mounted.
export const SANDBOX_CAPABILITIES = ["SYS_ADMIN"] as const;

// Extra privileges ride in ONLY through "# intentic:runtime" directive lines in the owner-approved overlay
// (the vpn's WireGuard needs tun + NET_ADMIN; the docker capability's isolated nested engine needs
// --privileged), allowlisted hard so an overlay can't smuggle arbitrary docker flags.
export const RUNTIME_DIRECTIVE_PREFIX = "# intentic:runtime ";
export const RUNTIME_DIRECTIVES = ["--device=/dev/net/tun", "--cap-add=NET_ADMIN", "--privileged"] as const;

// The allowlisted runtime tokens of an overlay, or a throw naming the first token that is not — an unknown
// directive is either a typo'd capability fragment or an escape attempt, and both must stop the recreate
// rather than be skipped into a sandbox that silently lacks (or exceeds) its privileges.
export const runtimeDirectivesOf = (overlay: string): string[] => {
    const tokens: string[] = [];
    for (const line of overlay.split("\n")) {
        if (!line.startsWith(RUNTIME_DIRECTIVE_PREFIX)) {
            continue;
        }
        for (const token of line.slice(RUNTIME_DIRECTIVE_PREFIX.length).trim().split(/\s+/)) {
            if (!(RUNTIME_DIRECTIVES as readonly string[]).includes(token)) {
                throw new Error(`unsupported runtime directive '${token}' in the approved overlay`);
            }
            tokens.push(token);
        }
    }
    return tokens;
};

// ——— Env ——————————————————————————————————————————————————————————————————————————————————————————————
/* The vars a recreate replays from the running container — the union of what every creator sets, in one
 * canonical order. SANDBOX_IMAGE / SANDBOX_BASE_IMAGE / SANDBOX_ENVIRONMENT_HASH are deliberately absent:
 * they name the image being SWAPPED IN, so the emitter derives them from its own inputs, never from the
 * container being replaced. */
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
    "CLOUDFLARE_API_TOKEN",
    "HOST_SSH_KEY",
    "SELF_HOST_USER",
    "SYNC_PAIR_TOKEN",
    "SELF_HOST_ADDRESS",
    "SELF_HOST_VIA",
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

// The pairs a recreate actually replays: allowlisted, empties dropped (an empty secret var would shadow the
// value the user writes to the workspace .env — recreating also heals a container that carried one), in
// REPLAY_ENV's canonical order so the emitted command is deterministic.
export const replayableEnv = (pairs: readonly (readonly [string, string])[]): [string, string][] =>
    REPLAY_ENV.flatMap((name) => {
        const value = pairs.find(([key]) => key === name)?.[1];
        return value === undefined || value === "" ? [] : [[name, value] as [string, string]];
    });

// ——— Health ———————————————————————————————————————————————————————————————————————————————————————————
// A container that starts but crash-loops must not read as success — every flow gates on the daemon's own
// /health with the same patience before declaring the sandbox up.
export const HEALTH = { url: `http://localhost:${DAEMON_PORT}/health`, attempts: 15, intervalSeconds: 2 } as const;

// ——— The run ——————————————————————————————————————————————————————————————————————————————————————————
export interface SandboxRun {
    readonly names: SandboxNames;
    readonly image: string;
    // What the daemon keeps composing overlays against (SANDBOX_BASE_IMAGE) — the official tag, or the dev
    // tag a dev swap pins so a later recompose doesn't flip the base back to :stable.
    readonly baseImage: string;
    // The approved overlay's hash, when the image was built from one — stamps SANDBOX_ENVIRONMENT_HASH so
    // the daemon's recompose check stays quiet.
    readonly environmentHash?: string;
    // Replayed/wizard env pairs, already filtered through replayableEnv.
    readonly env?: readonly (readonly [string, string])[];
    // Allowlisted runtime directive tokens (runtimeDirectivesOf).
    readonly runtime?: readonly string[];
    // Extra -v specs, verbatim: the /agent-auth replay, the dev flow's compiled-tree binds.
    readonly mounts?: readonly string[];
    // Hosted-provider extras: -p specs, --label key=values, --dns resolvers.
    readonly ports?: readonly string[];
    readonly labels?: readonly string[];
    readonly dns?: readonly string[];
    // The hosted provider runs without a /history volume, --init, or the network alias (no tunnel sidecar
    // shares its network); every local flow has all three. Defaults are the local shape.
    readonly history?: boolean;
    readonly init?: boolean;
    readonly alias?: boolean;
}

// The `docker …` argv for a sandbox container, ordered the way connect.sh always wrote it. One builder for
// every dialect: sh consumers quote it (sandboxRunCommand), PowerShell splats it as an array, the provider
// joins it into its SSH line.
export const sandboxRunArgv = (run: SandboxRun): string[] => [
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
    ...SANDBOX_CAPABILITIES.map((cap) => `--cap-add=${cap}`),
    ...(run.runtime ?? []),
    ...(run.ports ?? []).flatMap((port) => ["-p", port]),
    "-v",
    `${run.names.workspaceVolume}:/work`,
    ...(run.history === false ? [] : ["-v", `${run.names.historyVolume}:/history`]),
    "-v",
    `${run.names.dockerVolume}:/var/lib/docker`,
    ...(run.mounts ?? []).flatMap((mount) => ["-v", mount]),
    "-e",
    `SANDBOX_NAME=${run.names.container}`,
    "-e",
    `SANDBOX_IMAGE=${run.image}`,
    "-e",
    `SANDBOX_BASE_IMAGE=${run.baseImage}`,
    ...(run.environmentHash === undefined ? [] : ["-e", `SANDBOX_ENVIRONMENT_HASH=${run.environmentHash}`]),
    ...(run.env ?? []).flatMap(([name, value]) => ["-e", `${name}=${value}`]),
    run.image,
];

// Every character that never needs quoting in a POSIX shell word — flags, names, image tags, and NAME=value
// pairs of plain values all match, so the emitted command stays byte-identical to what the scripts always
// wrote and reads at a glance. Anything else (spaces, quotes, $, newlines — a multi-line HOST_SSH_KEY) is
// single-quote escaped, which is precisely the safety the hand-rolled `-e VAR=$value` splices never had.
const PLAIN_WORD = /^[\w@%+=:,./-]+$/;

export const shellQuote = (word: string): string => (PLAIN_WORD.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`);

// The complete `docker run …` line for sh consumers — the text the CLI verb prints and a host shell executes,
// and the text the hosted provider splices into its SSH exec.
export const sandboxRunCommand = (run: SandboxRun): string => ["docker", ...sandboxRunArgv(run).map(shellQuote)].join(" ");
