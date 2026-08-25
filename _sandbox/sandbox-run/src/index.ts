import { DAEMON_PORT, LOCAL_PORT } from "@intentic/constants";
import { shellQuote } from "./quote.js";

/* THE SANDBOX CONTAINER'S RUN CONTRACT, every way a sandbox starts, composed from one definition.
 *
 * Seven creation paths in four dialects start the sandbox workspace container: the platform provider's
 * docker run over SSH (providers/host/workspace.ts), the compose generator (web setupCompose.ts), and the
 * curl-served/hand-run scripts (connect.sh, connect.ps1, recreate.sh, plus connect.sh's compose sibling).
 * They used to each restate the whole shape, names, volumes, flags, env list, directive allowlist, behind
 * "keep in lockstep" comments, and the lockstep broke exactly the way hand-sync always breaks: SYS_ADMIN
 * reached one path, then five, then all of them, across three commits, while every sandbox created the
 * ordinary way silently lost turn isolation.
 *
 * Now the contract lives here and travels two roads:
 *   - TS consumers (provider, compose generator, the CLI) import it, drift is a compile error.
 *   - The scripts cannot import anything (they are standalone curl|sh files), so they EXECUTE what the
 *     image emits: `intentic sandbox run` (the CLI verb built on this module) prints the full docker-run
 *     command, and the scripts shrink to their flow-specific pre-steps plus "run what the image said".
 *     The contract thereby ships WITH the image, a stale script still runs a new image correctly, which
 *     is the property hand-copied blocks can never have.
 *
 * The guard for the roads themselves is sandbox-run-contract.test.ts (sandbox app): any file in the repo
 * that hand-rolls a docker run mounting /work, instead of importing this module or invoking the verb,
 * fails there by discovery, not by being on a list. */

// --- Names --------------------------------------------------------------------------------------------
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

// --- Posture ------------------------------------------------------------------------------------------
// The Linux capabilities EVERY sandbox container is granted. Scoped to the container, not host access; the
// docker socket is never mounted.
//
// SYS_ADMIN lets the daemon give each isolated agent turn its own mount namespace, with the conversation's
// worktree standing in for /work (sandbox app agents/isolation.ts).
//
// SYS_PTRACE is for diagnosing the daemon in the only place it ever misbehaves: production. When the event loop
// freezes, the question is always "what is PID 1 blocked in", and answering it needs a stack, but /proc/1/stack,
// /proc/1/syscall, strace and gdb all require PTRACE_MODE_ATTACH, and yama's ptrace_scope only ever permits a
// DESCENDANT to attach. The daemon is the ANCESTOR of every shell an agent can open, so without this the one
// process worth inspecting is the one process that cannot be. A stall that took days to attribute (an 8s
// blocking reverse-DNS lookup per connected peer) would have been a single backtrace. The exposure is small
// where it is granted: everything in this container already runs as root with SYS_ADMIN, and ptrace is confined
// to the container's own PID namespace. It stays OUT of RUNTIME_DIRECTIVES below, the platform grants this to
// its own daemon, and an owner-authored overlay still may not ask for it.
export const SANDBOX_CAPABILITIES = ["SYS_ADMIN", "SYS_PTRACE"] as const;

/* A LOCAL SANDBOX GETS THE MACHINE, MINUS WHAT THE HOST NEEDS TO STAY ALIVE. The workspace is deliberately
 * broad inside the container (compilers, browsers, local models, whole monorepo test runs), and every attempt
 * to bound it by a defensive fraction of the machine has produced the same result: a box that freezes on the
 * work it exists to run. The 35% share this replaced derived 6 GiB on the 20 GiB WSL guest this repo develops
 * on — a figure its own comments conceded "a turbo fan-out plus a handful of live agent sessions does not
 * fit" — and the 10 GiB its owner widened it to still pinned solid under one pre-push test run. The sandbox
 * is the machine's primary workload; it is sized like one. What the host keeps is a fixed reserve (below),
 * not the larger share of its own RAM.
 *
 * THIS IS THE FALLBACK, for a caller that cannot measure its machine. Conservative because it is applied
 * blind — a 16g cap handed to an 8 GiB machine is an unbounded container with extra steps. Every flow that
 * CAN measure passes `memory` instead, from localSandboxMemory() below, and gets the machine-sized figure.
 *
 * Hosted providers own their machine sizing separately and opt out through their existing `init: false`
 * shape, which is also why this cap only ever governs the local shape. */
export const LOCAL_SANDBOX_MEMORY = "7g";

const GIB = 1024 ** 3;
/* WHAT THE HOST KEEPS, and the point below which a cap breaks the workload it applies to.
 *
 * The reserve covers what must stay responsive OUTSIDE the cgroup while the sandbox works: the host distro's
 * own processes (the sync agent, the editor tooling, an owner's dev server), docker, and the sibling
 * containers (postgres, the tunnel). 3 GiB is what those actually sum to on the guest this was measured on,
 * with margin; everything above it belongs to the sandbox. The 4 GiB floor is the point below which the cap
 * stops protecting anything and starts breaking the image's own toolchain (compilers, a browser, local
 * models) — a machine too small to grant it gets the floor anyway and the reserve gives way. */
const SANDBOX_MEMORY_RESERVE = 3 * GIB;
const SANDBOX_MEMORY_FLOOR = 4 * GIB;
/* SWAP IS UNBOUNDED, docker's `-1`: the cgroup pages into whatever swap the engine's kernel has.
 *
 * The no-swap doctrine this reverses promised that an overrun "resolves in milliseconds: the cgroup OOM
 * killer takes the largest process". Measured on 2026-08-25, it does not. A 10 GiB no-swap cgroup pinned to
 * within 12 KB of its ceiling recorded 1.05M allocation stalls, PSI `memory full avg10=96.9`, a daemon event
 * loop lag of 352 SECONDS — and `oom_kill 0`. The kill never comes because a node-heavy tree is mostly
 * FILE-BACKED memory: mapped binaries and page cache are always reclaimable, so the kernel serves every
 * allocation by evicting hot executable pages and faulting them straight back, and the cgroup livelocks
 * below its ceiling without ever declaring OOM. Refusing swap did not buy the loud crash; it only forbade
 * anonymous pages the one overflow that degrades gracefully. `docker exec` could not schedule `cat` inside
 * 120s — the failure mode the doctrine was written to prevent, delivered by the doctrine.
 *
 * So the runaway is not contained here, at the cgroup, where the only tools are the two bad ones (thrash or
 * kill). It is contained at the SOURCES that create the memory: turbo.json's `concurrency` bounds the task
 * fan-out, the vitest configs bound each run's worker pool, and the daemon refuses new work on a pinned box
 * by measuring its own cgroup's PSI (platform/memory-admission.ts). The cap then only has to catch what
 * slips past all of that, and with swap under it a peak means minutes of slow instead of a frozen box. */
export const SANDBOX_MEMORY_SWAP = "-1";

// The docker string for a chosen cap. Split out because a derived share and an explicit ask agree on
// everything downstream of "how many bytes": the rounding, and the `<n>g` spelling.
const capString = (capBytes: number): string => `${Math.max(1, Math.floor(capBytes / GIB))}g`;

/* An owner's explicit cap, in bytes, held inside the same bounds the derived one is.
 *
 * Whole GiB only, `<n>g`, the SAME spelling this module emits, so the figure a person reads out of `docker
 * inspect` is the figure they can write back. Anything else THROWS rather than quietly falling through to the
 * derived cap: an override that silently reverts leaves an owner believing they hold headroom they do not,
 * which is exactly the invisible drift runtimeDirectivesOf refuses, for the same reason.
 *
 * Bounded above by the same machine-minus-reserve the derived cap answers, because a cap the machine cannot
 * physically honour is not headroom, it is an unbounded container wearing a number. An UNMEASURABLE machine
 * still honours the ask as typed — a caller that could not read /proc/meminfo knows strictly less about the
 * machine than the person who typed a number into it. */
const overrideCapBytes = (override: string, totalBytes: number): number => {
    const asked = /^(\d+)g$/u.exec(override.trim());
    if (asked === null) {
        throw new Error(`SANDBOX_MEMORY must be whole GiB spelled '<n>g' (e.g. '10g'), got '${override}'`);
    }
    const askedBytes = Math.max(Number(asked[1]) * GIB, SANDBOX_MEMORY_FLOOR);
    const measured = Number.isFinite(totalBytes) && totalBytes > 0;
    return measured ? Math.min(askedBytes, Math.max(totalBytes - SANDBOX_MEMORY_RESERVE, SANDBOX_MEMORY_FLOOR)) : askedBytes;
};

/* THE PER-MACHINE CAP, as docker's `<n>g` string, derived from the memory the docker engine actually has:
 * everything the machine holds, minus the fixed reserve the host keeps. Swap is not derived from it —
 * `--memory-swap` is always SANDBOX_MEMORY_SWAP (see the doctrine above), so there is still only one number.
 *
 * Pure arithmetic on a byte count, deliberately: this module stays importable by a browser (see README), so it
 * cannot read /proc/meminfo itself. The caller that can — `intentic sandbox run-command`, which runs INSIDE an
 * uncapped probe container, where /proc/meminfo reports the engine's VM or host total — reads it and calls this,
 * so the policy still lives in one place and is tested without a machine to measure.
 *
 * A total of 0 or less means the caller could not measure, and gets the fallback constant rather than a cap
 * derived from a lie. The cap rounds DOWN, away from breaking something: a cap that rounded up would grant
 * bytes the machine does not have.
 *
 * `override` is the sandbox's own SANDBOX_MEMORY, replayed off the container being replaced (REPLAY_ENV). When
 * set it REPLACES the derived cap rather than raising a floor under it: the point is an owner who knows their
 * machine better than the reserve does, and that includes knowing when to ask for LESS. See overrideCapBytes
 * for what an ask may claim and why a malformed one stops the recreate. */
export const localSandboxMemory = (totalBytes: number, override?: string): string => {
    // Empty is ABSENT, not invalid: replayableEnv drops empty values, so an unset cap arrives either way.
    if (override !== undefined && override.trim() !== "") {
        return capString(overrideCapBytes(override, totalBytes));
    }
    if (!Number.isFinite(totalBytes) || totalBytes <= 0) {
        return LOCAL_SANDBOX_MEMORY;
    }
    return capString(Math.max(totalBytes - SANDBOX_MEMORY_RESERVE, SANDBOX_MEMORY_FLOOR));
};

// Extra privileges ride in ONLY through "# intentic:runtime" directive lines in the owner-approved overlay
// (the vpn's WireGuard needs tun + NET_ADMIN; the docker capability's isolated nested engine needs
// --privileged, and its optional GPU passthrough needs --gpus), allowlisted hard so an overlay can't smuggle
// arbitrary docker flags.
//
// `--gpus=all` in the `=` spelling, not the `--gpus all` docker also accepts: directive lines are split on
// whitespace, so the spaced form would arrive as two tokens, and `all` on its own is indistinguishable from a
// stray word, the allowlist would have to permit a bare `all` for every flag on the list.
export const RUNTIME_DIRECTIVE_PREFIX = "# intentic:runtime ";
export const RUNTIME_DIRECTIVES = ["--device=/dev/net/tun", "--cap-add=NET_ADMIN", "--privileged", "--gpus=all"] as const;

/* --- Directives a HOST may not be able to honour --------------------------------------------------------
 *
 * Most directives are all-or-nothing: without tun the VPN capability is dead, without --privileged dockerd is,
 * so a host that refuses them has broken the thing that asked and the launch should fail loudly. A few are not
 * like that, the sandbox without them is an ordinary working sandbox, just missing one extra. Those must be
 * PREFLIGHTED and dropped instead, because `docker run` refuses the whole container over one flag it can't
 * satisfy, and trading a person's entire sandbox for a GPU they might not even be using is the wrong trade.
 *
 * This table is that list, as DATA, because the preflight has to happen in four dialects: recreate.sh, the
 * SSH provider, and whatever comes next. The first version of this hard-coded one token across five files,
 * a constant, a boolean input, a CLI flag, and two hand-written probes, which is precisely the per-flow
 * duplication this whole module exists to end. Now a new one is a row here plus a fragment that emits it.
 *
 * `probe` is a small closed vocabulary, not shell: the host-side flows include a curl|sh script, and a table
 * that could inject arbitrary commands into it would be a table worth attacking. Two kinds cover what a host
 * can be asked:
 *   - "runtime": docker's own runtime list names it (the nvidia container runtime registering itself).
 *   - "device":  a device node exists on the host.
 * A THIRD kind is a change to every host-side interpreter, which is the point at which one should ask whether
 * the directive is really optional or the flow should just fail.
 *
 * Note what is NOT here, and why the list is one row rather than four: under --privileged the container gets
 * the host's /dev wholesale, so /dev/kvm, /dev/dri and /dev/fuse need no directive at all in a sandbox that
 * runs the docker capability. GPU is the exception because --gpus is not device exposure, it is the nvidia
 * runtime injecting the host's driver LIBRARIES (libcuda, libnvidia-ml) and registering itself, which
 * privilege alone never does. A future capability that needs a device on an UNPRIVILEGED sandbox (an emulator
 * wanting /dev/kvm) is the row that joins it. */
export interface OptionalDirective {
    // The allowlisted token, exactly as it appears in RUNTIME_DIRECTIVES.
    readonly token: string;
    // What to call it when telling a person it was dropped.
    readonly name: string;
    // The container env var stamping what became of the ask: "all" when the flag rode, "unsupported" when the
    // host could not. Absent entirely when nothing asked, which is a third state, not a synonym for "no".
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

// The allowlisted runtime tokens of an overlay, or a throw naming the first token that is not, an unknown
// directive is either a typo'd capability fragment or an escape attempt, and both must stop the recreate
// rather than be skipped into a sandbox that silently lacks (or exceeds) its privileges.
//
// DEDUPED, first appearance wins: two capabilities may legitimately ask for the same grant (the docker card's
// GPU option and a local model's both emit `--gpus=all`), and docker run accepts `--privileged` twice but not
// every repeated flag, so the emitters downstream must never see one token per asker.
export const runtimeDirectivesOf = (overlay: string): string[] => {
    const tokens = new Set<string>();
    for (const line of overlay.split("\n")) {
        if (!line.startsWith(RUNTIME_DIRECTIVE_PREFIX)) {
            continue;
        }
        for (const token of line.slice(RUNTIME_DIRECTIVE_PREFIX.length).trim().split(/\s+/)) {
            if (!(RUNTIME_DIRECTIVES as readonly string[]).includes(token)) {
                throw new Error(`unsupported runtime directive '${token}' in the approved overlay`);
            }
            tokens.add(token);
        }
    }
    return [...tokens];
};

// --- Env ----------------------------------------------------------------------------------------------
/* The vars a recreate replays from the running container, the union of what every creator sets, in one
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
    // The sandbox's reachability grant on the self-hosted hub, replayed like every other identity value, so
    // a recreated container re-enables as the SAME zrok environment and re-attaches the same public names.
    "ZROK_TOKEN",
    "ZROK_API",
    "ZROK_NAMESPACE",
    "CLOUDFLARE_API_TOKEN",
    "HOST_SSH_KEY",
    "SELF_HOST_USER",
    "SYNC_PAIR_TOKEN",
    // The connected-computer seed. It describes the MACHINE, which a recreate does not move off, and the
    // daemon cannot re-derive any of it from inside the container, dropping it here unpairs the computer.
    "HOST_PAIR_TOKEN",
    "HOST_PLATFORM",
    "HOST_LABEL",
    "SELF_HOST_ADDRESS",
    "SELF_HOST_VIA",
    /* THE OWNER'S EXPLICIT CGROUP CAP, for a machine the derived share is wrong about (localSandboxMemory).
     *
     * Replayed, and so emitted again as `-e SANDBOX_MEMORY=` onto the very container it sizes, which is what
     * makes it stick: the number lives ON the sandbox, so every later recreate reads back the figure its owner
     * chose instead of re-deriving the share they already rejected. This is the property that separates it from
     * the obvious alternative — `docker update --memory` retunes a running container and is silently discarded
     * by the next recreate, which is how an owner ends up re-widening the same cgroup after every rebuild.
     *
     * Unlike SANDBOX_CHANNEL and the directive-fate vars above, this one SHOULD outlive the run that set it: it
     * describes the machine's standing arrangement with its owner, not a decision the runner makes per launch. */
    "SANDBOX_MEMORY",
    /* A RUNNER's identity seed (the runner mode of the daemon, sandbox/src/runners/): which parent sandbox
     * this container belongs to, and the single-use pairing it redeems on first boot. Replayed for the host
     * seed's reason — a recreate does not move the container off its parent, and the daemon cannot re-derive
     * either value from inside. The pairing is burned at the parent on first redemption, so the copy a
     * recreate replays is inert, exactly like HOST_PAIR_TOKEN above. */
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

// The pairs a recreate actually replays: allowlisted, empties dropped (an empty secret var would shadow the
// value the user writes to the workspace .env, recreating also heals a container that carried one), in
// REPLAY_ENV's canonical order so the emitted command is deterministic.
export const replayableEnv = (pairs: readonly (readonly [string, string])[]): [string, string][] =>
    REPLAY_ENV.flatMap((name) => {
        const value = pairs.find(([key]) => key === name)?.[1];
        return value === undefined || value === "" ? [] : [[name, value] as [string, string]];
    });

// --- Health -------------------------------------------------------------------------------------------
// A container that starts but crash-loops must not read as success, every flow gates on the daemon's own
// /health with the same patience before declaring the sandbox up.
export const HEALTH = { url: `http://localhost:${DAEMON_PORT}/health`, attempts: 15, intervalSeconds: 2 } as const;

// --- The loopback shortcut ----------------------------------------------------------------------------
/* A sandbox running on the SAME machine as the browser does not need Cloudflare in the middle: the container
 * publishes its daemon port on the host's loopback, and the browser dials that instead of the tunnel. Nobody
 * announces the address, the browser DERIVES it from the sandbox id it already holds (the leading label of
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
 * two collide anyway (or that something else already holds the port) is what `localPublish: false` is for,
 * the publish is the only part of the run that may fail without the sandbox being broken, so every flow
 * retries without it rather than failing the launch. */
const LOCAL_PORT_BASE = 28000;
const LOCAL_PORT_SPAN = 4000;

// The host loopback port a sandbox with this 12-hex id publishes its LOOPBACK LISTENER on (container-side
// LOCAL_PORT, never the tunnel's DAEMON_PORT, see @intentic/constants for why the two are separate).
// Deterministic, so a recreate lands on the same port and the browser can derive it without being told.
export const localDaemonPort = (sandboxId: string): number => LOCAL_PORT_BASE + (Number.parseInt(sandboxId.slice(0, 6), 16) % LOCAL_PORT_SPAN);

/* The two addresses that port can answer on, best first, what the browser probes.
 *
 * HTTPS when the daemon has obtained a certificate for `local-<id>.<zone>` (a public name resolving to
 * 127.0.0.1). Every browser accepts that, including Safari, which refuses http loopback from an HTTPS page as
 * mixed content. Plain http is the fallback the daemon serves before a certificate exists, or forever if
 * issuance is unavailable, the mixed-content spec calls loopback potentially-trustworthy, so Chrome and
 * Firefox take it. Neither is assumed: the browser tries both and the daemon's identity decides. */
export const localDaemonUrl = (sandboxId: string, zone: string | undefined): string | undefined =>
    zone === undefined || zone === "" ? undefined : `https://local-${sandboxId}.${zone}:${localDaemonPort(sandboxId)}`;

export const localDaemonUrlInsecure = (sandboxId: string): string => `http://127.0.0.1:${localDaemonPort(sandboxId)}`;

// --- The run ------------------------------------------------------------------------------------------
export interface SandboxRun {
    readonly names: SandboxNames;
    readonly image: string;
    // What the daemon keeps composing overlays against (SANDBOX_BASE_IMAGE), the official tag, or the dev
    // tag a dev swap pins so a later recompose doesn't flip the base back to :stable.
    readonly baseImage: string;
    // The approved overlay's hash, when the image was built from one, stamps SANDBOX_ENVIRONMENT_HASH so
    // the daemon's recompose check stays quiet.
    readonly environmentHash?: string;
    /* WHICH RELEASE CHANNEL this sandbox follows, and what it was on before the swap that made it, set by
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
    /* The local shape's cgroup cap, as a docker `<n>g` string, from localSandboxMemory() against the engine's
     * real memory. Omitted by a caller that could not measure its machine, which then gets LOCAL_SANDBOX_MEMORY.
     * Ignored entirely by the hosted shape (`init: false`), which carries no cap at all.
     *
     * There is no companion swap field: `--memory-swap` is always SANDBOX_MEMORY_SWAP (unbounded, see the
     * doctrine above), never a per-run figure. One field, nothing to keep in lockstep. */
    readonly memory?: string;
    // Hosted-provider extras: -p specs, --label key=values, --dns resolvers.
    readonly ports?: readonly string[];
    readonly labels?: readonly string[];
    readonly dns?: readonly string[];
    // The sandbox's 12-hex id (sandboxIdFromToken of its connect token), what the loopback port derives from.
    // Absent on a sandbox with no connect token (a bare dev run), which therefore publishes nothing.
    readonly sandboxId?: string;
    // Publish the loopback shortcut. Default true wherever a `sandboxId` is known; set false to retry a launch
    // that docker refused because the derived port was already allocated (see localDaemonPort).
    readonly localPublish?: boolean;
    /* Which OPTIONAL_DIRECTIVES this host failed its probe for, the creation flows' preflight answer, since
     * they are the only code that can ask a host anything. Each named token is dropped from the run and the
     * sandbox starts without it (see OPTIONAL_DIRECTIVES for why that beats failing the launch).
     *
     * Either way the ASK is stamped as the directive's env var, which is what makes the daemon's story honest:
     * from inside the container "the overlay hasn't been built yet" and "this host cannot" are the same absent
     * hardware, and only the runner can tell them apart. Those vars stay out of REPLAY_ENV for the reason
     * SANDBOX_IMAGE does, the runner decides per run, and replaying would pin a sandbox to the answer its
     * first host gave, so a machine that later grows a GPU could never say so. */
    readonly unsupported?: readonly string[];
    // The hosted provider runs without --init or the network alias (no tunnel sidecar shares its network);
    // every local flow has both. Defaults are the local shape.
    readonly init?: boolean;
    readonly alias?: boolean;
}

// The `docker …` argv for a sandbox container, ordered the way connect.sh always wrote it. One builder for
// every dialect: sh consumers quote it (sandboxRunCommand), PowerShell splats it as an array, the provider
// joins it into its SSH line.
export const sandboxRunArgv = (run: SandboxRun): string[] => {
    /* Each optional ask and its fate, resolved once from the two things the caller already has: the directives
     * it read out of the overlay, and the tokens its preflight came back unhappy about. No flow filters a
     * token or stamps an env var itself, the same choice the rest of this module makes, for the same reason.
     * A directive not in the table is untouched: everything else is all-or-nothing and stays that way. */
    const asked = OPTIONAL_DIRECTIVES.filter((entry) => (run.runtime ?? []).includes(entry.token));
    const dropped = new Set(asked.filter((entry) => (run.unsupported ?? []).includes(entry.token)).map((entry) => entry.token));
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
        // `--memory-swap -1` rides with every cap: the cgroup may page into whatever swap the engine has, so
        // a peak that clears the cap degrades into paging instead of a reclaim livelock (doctrine above).
        ...(run.init === false ? [] : ["--memory", run.memory ?? LOCAL_SANDBOX_MEMORY, "--memory-swap", SANDBOX_MEMORY_SWAP]),
        ...SANDBOX_CAPABILITIES.map((cap) => `--cap-add=${cap}`),
        ...(run.runtime ?? []).filter((token) => !dropped.has(token)),
        ...(run.ports ?? []).flatMap((port) => ["-p", port]),
        ...(run.sandboxId !== undefined && run.localPublish !== false ? ["-p", `127.0.0.1:${localDaemonPort(run.sandboxId)}:${LOCAL_PORT}`] : []),
        "-v",
        `${run.names.workspaceVolume}:/work`,
        // /history is never optional: it holds the fleet registry, transcripts, every repo's real git dir and
        // the checkpoints (sandbox-contract's history-state.ts). A sandbox recreated without it comes back
        // with an empty agent board and a /work full of dangling gitdir pointers, which is how the hosted
        // flavor lost its users' history on every update until this volume stopped being skippable.
        "-v",
        `${run.names.historyVolume}:/history`,
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
        ...asked.flatMap((entry) => ["-e", `${entry.env}=${dropped.has(entry.token) ? "unsupported" : "all"}`]),
        ...(run.env ?? []).flatMap(([name, value]) => ["-e", `${name}=${value}`]),
        run.image,
    ];
};

// The complete `docker run …` line for sh consumers, the text the CLI verb prints and a host shell executes,
// and the text the hosted provider splices into its SSH exec.
export const sandboxRunCommand = (run: SandboxRun): string => ["docker", ...sandboxRunArgv(run).map(shellQuote)].join(" ");
