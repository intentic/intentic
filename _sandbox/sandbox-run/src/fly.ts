/* THE HOSTED FLAVOR OF THE RUN CONTRACT — the same sandbox, emitted as a Fly Machine config instead of a
 * docker-run argv.
 *
 * A hosted sandbox is not a container on someone's Docker: the machine IS the box (a microVM booting the
 * sandbox image), so everything docker-shaped in index.ts falls away — no names to derive (the app name is
 * the outer identity), no capabilities to add (a VM's root already has them all), no ports to publish
 * (nothing shares a host with the browser), no tunnel sidecar to alias (cloudflared runs inside, see
 * SANDBOX_VM below). What remains IS the contract: the image pair, the env pairs in the same canonical
 * order, and one persistent disk.
 *
 * The disk is the shape's one real translation. Docker runs mount three named volumes (/work, /history,
 * /var/lib/docker); a Fly machine mounts exactly one volume, so all three live under FLY_VOLUME_PATH and the
 * entrypoint's VM mode links the canonical paths onto it. That indirection lives HERE and in the entrypoint
 * and nowhere else — the daemon still sees /work and /history, which is what keeps every other flow's
 * assumptions true on this one. */

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
    // What the daemon should call itself — the docker flavors pass the container name; hosted passes the app
    // name so logs and the switcher agree with the Fly console.
    readonly name: string;
    readonly image: string;
    // Same two-image story as SandboxRun: what runs, and what overlays compose FROM.
    readonly baseImage: string;
    // The Fly guest, in the platform's config units (memory in MB, shared CPUs — the starter shape).
    readonly guest: { readonly cpus: number; readonly memoryMb: number };
    // The created volume's id (vol_…) this machine mounts at FLY_VOLUME_PATH.
    readonly volumeId: string;
    // Wizard/platform env pairs, already allowlist-filtered where they came from (replayableEnv's stance:
    // empties are dropped here too — an empty secret must not shadow the workspace .env).
    readonly env?: readonly (readonly [string, string])[];
}

// The Machines-API `config` object, shaped exactly as POST /apps/{app}/machines expects it.
export interface FlyMachineConfig {
    readonly image: string;
    readonly guest: { readonly cpu_kind: "shared"; readonly cpus: number; readonly memory_mb: number };
    readonly env: Record<string, string>;
    readonly mounts: readonly { readonly volume: string; readonly path: string }[];
    // on-failure is the idle-stop policy's other half: a crash restarts (bounded), while the daemon's clean
    // idle exit stops the machine — which is the whole point of the hosted lane's economics.
    readonly restart: { readonly policy: "on-failure"; readonly max_retries: number };
    readonly auto_destroy: false;
    /* Replace what the image would run. `flyMachineConfig` never sets it — a sandbox machine runs the image's
     * own entrypoint — but the warm pool's first boot does: a no-op exec pulls the image onto the host and
     * exits clean, so the machine stops holding a warm rootfs and nothing sandbox-shaped ever ran without an
     * identity. Machine updates REPLACE the whole config, so the claim's config (built by flyMachineConfig,
     * no init) is also what erases the override. */
    readonly init?: { readonly exec: readonly string[] };
    /* Fly's own key/value bag on a Machine — the only label the provider can be ASKED about, since an app
     * cannot be renamed and a Machine's name is fixed at birth. `flyMachineConfig` never sets it; the hosted
     * lane writes what the machine currently is (warm stock vs. somebody's sandbox) and, because updates
     * replace the whole config, the claim that brands a warm machine re-stamps this in the same call. */
    readonly metadata?: Record<string, string>;
}

export const flyMachineConfig = (run: FlyMachineRun): FlyMachineConfig => ({
    image: run.image,
    guest: { cpu_kind: "shared", cpus: run.guest.cpus, memory_mb: run.guest.memoryMb },
    env: Object.fromEntries([
        ["SANDBOX_NAME", run.name],
        ["SANDBOX_IMAGE", run.image],
        ["SANDBOX_BASE_IMAGE", run.baseImage],
        // The entrypoint's VM switch: we are the whole machine — count as privileged (nested dockerd on the
        // volume), run cloudflared in-box, and alias the tunnel's origin hostname onto loopback.
        ["SANDBOX_VM", "1"],
        ...(run.env ?? []).filter(([, value]) => value !== ""),
    ]),
    mounts: [{ volume: run.volumeId, path: FLY_VOLUME_PATH }],
    restart: { policy: "on-failure", max_retries: 3 },
    auto_destroy: false,
});
