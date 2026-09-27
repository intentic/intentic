import type { HostedShape } from "@intentic/constants";

// The hosted flavor of the run contract: same sandbox, emitted as a Fly Machine config instead of docker-run argv. One
// persistent volume replaces docker's three, linked to the canonical paths by the entrypoint's VM mode. It declares no
// service: the machine is reached only down the tunnel its daemon dials to the edge, like every other sandbox, so
// nothing on Fly routes to it.

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
    // The guest this machine runs as, which rung it is on decides; `volumeGb` of the shape is the volume's, set when
    // the volume is created or extended rather than here.
    readonly guest: Omit<HostedShape, "volumeGb">;
    // The created volume's id (vol_…) this machine mounts at FLY_VOLUME_PATH.
    readonly volumeId: string;
    // Wizard/platform env pairs, allowlist-filtered; empties dropped too, a secret must not shadow .env.
    readonly env?: readonly (readonly [string, string])[];
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
}

export const flyMachineConfig = (run: FlyMachineRun): FlyMachineConfig => ({
    image: run.image,
    guest: { cpu_kind: run.guest.cpuKind, cpus: run.guest.cpus, memory_mb: run.guest.memoryMb },
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
});

// The other machine a hosted sandbox runs: a builder that builds the approved overlay and pushes it to the app's
// registry. No volume, no restart; minutes are metered like the sandbox's own.
export interface FlyBuildRun {
    // The buildkit image, pinned by the platform's config.
    readonly image: string;
    // CPU kind is the platform's call: shared costs less and is about as fast for a network-bound build.
    readonly guest: Omit<HostedShape, "volumeGb">;
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
