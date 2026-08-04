import { DAEMON_PORT, LOCAL_PORT } from "@intentic/constants";

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
// The Linux capabilities EVERY sandbox container is granted. Scoped to the container — not host access; the
// docker socket is never mounted.
//
// SYS_ADMIN lets the daemon give each isolated agent turn its own mount namespace, with the conversation's
// worktree standing in for /work (sandbox app agents/isolation.ts).
//
// SYS_PTRACE is for diagnosing the daemon in the only place it ever misbehaves: production. When the event loop
// freezes, the question is always "what is PID 1 blocked in", and answering it needs a stack — but /proc/1/stack,
// /proc/1/syscall, strace and gdb all require PTRACE_MODE_ATTACH, and yama's ptrace_scope only ever permits a
// DESCENDANT to attach. The daemon is the ANCESTOR of every shell an agent can open, so without this the one
// process worth inspecting is the one process that cannot be. A stall that took days to attribute (an 8s
// blocking reverse-DNS lookup per connected peer) would have been a single backtrace. The exposure is small
// where it is granted: everything in this container already runs as root with SYS_ADMIN, and ptrace is confined
// to the container's own PID namespace. It stays OUT of RUNTIME_DIRECTIVES below — the platform grants this to
// its own daemon, and an owner-authored overlay still may not ask for it.
export const SANDBOX_CAPABILITIES = ["SYS_ADMIN", "SYS_PTRACE"] as const;

// Extra privileges ride in ONLY through "# intentic:runtime" directive lines in the owner-approved overlay
// (the vpn's WireGuard needs tun + NET_ADMIN; the docker capability's isolated nested engine needs
// --privileged, and its optional GPU passthrough needs --gpus), allowlisted hard so an overlay can't smuggle
// arbitrary docker flags.
//
// `--gpus=all` in the `=` spelling, not the `--gpus all` docker also accepts: directive lines are split on
// whitespace, so the spaced form would arrive as two tokens, and `all` on its own is indistinguishable from a
// stray word — the allowlist would have to permit a bare `all` for every flag on the list.
export const RUNTIME_DIRECTIVE_PREFIX = "# intentic:runtime ";
export const RUNTIME_DIRECTIVES = ["--device=/dev/net/tun", "--cap-add=NET_ADMIN", "--privileged", "--gpus=all"] as const;
// The one directive a host may be unable to honour, and the only one whose absence leaves a WORKING sandbox:
// missing tun or --privileged means the capability that asked for it is dead, but a GPU-less sandbox is an
// ordinary sandbox. So the creation paths preflight it and drop it rather than failing the launch — see
// recreate.sh's NO_GPU and the workspace provider's gpuSupported.
export const GPU_DIRECTIVE = "--gpus=all";

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

// ——— The loopback shortcut ————————————————————————————————————————————————————————————————————————————
/* A sandbox running on the SAME machine as the browser does not need Cloudflare in the middle: the container
 * publishes its daemon port on the host's loopback, and the browser dials that instead of the tunnel. Nobody
 * announces the address — the browser DERIVES it from the sandbox id it already holds (the leading label of
 * the public URL) using the two builders below, and proves it reached the right daemon by matching the id
 * /health answers with. That is why this is a pure derivation and not a wire field: an address that is only
 * meaningful on one machine has no business in the platform's registry, which serves every machine.
 *
 * Loopback, never 0.0.0.0. The daemon authenticates every route but /health, but CORS is not a boundary and a
 * LAN-exposed daemon is a wider target than this optimization is worth.
 *
 * The band is chosen to be quiet: above the range dev servers and databases claim by default, and below
 * Linux's ephemeral floor (32768), so the derived port collides with neither an app the user is running nor a
 * socket the kernel hands out. Two sandboxes on one machine derive different ports; the ~1-in-4000 chance that
 * two collide anyway (or that something else already holds the port) is what `localPublish: false` is for —
 * the publish is the only part of the run that may fail without the sandbox being broken, so every flow
 * retries without it rather than failing the launch. */
const LOCAL_PORT_BASE = 28000;
const LOCAL_PORT_SPAN = 4000;

// The host loopback port a sandbox with this 12-hex id publishes its LOOPBACK LISTENER on (container-side
// LOCAL_PORT, never the tunnel's DAEMON_PORT — see @intentic/constants for why the two are separate).
// Deterministic, so a recreate lands on the same port and the browser can derive it without being told.
export const localDaemonPort = (sandboxId: string): number => LOCAL_PORT_BASE + (Number.parseInt(sandboxId.slice(0, 6), 16) % LOCAL_PORT_SPAN);

/* The two addresses that port can answer on, best first — what the browser probes.
 *
 * HTTPS when the daemon has obtained a certificate for `local-<id>.<zone>` (a public name resolving to
 * 127.0.0.1). Every browser accepts that, including Safari, which refuses http loopback from an HTTPS page as
 * mixed content. Plain http is the fallback the daemon serves before a certificate exists, or forever if
 * issuance is unavailable — the mixed-content spec calls loopback potentially-trustworthy, so Chrome and
 * Firefox take it. Neither is assumed: the browser tries both and the daemon's identity decides. */
export const localDaemonUrl = (sandboxId: string, zone: string | undefined): string | undefined =>
    zone === undefined || zone === "" ? undefined : `https://local-${sandboxId}.${zone}:${localDaemonPort(sandboxId)}`;

export const localDaemonUrlInsecure = (sandboxId: string): string => `http://127.0.0.1:${localDaemonPort(sandboxId)}`;

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
    /* WHICH RELEASE CHANNEL this sandbox follows, and what it was on before the swap that made it — set by
     * recreate.sh, which owns both facts (it is the thing on the host doing the swapping).
     *
     * Here rather than in the replay allowlist below for the same reason SANDBOX_IMAGE is: they are decided
     * per run by the runner, so replaying the OLD container's values would pin a sandbox to the channel it was
     * created on forever and make its rollback target permanently the same one. */
    readonly channel?: string;
    readonly previousImage?: string;
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
    // The sandbox's 12-hex id (sandboxIdFromToken of its connect token) — what the loopback port derives from.
    // Absent on a sandbox with no connect token (a bare dev run), which therefore publishes nothing.
    readonly sandboxId?: string;
    // Publish the loopback shortcut. Default true wherever a `sandboxId` is known; set false to retry a launch
    // that docker refused because the derived port was already allocated (see localDaemonPort).
    readonly localPublish?: boolean;
    /* Whether the HOST's docker can honour the GPU directive, when the overlay carries one — the creation
     * flows' preflight answer, since they are the only code that can ask that docker anything. False drops the
     * flag and starts the sandbox anyway (GPU_DIRECTIVE explains why that is the right trade).
     *
     * Either way the ASKED-FOR state is stamped as SANDBOX_GPU, which is what makes the daemon's story honest:
     * from inside the container, "the overlay hasn't been built yet" and "this host has no nvidia runtime"
     * are the same absent device, and only the runner can tell them apart. Not in REPLAY_ENV for the reason
     * SANDBOX_IMAGE isn't — the runner decides it per run, and replaying it would pin a sandbox to the answer
     * its first host gave. */
    readonly gpuSupported?: boolean;
    // The hosted provider runs without a /history volume, --init, or the network alias (no tunnel sidecar
    // shares its network); every local flow has all three. Defaults are the local shape.
    readonly history?: boolean;
    readonly init?: boolean;
    readonly alias?: boolean;
}

// The `docker …` argv for a sandbox container, ordered the way connect.sh always wrote it. One builder for
// every dialect: sh consumers quote it (sandboxRunCommand), PowerShell splats it as an array, the provider
// joins it into its SSH line.
export const sandboxRunArgv = (run: SandboxRun): string[] => {
    // The GPU ask and its fate, resolved once: a caller passes the directives it read and the answer its
    // preflight got, and never has to filter the token or stamp the env itself. Doing it here is the same
    // choice the rest of this module makes — a shape every flow must get identical belongs in one place.
    const askedForGpu = (run.runtime ?? []).includes(GPU_DIRECTIVE);
    const gpuDropped = askedForGpu && run.gpuSupported === false;
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
        ...SANDBOX_CAPABILITIES.map((cap) => `--cap-add=${cap}`),
        ...(run.runtime ?? []).filter((token) => !(gpuDropped && token === GPU_DIRECTIVE)),
        ...(run.ports ?? []).flatMap((port) => ["-p", port]),
        ...(run.sandboxId !== undefined && run.localPublish !== false ? ["-p", `127.0.0.1:${localDaemonPort(run.sandboxId)}:${LOCAL_PORT}`] : []),
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
        ...(run.channel === undefined ? [] : ["-e", `SANDBOX_CHANNEL=${run.channel}`]),
        ...(run.previousImage === undefined ? [] : ["-e", `SANDBOX_PREVIOUS_IMAGE=${run.previousImage}`]),
        ...(askedForGpu ? ["-e", `SANDBOX_GPU=${gpuDropped ? "unsupported" : "all"}`] : []),
        ...(run.env ?? []).flatMap(([name, value]) => ["-e", `${name}=${value}`]),
        run.image,
    ];
};

// Every character that never needs quoting in a POSIX shell word — flags, names, image tags, and NAME=value
// pairs of plain values all match, so the emitted command stays byte-identical to what the scripts always
// wrote and reads at a glance. Anything else (spaces, quotes, $, newlines — a multi-line HOST_SSH_KEY) is
// single-quote escaped, which is precisely the safety the hand-rolled `-e VAR=$value` splices never had.
const PLAIN_WORD = /^[\w@%+=:,./-]+$/;

export const shellQuote = (word: string): string => (PLAIN_WORD.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`);

// The complete `docker run …` line for sh consumers — the text the CLI verb prints and a host shell executes,
// and the text the hosted provider splices into its SSH exec.
export const sandboxRunCommand = (run: SandboxRun): string => ["docker", ...sandboxRunArgv(run).map(shellQuote)].join(" ");
