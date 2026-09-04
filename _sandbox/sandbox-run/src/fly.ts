import { PREVIEW_PORT } from "@intentic/constants";

/* THE HOSTED FLAVOR OF THE RUN CONTRACT, the same sandbox, emitted as a Fly Machine config instead of a
 * docker-run argv.
 *
 * A hosted sandbox is not a container on someone's Docker: the machine IS the box (a microVM booting the
 * sandbox image), so everything docker-shaped in index.ts falls away, no names to derive (the app name is
 * the outer identity), no capabilities to add (a VM's root already has them all), no ports to publish to a
 * host (nothing shares a host with the browser). What remains IS the contract: the image pair, the env pairs
 * in the same canonical order, and one persistent disk.
 *
 * The disk is the shape's one real translation. Docker runs mount three named volumes (/work, /history,
 * /var/lib/docker); a Fly machine mounts exactly one volume, so all three live under FLY_VOLUME_PATH and the
 * entrypoint's VM mode links the canonical paths onto it. That indirection lives HERE and in the entrypoint
 * and nowhere else, the daemon still sees /work and /history, which is what keeps every other flow's
 * assumptions true on this one.
 *
 * THE FRONT DOOR is the shape's other translation, and the one that makes a hosted machine different from
 * every docker-run sandbox in how it is REACHED. A container on somebody's machine dials the platform's edge
 * and serves through a tunnel, because nothing on the internet can dial it. A Fly machine is on the internet
 * already: the edge answers a request for its hostname with a Fly replay (`fly-replay: app=<this app>`), and
 * Fly's proxy delivers the request — and every byte after it — to the service declared below, with no
 * intentic process carrying traffic in between. So the machine declares one service, the preview proxy that
 * is already the container's single front door (it routes `sandbox-<id>`, previews, ports and the outbox by
 * Host), and dials no tunnel at all: its env carries no grant and no edge address. */

// Where the machine's single volume mounts, and the directories the entrypoint carves out of it. Exported so
// the entrypoint contract test and the platform's provisioning read the same words instead of agreeing by
// coincidence.
export const FLY_VOLUME_PATH = "/data";
export const FLY_VOLUME_LAYOUT = {
    workspace: `${FLY_VOLUME_PATH}/work`,
    history: `${FLY_VOLUME_PATH}/history`,
    docker: `${FLY_VOLUME_PATH}/docker`,
} as const;

export interface FlyMachineRun {
    // What the daemon should call itself, the docker flavors pass the container name; hosted passes the app
    // name so logs and the switcher agree with the Fly console.
    readonly name: string;
    readonly image: string;
    // Same two-image story as SandboxRun: what runs, and what overlays compose FROM.
    readonly baseImage: string;
    // The approved overlay's hash when `image` was built from one, stamped as SANDBOX_ENVIRONMENT_HASH so the
    // daemon reports the overlay as applied (SandboxRun carries the same field for the docker lanes).
    readonly environmentHash?: string;
    // The Fly guest, in the platform's config units (memory in MB, shared CPUs, the starter shape).
    readonly guest: { readonly cpus: number; readonly memoryMb: number };
    // The created volume's id (vol_…) this machine mounts at FLY_VOLUME_PATH.
    readonly volumeId: string;
    // Wizard/platform env pairs, already allowlist-filtered where they came from (replayableEnv's stance:
    // empties are dropped here too, an empty secret must not shadow the workspace .env).
    readonly env?: readonly (readonly [string, string])[];
    /* The hostname this machine answers under, which is what declares its front door (the service and the
     * check below). Absent on a warm pool machine: it has no identity yet, its one boot is a no-op that runs
     * nothing, and a service on a machine that listens on nothing is a health check that can only ever fail. */
    readonly frontDoor?: { readonly hostname: string };
}

/* One public-facing service, in the Machines API's own vocabulary. The proxy terminates TLS on 443 under the
 * certificate of whichever app the request ARRIVED at (the edge's wildcard, for a replayed request) and hands
 * plaintext to `internal_port`; 80 exists only to send a plain-http visitor to https. */
export interface FlyMachineService {
    readonly protocol: "tcp";
    readonly internal_port: number;
    /* The platform starts a stopped machine, never the proxy: a wake is where the free lane's hour ceiling is
     * checked (sandbox.routes wake), and a proxy that started machines on arrival would start them past it.
     * The daemon stops the machine itself when idle (its clean exit under the on-failure restart policy), so
     * the proxy's own stop loop stays out of it too. */
    readonly autostart: boolean;
    readonly autostop: "off" | "stop" | "suspend";
    readonly concurrency: { readonly type: "connections" | "requests"; readonly soft_limit: number; readonly hard_limit: number };
    readonly ports: readonly {
        readonly port: number;
        readonly handlers: readonly ("tls" | "http")[];
        readonly force_https?: boolean;
        readonly tls_options?: { readonly alpn: readonly string[] };
    }[];
}

// A named, machine-level check. Fly's proxy routes to a machine only while its checks pass, which is what keeps
// a request off a machine that has started but not yet listened.
export interface FlyMachineCheck {
    readonly type: "http";
    readonly port: number;
    readonly method: "GET";
    readonly path: string;
    readonly interval: string;
    readonly timeout: string;
    readonly grace_period: string;
    readonly headers: readonly { readonly name: string; readonly values: readonly string[] }[];
}

// A file written into the machine before its process starts, in the Machines API's own vocabulary: an
// absolute guest path and the content base64-encoded. How a builder machine receives the Dockerfile it builds.
export interface FlyMachineFile {
    readonly guest_path: string;
    readonly raw_value: string;
}

// The Machines-API `config` object, shaped exactly as POST /apps/{app}/machines expects it.
export interface FlyMachineConfig {
    readonly image: string;
    readonly guest: { readonly cpu_kind: "shared" | "performance"; readonly cpus: number; readonly memory_mb: number };
    readonly env: Record<string, string>;
    readonly mounts: readonly { readonly volume: string; readonly path: string }[];
    /* on-failure is the idle-stop policy's other half: a crash restarts (bounded), while the daemon's clean
     * idle exit stops the machine, which is the whole point of the hosted lane's economics. `no` is for a
     * machine whose exit IS its answer (an overlay build): Fly rerunning a failed build would cost the platform
     * the same failure again and bury the exit code the platform reads. */
    readonly restart: { readonly policy: "on-failure"; readonly max_retries: number } | { readonly policy: "no" };
    // Always false: the platform destroys every machine itself, a sandbox's on delete and a builder once it has
    // read the exit code off the stopped machine, which a machine that destroyed itself no longer has.
    readonly auto_destroy: false;
    /* Replace what the image would run. `flyMachineConfig` never sets it, a sandbox machine runs the image's
     * own entrypoint, but the warm pool's first boot does: a no-op exec pulls the image onto the host and
     * exits clean, so the machine stops holding a warm rootfs and nothing sandbox-shaped ever ran without an
     * identity. Machine updates REPLACE the whole config, so the claim's config (built by flyMachineConfig,
     * no init) is also what erases the override. A builder overrides the entrypoint instead: the platform's
     * build script runs in place of the buildkit image's own daemon. */
    readonly init?: { readonly exec?: readonly string[]; readonly entrypoint?: readonly string[] };
    readonly files?: readonly FlyMachineFile[];
    /* Fly's own key/value bag on a Machine, the only label the provider can be ASKED about, since an app
     * cannot be renamed and a Machine's name is fixed at birth. `flyMachineConfig` never sets it; the hosted
     * lane writes what the machine currently is (warm stock vs. somebody's sandbox) and, because updates
     * replace the whole config, the claim that brands a warm machine re-stamps this in the same call. */
    readonly metadata?: Record<string, string>;
    // The front door (see the header). Present exactly when the run names a hostname to answer under.
    readonly services?: readonly FlyMachineService[];
    readonly checks?: Readonly<Record<string, FlyMachineCheck>>;
}

/* CONNECTIONS, NOT REQUESTS, and the numbers are high on purpose. Fly's default counts in-flight requests, and
 * most of what a sandbox serves never finishes: one /events stream per open browser window, an attach per
 * live agent turn, a terminal, a dev server's HMR socket. Counted as requests they are permanently in flight,
 * a machine walks up to the hard limit, and the proxy stops routing to a daemon that is perfectly healthy —
 * the same trap the edge's own fly.toml names. A few windows and a handful of agents is an ordinary day. */
export const FRONT_DOOR_CONCURRENCY = { type: "connections", soft_limit: 1000, hard_limit: 2000 } as const;

const frontDoorService = (): FlyMachineService => ({
    protocol: "tcp",
    internal_port: PREVIEW_PORT,
    autostart: false,
    autostop: "off",
    concurrency: FRONT_DOOR_CONCURRENCY,
    ports: [
        // h2 first: the browser holds long-lived streams, and HTTP/1.1's six connections per origin is the
        // freeze the editor's stream budget exists to ration around.
        { port: 443, handlers: ["tls", "http"], tls_options: { alpn: ["h2", "http/1.1"] } },
        { port: 80, handlers: ["http"], force_https: true },
    ],
});

/* The daemon's own unauthenticated /health, asked THROUGH the front door under the sandbox's hostname: the
 * preview proxy answers 404 to any Host it does not recognise (by design, a stray subdomain is nobody's), so
 * a check without the header would fail on a healthy machine. The grace period covers the daemon's listen,
 * which comes up before its boot chain (main.ts, "listen first"). */
const frontDoorCheck = (hostname: string): FlyMachineCheck => ({
    type: "http",
    port: PREVIEW_PORT,
    method: "GET",
    path: "/health",
    interval: "15s",
    timeout: "5s",
    grace_period: "10s",
    headers: [{ name: "Host", values: [hostname] }],
});

export const flyMachineConfig = (run: FlyMachineRun): FlyMachineConfig => ({
    image: run.image,
    guest: { cpu_kind: "shared", cpus: run.guest.cpus, memory_mb: run.guest.memoryMb },
    env: Object.fromEntries([
        ["SANDBOX_NAME", run.name],
        ["SANDBOX_IMAGE", run.image],
        ["SANDBOX_BASE_IMAGE", run.baseImage],
        ...(run.environmentHash === undefined ? [] : [["SANDBOX_ENVIRONMENT_HASH", run.environmentHash] as const]),
        // The entrypoint's VM switch: we are the whole machine, count as privileged (nested dockerd on the
        // volume), and the daemon reads it too: a machine is reached through its front door, so it dials no
        // tunnel and orders no loopback certificate (nothing is ever on the same machine as a browser).
        ["SANDBOX_VM", "1"],
        ...(run.env ?? []).filter(([, value]) => value !== ""),
    ]),
    mounts: [{ volume: run.volumeId, path: FLY_VOLUME_PATH }],
    restart: { policy: "on-failure", max_retries: 3 },
    auto_destroy: false,
    ...(run.frontDoor === undefined ? {} : { services: [frontDoorService()], checks: { "front-door": frontDoorCheck(run.frontDoor.hostname) } }),
});

/* THE OTHER MACHINE A HOSTED SANDBOX EVER RUNS: a builder, created in the sandbox's own app to build its
 * approved environment overlay and push the result to the app's registry path, where the sandbox machine
 * boots it from next. The platform is the executor on this lane the way `ic sandbox rebuild` is on a docker
 * host, so the shape is the platform's to compose, and it is a different shape from the sandbox's: no volume,
 * no front door, no restart (the exit code IS the answer), and the recipe delivered as files rather than
 * baked into an image. `performance` CPUs rather than `shared`: a build is minutes of compiler and package
 * manager on a machine that exists for nothing else, and it is billed to the platform, not the owner's hours. */
export interface FlyBuildRun {
    // The buildkit image, pinned by the platform's config.
    readonly image: string;
    readonly guest: { readonly cpus: number; readonly memoryMb: number };
    // Plain text here, base64 on the wire: the Dockerfile, the build script, the registry credential.
    readonly files: readonly { readonly path: string; readonly content: string }[];
    // What the machine runs in place of the image's entrypoint (buildkitd), the platform's build script.
    readonly entrypoint: readonly string[];
    // Empties dropped, the same stance as flyMachineConfig's env.
    readonly env?: readonly (readonly [string, string])[];
}

export const flyBuildMachineConfig = (run: FlyBuildRun): FlyMachineConfig => ({
    image: run.image,
    guest: { cpu_kind: "performance", cpus: run.guest.cpus, memory_mb: run.guest.memoryMb },
    env: Object.fromEntries((run.env ?? []).filter(([, value]) => value !== "")),
    mounts: [],
    restart: { policy: "no" },
    auto_destroy: false,
    init: { entrypoint: [...run.entrypoint] },
    files: run.files.map(({ path, content }) => ({ guest_path: path, raw_value: Buffer.from(content, "utf8").toString("base64") })),
});
