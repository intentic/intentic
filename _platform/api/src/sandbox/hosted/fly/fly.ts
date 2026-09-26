import { z } from "zod";
import type { FlyMachineConfig } from "@intentic/sandbox-run/fly";

// Plain-fetch client for Fly's Machines API, no provider SDK; the platform's own token (config.hosted) keeps permanent
// access to every machine it creates, per the trust model in docs/architecture/topology.md. One Fly app per sandbox on
// its own network (`<prefix>-<sandbox id>`), since Fly's 6PN spans an org by default; only Fly's edge proxy reaches in.

const BASE = `https://api.machines.dev/v1`;

// Fly metadata carries what a name can't: role (`FLY_META_ROLE`) and owning deployment (`FLY_META_PLATFORM`), since
// sibling platforms can mint identical app names; the reaper proves ownership by this stamp.
export const FLY_META_ROLE = `intentic_role`;
export const FLY_META_PLATFORM = `intentic_platform`;
/* WHOSE MACHINE THIS IS, in the provider's own console. */
export const FLY_META_OWNER = `intentic_owner`;
export const flyWarmRole = (instance: string): Record<string, string> => ({ [FLY_META_ROLE]: `warm`, [FLY_META_PLATFORM]: instance });
export const flySandboxRole = (sandboxId: string, instance: string, owner?: string): Record<string, string> => ({
    [FLY_META_ROLE]: `sandbox`,
    intentic_sandbox: sandboxId,
    [FLY_META_PLATFORM]: instance,
    ...(owner === undefined || owner === `` ? {} : { [FLY_META_OWNER]: owner }),
});
// A builder (hosted-build.ts): the second machine a sandbox's app holds, for one overlay build. Stamped like the
// sandbox so the reaper and health watch read it as ours.
export const flyBuildRole = (sandboxId: string, instance: string): Record<string, string> => ({
    [FLY_META_ROLE]: `build`,
    intentic_sandbox: sandboxId,
    [FLY_META_PLATFORM]: instance,
});

// A Fly API failure. `status` carries Fly's HTTP code; undefined when the failure never reached a response (timeout,
// dead socket) — the difference isFlyGone and isFlyCapacity key off.
export class FlyError extends Error {
    readonly status: number | undefined;

    constructor(message: string, status?: number) {
        super(message);
        this.status = status;
    }
}

// Fly answering 404: the machine (or app) is definitively gone, unlike a timeout or 5xx, which say nothing.
export const isFlyGone = (error: unknown): boolean => error instanceof FlyError && error.status === 404;

// Matched on Fly's wording, since it publishes no status code for an out-of-capacity refusal and the wording differs by
// call. Still requires a status: a timeout carries none and must never read as full.
const CAPACITY_WORDS = /maximum number of machines|machine limit|limit of machines|reached the limit|capacity|quota|insufficient/i;
export const isFlyCapacity = (error: unknown): boolean =>
    error instanceof FlyError && error.status !== undefined && error.status !== 404 && CAPACITY_WORDS.test(error.message);

// Fly's error envelope on a non-2xx: { error: "…" }.
const errorSchema = z.object({ error: z.string() });

// 30s deadline, same as reachability.ts/cloudflare.ts; a timeout surfaces as a status-less FlyError.
const FLY_TIMEOUT_MS = 30_000;

// Attaches the deadline and turns a transport failure into a named FlyError. Any abort spelling (`TimeoutError`,
// `AbortError`) is read as this deadline, the only signal on the request.
const flyFetch = async (method: string, path: string, init: RequestInit): Promise<Response> => {
    try {
        return await fetch(`${BASE}${path}`, { ...init, method, signal: AbortSignal.timeout(FLY_TIMEOUT_MS) });
    } catch (error) {
        const aborted = error instanceof Error && (error.name === `TimeoutError` || error.name === `AbortError`);
        throw new FlyError(
            aborted
                ? `Fly did not answer ${method} ${path} within ${FLY_TIMEOUT_MS / 1000}s`
                : `Fly could not be reached for ${method} ${path}: ${error instanceof Error ? error.message : `transport failure`}`,
        );
    }
};

// Fly states billed as running (meter, idle sweep, wake); replacing counts, stopped/suspended/destroyed don't.
export const LIVE_STATES = new Set([`created`, `starting`, `started`, `replacing`]);

const appsSchema = z.object({ apps: z.array(z.object({ name: z.string() })) });
const idSchema = z.object({ id: z.string() });
// `updated_at`: Fly's last-transition stamp (stop time, if stopped); optional, omitted by create.
const machineSchema = z.object({ id: z.string(), state: z.string(), updated_at: z.string().optional() });

const call = async (token: string, method: string, path: string, body?: unknown): Promise<unknown> => {
    const response = await flyFetch(method, path, {
        headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": `application/json` }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (response.ok) {
        // DELETE answers an empty body; parse only when there is something to parse.
        const text = await response.text();
        return text === `` ? undefined : (JSON.parse(text) as unknown);
    }
    if (response.status === 401 || response.status === 403) {
        throw new FlyError(
            `Fly rejected the platform's API token (HTTP ${response.status}): check HOSTED_FLY_API_TOKEN / HOSTED_FLY_ORG.`,
            response.status,
        );
    }
    const failure = errorSchema.safeParse(await response.json().catch(() => undefined));
    if (failure.success) {
        throw new FlyError(`Fly refused ${method} ${path}: ${failure.data.error}`, response.status);
    }
    throw new FlyError(`Fly API ${method} ${path} failed with HTTP ${response.status}`, response.status);
};

// `network: name` gives the app its own private network, so sandboxes never share Fly's org-wide 6PN.
// The edge crosses that boundary only while the org allows cross-network replays; with the setting off, Fly
// refuses every replay to these apps and no hosted sandbox is reachable (ingress README, "Deploying").
export const createApp = async (token: string, org: string, name: string): Promise<void> => {
    await call(token, `POST`, `/apps`, { app_name: name, org_slug: org, network: name });
};

// Deleting the app tears down its machines and volumes with it. An already-gone app (404) counts as success: delete's
// contract is not there anymore.
export const deleteApp = async (token: string, name: string): Promise<void> => {
    const response = await flyFetch(`DELETE`, `/apps/${encodeURIComponent(name)}?force=true`, { headers: { authorization: `Bearer ${token}` } });
    if (response.ok || response.status === 404) {
        return;
    }
    if (response.status === 401 || response.status === 403) {
        throw new FlyError(
            `Fly rejected the platform's API token (HTTP ${response.status}): check HOSTED_FLY_API_TOKEN / HOSTED_FLY_ORG.`,
            response.status,
        );
    }
    const failure = errorSchema.safeParse(await response.json().catch(() => undefined));
    throw new FlyError(
        failure.success ? `Fly refused DELETE /apps/${name}: ${failure.data.error}` : `Fly DELETE /apps/${name} failed with HTTP ${response.status}`,
        response.status,
    );
};

export const appExists = async (token: string, name: string): Promise<boolean> => {
    try {
        await call(token, `GET`, `/apps/${encodeURIComponent(name)}`);
        return true;
    } catch (error) {
        if (isFlyGone(error)) {
            return false;
        }
        throw error;
    }
};

// Every app name in the org; the reaper diffs this against the DB to find orphans (prefix-filtered there, since the org
// may hold non-sandbox apps).
export const listAppNames = async (token: string, org: string): Promise<string[]> => {
    const parsed = appsSchema.parse(await call(token, `GET`, `/apps?org_slug=${encodeURIComponent(org)}`));
    return parsed.apps.map((app) => app.name);
};

/* HOW A NEW VOLUME IS FILLED, and where its machine will have to fit.
 *
 * `sourceVolumeId` forks an existing volume block for block (same app, any region); `snapshotId` restores one from a
 * snapshot. Neither may be smaller than what it came from: Fly volumes grow and never shrink.
 *
 * `compute` is a placement hint, and leaving it off is how a migration discovers too late that the host holding the
 * volume has no room for the guest that is supposed to mount it. Ask for the shape up front and Fly picks a host that
 * can take it. */
export interface FlyVolumeOptions {
    readonly sourceVolumeId?: string;
    readonly snapshotId?: string;
    readonly compute?: { readonly cpuKind: "shared" | "performance"; readonly cpus: number; readonly memoryMb: number };
    // Days Fly keeps this volume's daily snapshots, 1 to 60. Left off, Fly's own default (5) applies unstated.
    readonly snapshotRetention?: number;
}

export const createVolume = async (
    token: string,
    app: string,
    region: string,
    sizeGb: number,
    options: FlyVolumeOptions = {},
): Promise<{ volumeId: string }> => {
    const parsed = idSchema.parse(
        await call(token, `POST`, `/apps/${encodeURIComponent(app)}/volumes`, {
            name: `data`,
            region,
            size_gb: sizeGb,
            ...(options.sourceVolumeId === undefined ? {} : { source_volume_id: options.sourceVolumeId }),
            ...(options.snapshotId === undefined ? {} : { snapshot_id: options.snapshotId }),
            ...(options.snapshotRetention === undefined ? {} : { snapshot_retention: options.snapshotRetention }),
            ...(options.compute === undefined
                ? {}
                : { compute: { cpu_kind: options.compute.cpuKind, cpus: options.compute.cpus, memory_mb: options.compute.memoryMb } }),
        }),
    );
    return { volumeId: parsed.id };
};

// A volume's own state, for the two questions a migration asks: how big is it, and how much of it is free. `blocks`
// and `blocks_avail` are optional because Fly omits them on a volume that is still being created or restored.
const volumeSchema = z.object({
    id: z.string(),
    size_gb: z.number(),
    state: z.string(),
    block_size: z.number().optional(),
    blocks: z.number().optional(),
    blocks_avail: z.number().optional(),
});

export interface FlyVolume {
    readonly id: string;
    readonly sizeGb: number;
    readonly state: string;
    // Bytes in use, or undefined when Fly has not reported the block counts yet.
    readonly usedBytes: number | undefined;
}

export const getVolume = async (token: string, app: string, volumeId: string): Promise<FlyVolume> => {
    const parsed = volumeSchema.parse(await call(token, `GET`, `/apps/${encodeURIComponent(app)}/volumes/${encodeURIComponent(volumeId)}`));
    const { block_size: blockSize, blocks, blocks_avail: free } = parsed;
    return {
        id: parsed.id,
        sizeGb: parsed.size_gb,
        state: parsed.state,
        usedBytes: blockSize === undefined || blocks === undefined || free === undefined ? undefined : (blocks - free) * blockSize,
    };
};

// Grows a volume in place. Fly refuses a size below the current one, which is the whole reason a downgrade leaves the
// disk alone. `needs_restart` says the filesystem will only see the new size after the machine restarts.
const extendSchema = z.object({ volume: volumeSchema, needs_restart: z.boolean().optional() });

export const extendVolume = async (token: string, app: string, volumeId: string, sizeGb: number): Promise<{ needsRestart: boolean }> => {
    const parsed = extendSchema.parse(
        await call(token, `PUT`, `/apps/${encodeURIComponent(app)}/volumes/${encodeURIComponent(volumeId)}/extend`, { size_gb: sizeGb }),
    );
    return { needsRestart: parsed.needs_restart === true };
};

// Destroys one volume. Already-gone (404) counts as success, like every other delete here.
export const destroyVolume = async (token: string, app: string, volumeId: string): Promise<void> => {
    try {
        await call(token, `DELETE`, `/apps/${encodeURIComponent(app)}/volumes/${encodeURIComponent(volumeId)}`);
    } catch (error) {
        if (!isFlyGone(error)) {
            throw error;
        }
    }
};

// A snapshot as Fly reports it. `status` walks waiting → running → created; only `created` can be restored from.
const snapshotSchema = z.object({ id: z.string(), status: z.string().optional(), created_at: z.string().optional(), size: z.number().optional() });

export interface FlySnapshot {
    readonly id: string;
    readonly status: string;
    readonly createdAt: Date | undefined;
    // Stored bytes, which is the incremental size Fly bills for, not the volume's.
    readonly sizeBytes: number | undefined;
}

const toSnapshot = (raw: z.infer<typeof snapshotSchema>): FlySnapshot => ({
    id: raw.id,
    status: raw.status ?? ``,
    createdAt: parsedDate(raw.created_at),
    sizeBytes: raw.size,
});

/* ASKS FOR A SNAPSHOT NOW, rather than waiting for the daily one; answers as soon as Fly has scheduled it. */
export const createVolumeSnapshot = async (token: string, app: string, volumeId: string): Promise<FlySnapshot> =>
    toSnapshot(snapshotSchema.parse(await call(token, `POST`, `/apps/${encodeURIComponent(app)}/volumes/${encodeURIComponent(volumeId)}/snapshots`)));

// Every snapshot Fly still holds for a volume, newest first; the daily automatic ones and any taken on demand.
export const listVolumeSnapshots = async (token: string, app: string, volumeId: string): Promise<FlySnapshot[]> => {
    const parsed = z
        .array(snapshotSchema)
        .parse(await call(token, `GET`, `/apps/${encodeURIComponent(app)}/volumes/${encodeURIComponent(volumeId)}/snapshots`));
    return parsed
        .map(toSnapshot)
        .toSorted((left, right) => (right.createdAt?.getTime() ?? 0) - (left.createdAt?.getTime() ?? 0));
};

// `instance_id`: this create's machine version; the build row records it to distinguish builder runs.
const createdSchema = z.object({ id: z.string(), state: z.string(), instance_id: z.string().optional() });

export const createMachine = async (
    token: string,
    app: string,
    args: { name: string; region: string; config: FlyMachineConfig },
): Promise<{ machineId: string; instanceId: string }> => {
    const parsed = createdSchema.parse(await call(token, `POST`, `/apps/${encodeURIComponent(app)}/machines`, args));
    return { machineId: parsed.id, instanceId: parsed.instance_id ?? `` };
};

// A builder's exit code and image, read off a stopped machine: exit code from the newest `events[].request.exit_event`,
// digest from `image_ref`. Both optional since Fly may grow the shape.
const machineDetailSchema = z.object({
    id: z.string(),
    state: z.string(),
    updated_at: z.string().optional(),
    image_ref: z.object({ digest: z.string().optional() }).optional(),
    events: z
        .array(
            z.object({
                type: z.string().optional(),
                timestamp: z.number().optional(),
                request: z
                    .object({ exit_event: z.object({ exit_code: z.number().optional(), oom_killed: z.boolean().optional() }).optional() })
                    .optional(),
            }),
        )
        .optional(),
});

export interface FlyMachineDetail {
    readonly state: string;
    // Fly's last-transition stamp, which for a stopped machine is when it stopped.
    readonly updatedAt: Date | undefined;
    readonly imageDigest: string | undefined;
    readonly exitCode: number | undefined;
    readonly oomKilled: boolean;
}

export const getMachineDetail = async (token: string, app: string, machineId: string): Promise<FlyMachineDetail> => {
    const parsed = machineDetailSchema.parse(await call(token, `GET`, `/apps/${encodeURIComponent(app)}/machines/${encodeURIComponent(machineId)}`));
    const exit = [...(parsed.events ?? [])]
        .toSorted((left, right) => (right.timestamp ?? 0) - (left.timestamp ?? 0))
        .map((event) => event.request?.exit_event)
        .find((event) => event !== undefined);
    return {
        state: parsed.state,
        updatedAt: parsedDate(parsed.updated_at),
        imageDigest: parsed.image_ref?.digest,
        exitCode: exit?.exit_code,
        oomKilled: exit?.oom_killed === true,
    };
};

// Destroys one machine, leaving its app and everything else in it. `force` kills a running one; already-gone (404)
// counts as success.
export const destroyMachine = async (token: string, app: string, machineId: string, options: { force?: boolean } = {}): Promise<void> => {
    const query = options.force === true ? `?force=true` : ``;
    const response = await flyFetch(`DELETE`, `/apps/${encodeURIComponent(app)}/machines/${encodeURIComponent(machineId)}${query}`, {
        headers: { authorization: `Bearer ${token}` },
    });
    if (response.ok || response.status === 404) {
        return;
    }
    const failure = errorSchema.safeParse(await response.json().catch(() => undefined));
    throw new FlyError(
        failure.success
            ? `Fly refused DELETE machine ${machineId} in ${app}: ${failure.data.error}`
            : `Fly DELETE machine ${machineId} in ${app} failed with HTTP ${response.status}`,
        response.status,
    );
};

export const getMachine = async (token: string, app: string, machineId: string): Promise<{ state: string; updatedAt?: Date }> => {
    const parsed = machineSchema.parse(await call(token, `GET`, `/apps/${encodeURIComponent(app)}/machines/${encodeURIComponent(machineId)}`));
    const updatedAt = parsed.updated_at === undefined ? undefined : new Date(parsed.updated_at);
    // An unparseable stamp drops rather than an Invalid Date; a NaN would silently poison every sum it reaches.
    return { state: parsed.state, updatedAt: updatedAt !== undefined && !Number.isNaN(updatedAt.getTime()) ? updatedAt : undefined };
};

// What a machine launches with: the image its config names and its environment, both absent when the answer carries no
// config. Read by the wake, which re-applies a config whose tunnel environment is missing or stale (hosted.ts).
const machineLaunchSchema = z.object({
    state: z.string(),
    config: z.object({ image: z.string().optional(), env: z.record(z.string(), z.string()).optional() }).optional(),
});
export interface FlyMachineLaunch {
    readonly state: string;
    readonly image: string | undefined;
    readonly env: Readonly<Record<string, string>> | undefined;
}
export const getMachineLaunch = async (token: string, app: string, machineId: string): Promise<FlyMachineLaunch> => {
    const parsed = machineLaunchSchema.parse(await call(token, `GET`, `/apps/${encodeURIComponent(app)}/machines/${encodeURIComponent(machineId)}`));
    return { state: parsed.state, image: parsed.config?.image, env: parsed.config === undefined ? undefined : (parsed.config.env ?? {}) };
};

// Every machine in an app, with what the orphan sweep judges it by: its metadata stamp and `created_at` (fresh signup
// vs. leftover). Missing either field means the sweep leaves it alone.
const machineListSchema = z.array(
    z.object({
        id: z.string(),
        state: z.string(),
        created_at: z.string().optional(),
        config: z.object({ metadata: z.record(z.string(), z.string()).optional() }).optional(),
    }),
);

export interface FlyMachineSummary {
    readonly id: string;
    readonly state: string;
    readonly createdAt: Date | undefined;
    readonly metadata: Record<string, string>;
}

const parsedDate = (value: string | undefined): Date | undefined => {
    if (value === undefined) {
        return undefined;
    }
    const at = new Date(value);
    return Number.isNaN(at.getTime()) ? undefined : at;
};

export const listMachines = async (token: string, app: string): Promise<FlyMachineSummary[]> => {
    const parsed = machineListSchema.parse(await call(token, `GET`, `/apps/${encodeURIComponent(app)}/machines`));
    return parsed.map((machine) => ({
        id: machine.id,
        state: machine.state,
        createdAt: parsedDate(machine.created_at),
        metadata: machine.config?.metadata ?? {},
    }));
};

// An app's volumes, read for the same age question when it holds no machine yet: a lone volume is either mid
// cold-provision or what a failed one left behind, and only its age tells them apart.
const volumeListSchema = z.array(z.object({ id: z.string(), created_at: z.string().optional() }));

export const listVolumes = async (token: string, app: string): Promise<{ id: string; createdAt: Date | undefined }[]> => {
    const parsed = volumeListSchema.parse(await call(token, `GET`, `/apps/${encodeURIComponent(app)}/volumes`));
    return parsed.map((volume) => ({ id: volume.id, createdAt: parsedDate(volume.created_at) }));
};

// Start answers 200; an already-running machine answers an error naming its state, which hosted.ts treats as success
// via getMachine, not this client.
export const startMachine = async (token: string, app: string, machineId: string): Promise<void> => {
    await call(token, `POST`, `/apps/${encodeURIComponent(app)}/machines/${encodeURIComponent(machineId)}/start`);
};

// Replaces the whole config with the launch in the same request: a separate start races Fly's `replacing` state and
// gets refused (412). A stopped machine stays stopped across an update, so the follow-up start is the real operation.
export const updateMachine = async (token: string, app: string, machineId: string, config: FlyMachineConfig): Promise<void> => {
    await call(token, `POST`, `/apps/${encodeURIComponent(app)}/machines/${encodeURIComponent(machineId)}`, { config });
};

export const stopMachine = async (token: string, app: string, machineId: string): Promise<void> => {
    await call(token, `POST`, `/apps/${encodeURIComponent(app)}/machines/${encodeURIComponent(machineId)}/stop`);
};

// One metadata key, written on its own. Unlike updateMachine this replaces no config, so it never takes a machine
// through `replacing` and never restarts it: the backfill in hosted-fleet.ts can stamp a fleet of stopped machines
// without waking one of them or costing anybody a second of uptime.
export const setMachineMetadata = async (token: string, app: string, machineId: string, key: string, value: string): Promise<void> => {
    await call(token, `POST`, `/apps/${encodeURIComponent(app)}/machines/${encodeURIComponent(machineId)}/metadata/${encodeURIComponent(key)}`, {
        value,
    });
};
