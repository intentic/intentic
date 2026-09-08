import { z } from "zod";
import type { FlyMachineConfig } from "@intentic/sandbox-run/fly";

// Plain-fetch client for Fly's Machines API, no provider SDK; the platform's own token (config.hosted) keeps permanent
// access to every machine it creates, per the trust model in ARCHITECTURE.md. One Fly app per sandbox on its own
// network (`<prefix>-<sandbox id>`), since Fly's 6PN spans an org by default; only Fly's edge proxy reaches in.

const BASE = `https://api.machines.dev/v1`;

// Fly metadata carries what a name can't: role (`FLY_META_ROLE`) and owning deployment (`FLY_META_PLATFORM`), since
// sibling platforms can mint identical app names; the reaper proves ownership by this stamp.
export const FLY_META_ROLE = `intentic_role`;
export const FLY_META_PLATFORM = `intentic_platform`;
export const flyWarmRole = (instance: string): Record<string, string> => ({ [FLY_META_ROLE]: `warm`, [FLY_META_PLATFORM]: instance });
export const flySandboxRole = (sandboxId: string, instance: string): Record<string, string> => ({
    [FLY_META_ROLE]: `sandbox`,
    intentic_sandbox: sandboxId,
    [FLY_META_PLATFORM]: instance,
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
export const createApp = async (token: string, org: string, name: string): Promise<void> => {
    await call(token, `POST`, `/apps`, { app_name: name, org_slug: org, network: name });
};

// Deleting the app tears down its machines and volumes with it. An already-gone app (404) counts as success: delete's
// contract is not there anymore.
export const deleteApp = async (token: string, name: string): Promise<void> => {
    const response = await flyFetch(`DELETE`, `/apps/${encodeURIComponent(name)}`, { headers: { authorization: `Bearer ${token}` } });
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

// Every app name in the org; the reaper diffs this against the DB to find orphans (prefix-filtered there, since the org
// may hold non-sandbox apps).
export const listAppNames = async (token: string, org: string): Promise<string[]> => {
    const parsed = appsSchema.parse(await call(token, `GET`, `/apps?org_slug=${encodeURIComponent(org)}`));
    return parsed.apps.map((app) => app.name);
};

export const createVolume = async (token: string, app: string, region: string, sizeGb: number): Promise<{ volumeId: string }> => {
    const parsed = idSchema.parse(await call(token, `POST`, `/apps/${encodeURIComponent(app)}/volumes`, { name: `data`, region, size_gb: sizeGb }));
    return { volumeId: parsed.id };
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
