import { PREVIEW_PORT } from "@intentic/constants";

// The hosted flavor of the run contract: same sandbox, emitted as a Fly Machine config instead of docker-run argv. One
// persistent volume replaces docker's three, linked to the canonical paths by the entrypoint's VM mode. Reached via a
// Fly replay to one declared service, the preview proxy, since a Fly machine is already on the internet.

// Where the machine's one volume mounts and the dirs carved from it; exported so the entrypoint test and provisioning
// agree.
export const FLY_VOLUME_PATH = "/data";
export const FLY_VOLUME_LAYOUT = {
    workspace: `${FLY_VOLUME_PATH}/work`,
    history: `${FLY_VOLUME_PATH}/history`,
    docker: `${FLY_VOLUME_PATH}/docker`,
} as const;

export interface FlyMachineRun {
    // What the daemon calls itself: hosted passes the app name, so logs match the Fly console.
    readonly name: string;
    readonly image: string;
    // Same two-image story as SandboxRun: what runs, and what overlays compose from.
    readonly baseImage: string;
    // The approved overlay's hash when `image` was built from one, stamped as SANDBOX_ENVIRONMENT_HASH.
    readonly environmentHash?: string;
    // The Fly guest in the platform's config units: memory in MB, shared CPUs, the starter shape.
    readonly guest: { readonly cpus: number; readonly memoryMb: number };
    // The created volume's id (vol_…) this machine mounts at FLY_VOLUME_PATH.
    readonly volumeId: string;
    // Wizard/platform env pairs, allowlist-filtered; empties dropped too, a secret must not shadow .env.
    readonly env?: readonly (readonly [string, string])[];
    // The hostname this machine answers under; absent on a warm pool machine, whose boot runs nothing at all.
    readonly frontDoor?: { readonly hostname: string };
}

// One public-facing service, in the Machines API's own vocabulary: the proxy terminates TLS on 443 under whichever
// app's certificate the request arrived at, and hands plaintext to internal_port; 80 only redirects to https.
export interface FlyMachineService {
    readonly protocol: "tcp";
    readonly internal_port: number;
    // The platform starts a stopped machine, never the proxy, to respect the free lane's hour cap.
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

// A named, machine-level check; Fly's proxy routes to a machine only while its checks pass.
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

// A file written into the machine before its process starts: an absolute guest path, content base64-encoded.
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
    // on-failure restarts a crash (bounded); idle exit stops it. `no` is for an exit that is the answer.
    readonly restart: { readonly policy: "on-failure"; readonly max_retries: number } | { readonly policy: "no" };
    // Always false: the platform destroys every machine itself, after a builder's exit code is read.
    readonly auto_destroy: false;
    // Overrides the entrypoint: unset for a sandbox, a no-op exec at warm-pool boot, a builder's script.
    readonly init?: { readonly exec?: readonly string[]; readonly entrypoint?: readonly string[] };
    readonly files?: readonly FlyMachineFile[];
    // Fly's own key/value bag on a Machine, the only queryable label since an app can't be renamed.
    readonly metadata?: Record<string, string>;
    // The front door (see the header). Present exactly when the run names a hostname to answer under.
    readonly services?: readonly FlyMachineService[];
    readonly checks?: Readonly<Record<string, FlyMachineCheck>>;
}

// Connections, not requests: most of what a sandbox serves (streams, attaches, HMR) never finishes.
export const FRONT_DOOR_CONCURRENCY = { type: "connections", soft_limit: 1000, hard_limit: 2000 } as const;

const frontDoorService = (): FlyMachineService => ({
    protocol: "tcp",
    internal_port: PREVIEW_PORT,
    autostart: false,
    autostop: "off",
    concurrency: FRONT_DOOR_CONCURRENCY,
    ports: [
        // h2 first: the browser holds long-lived streams; HTTP/1.1 allows only six connections per origin.
        { port: 443, handlers: ["tls", "http"], tls_options: { alpn: ["h2", "http/1.1"] } },
        { port: 80, handlers: ["http"], force_https: true },
    ],
});

// The daemon's own /health, asked through the front door under the sandbox's hostname: the proxy 404s any Host it
// doesn't recognize, so the check needs the header to pass. The grace period covers the daemon's listen-first boot.
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
        // The whole machine, privileged, nested dockerd; the daemon skips a tunnel and loopback cert too.
        ["SANDBOX_VM", "1"],
        ...(run.env ?? []).filter(([, value]) => value !== ""),
    ]),
    mounts: [{ volume: run.volumeId, path: FLY_VOLUME_PATH }],
    restart: { policy: "on-failure", max_retries: 3 },
    auto_destroy: false,
    ...(run.frontDoor === undefined ? {} : { services: [frontDoorService()], checks: { "front-door": frontDoorCheck(run.frontDoor.hostname) } }),
});

// The other machine a hosted sandbox runs: a builder that builds the approved overlay and pushes it to the app's
// registry. No volume, no front door, no restart; minutes are metered like the sandbox's own.
export interface FlyBuildRun {
    // The buildkit image, pinned by the platform's config.
    readonly image: string;
    // CPU kind is the platform's call: shared costs less and is about as fast for a network-bound build.
    readonly guest: { readonly cpuKind: "shared" | "performance"; readonly cpus: number; readonly memoryMb: number };
    // Plain text here, base64 on the wire: the Dockerfile, the build script, the registry credential.
    readonly files: readonly { readonly path: string; readonly content: string }[];
    // What the machine runs in place of the image's entrypoint (buildkitd), the platform's build script.
    readonly entrypoint: readonly string[];
    // Empties dropped, the same stance as flyMachineConfig's env.
    readonly env?: readonly (readonly [string, string])[];
}

export const flyBuildMachineConfig = (run: FlyBuildRun): FlyMachineConfig => ({
    image: run.image,
    guest: { cpu_kind: run.guest.cpuKind, cpus: run.guest.cpus, memory_mb: run.guest.memoryMb },
    env: Object.fromEntries((run.env ?? []).filter(([, value]) => value !== "")),
    mounts: [],
    restart: { policy: "no" },
    auto_destroy: false,
    init: { entrypoint: [...run.entrypoint] },
    files: run.files.map(({ path, content }) => ({ guest_path: path, raw_value: Buffer.from(content, "utf8").toString("base64") })),
});
