import { z } from "zod";
import type { FlyMachineConfig } from "@intentic/sandbox-run/fly";

/* Fly Machines, the HOSTED lane's provider: a plain-fetch client against the documented Machines API, the
 * ../cloud house rule (no provider SDK dependencies), but the OPPOSITE credential stance. The cloud adapters
 * spend a user-pasted token and drop it with the request; here the token is intentic's OWN (config.hosted),
 * lives for the platform's lifetime, and the platform deliberately KEEPS the way back into every machine it
 * creates, start, stop, destroy. That inversion is the hosted lane's whole trade and is documented where the
 * trust model lives (ARCHITECTURE.md); this file just talks to the API.
 *
 * Topology: one Fly APP per sandbox (apps are free), created on its OWN private network. Fly's 6PN spans an
 * org by default, and two strangers' sandboxes must not share a LAN. The app name is <prefix>-<sandbox id>,
 * which is what lets the reaper recognize ours by prefix and the delete dialog name what it is deleting.
 * Ingress stays Cloudflare: the machine dials out through the sandbox's own tunnel like every other lane, so
 * no Fly services, proxies or certificates are configured at all. */

const BASE = `https://api.machines.dev/v1`;

/* WHAT A MACHINE IS, in the one place Fly can be asked about it. Fly has no labels on an app, no way to
 * rename one, and a machine's name is fixed at birth, so a warm machine's `<prefix>-pool-<hex>` app keeps
 * that name for life, INCLUDING after somebody claims it. The console's app list therefore cannot tell the
 * platform's own stock from a person's working sandbox, and no naming scheme can make it: the name is minted
 * before anyone has asked for the machine. Machine metadata is the lever that does work, set at create,
 * rewritten with the config at claim (updates replace the whole config), and filterable server-side, e.g.
 * GET /apps/{app}/machines?metadata.intentic_role=sandbox. hosted-fleet.ts is the readable answer built on
 * top; this is the vocabulary both the pool's builder and the sandbox's composer write.
 *
 * WHICH PLATFORM the machine belongs to rides in the same bag, and it is the load-bearing half. An app name
 * says the deployment's prefix and nothing about WHOSE deployment: two platforms sharing a Fly org and a
 * credential (a staging box, a laptop, anything holding a copy of the production env file) mint
 * indistinguishable names, and each one's reaper reads the other's machines as apps with no row behind them.
 * That is not hypothetical, it is the outage this stamp exists to prevent: a second instance's orphan sweep
 * destroyed every production machine in the org, leaving the rows behind, so every affected user met a
 * "start it over" button that could never work again. The stamp makes ownership a fact the provider can be
 * asked about instead of an inference from a name, and the reaper destroys nothing it cannot prove is its own. */
export const FLY_META_ROLE = `intentic_role`;
export const FLY_META_PLATFORM = `intentic_platform`;
export const flyWarmRole = (instance: string): Record<string, string> => ({ [FLY_META_ROLE]: `warm`, [FLY_META_PLATFORM]: instance });
export const flySandboxRole = (sandboxId: string, instance: string): Record<string, string> => ({
    [FLY_META_ROLE]: `sandbox`,
    intentic_sandbox: sandboxId,
    [FLY_META_PLATFORM]: instance,
});

/* The operator misconfigured the platform (bad/expired token, wrong org), nothing a user can fix, and the
 * route surfaces it as a gateway failure. Named so hosted.ts can log it apart from capacity weather.
 *
 * `status` carries Fly's own HTTP code, because one caller needs the difference between two failures this
 * class would otherwise flatten: 404 is Fly ANSWERING that a thing does not exist, while a 5xx or a socket
 * that never opened is Fly not answering at all. The pool's health check turns that difference into "replace
 * this dead machine" or "ask again next tick", and reading the second as the first destroys healthy stock
 * every time the provider has a bad minute. Undefined where the failure never reached an HTTP response. */
export class FlyError extends Error {
    readonly status: number | undefined;

    constructor(message: string, status?: number) {
        super(message);
        this.status = status;
    }
}

/* Fly ANSWERING that a thing is not there, told apart from every other way a call can fail. The difference is
 * the whole recovery story on the platform side: a machine (or its whole app) that Fly says does not exist
 * will never start, boot or be restarted, so the row describing it is a belief the platform has to give up,
 * while a 500 or a dead socket is a bad minute at the provider that must change nothing at all. */
export const isFlyGone = (error: unknown): boolean => error instanceof FlyError && error.status === 404;

// Fly's error envelope on a non-2xx: { error: "…" }.
const errorSchema = z.object({ error: z.string() });

const appsSchema = z.object({ apps: z.array(z.object({ name: z.string() })) });
const idSchema = z.object({ id: z.string() });
// `updated_at` is Fly's own stamp of the last state transition, which for a stopped machine is when it
// stopped, the hour meter's only way to learn a moment nothing on our side witnessed (the machine sleeps
// from the inside). Optional because create's response is not required to carry one and nothing there wants it.
const machineSchema = z.object({ id: z.string(), state: z.string(), updated_at: z.string().optional() });

const call = async (token: string, method: string, path: string, body?: unknown): Promise<unknown> => {
    const response = await fetch(`${BASE}${path}`, {
        method,
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

// The app is the sandbox's outer identity on Fly. `network: name` is the isolation move, each app gets its
// own private network so hosted sandboxes never share Fly's org-wide 6PN.
export const createApp = async (token: string, org: string, name: string): Promise<void> => {
    await call(token, `POST`, `/apps`, { app_name: name, org_slug: org, network: name });
};

// Deleting the app tears down its machines AND volumes with it, the one-call teardown both the delete flow
// and the reaper lean on. An app already gone (404) is a success: delete's contract is "not there anymore",
// and both callers retry after partial failures.
export const deleteApp = async (token: string, name: string): Promise<void> => {
    const response = await fetch(`${BASE}/apps/${encodeURIComponent(name)}`, {
        method: `DELETE`,
        headers: { authorization: `Bearer ${token}` },
    });
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

// Every app name in the org, the reaper diffs this against the DB to find orphans (prefix-filtered there;
// the org may hold non-sandbox apps).
export const listAppNames = async (token: string, org: string): Promise<string[]> => {
    const parsed = appsSchema.parse(await call(token, `GET`, `/apps?org_slug=${encodeURIComponent(org)}`));
    return parsed.apps.map((app) => app.name);
};

export const createVolume = async (token: string, app: string, region: string, sizeGb: number): Promise<{ volumeId: string }> => {
    const parsed = idSchema.parse(await call(token, `POST`, `/apps/${encodeURIComponent(app)}/volumes`, { name: `data`, region, size_gb: sizeGb }));
    return { volumeId: parsed.id };
};

export const createMachine = async (
    token: string,
    app: string,
    args: { name: string; region: string; config: FlyMachineConfig },
): Promise<{ machineId: string }> => {
    const parsed = machineSchema.parse(await call(token, `POST`, `/apps/${encodeURIComponent(app)}/machines`, args));
    return { machineId: parsed.id };
};

export const getMachine = async (token: string, app: string, machineId: string): Promise<{ state: string; updatedAt?: Date }> => {
    const parsed = machineSchema.parse(await call(token, `GET`, `/apps/${encodeURIComponent(app)}/machines/${encodeURIComponent(machineId)}`));
    const updatedAt = parsed.updated_at === undefined ? undefined : new Date(parsed.updated_at);
    // An unparseable stamp is dropped rather than propagated as an Invalid Date, the meter's fallback (bill
    // to now) is a worse answer than Fly's, but a NaN one would silently poison every sum it reaches.
    return { state: parsed.state, updatedAt: updatedAt !== undefined && !Number.isNaN(updatedAt.getTime()) ? updatedAt : undefined };
};

/* EVERY MACHINE IN AN APP, with the two facts the orphan sweep judges an app by: who stamped it
 * (config.metadata) and how old it is. `created_at` is what keeps a provision in flight safe, an app whose
 * machine was made a minute ago is somebody mid-signup, not a leftover, and the row that will vouch for it is
 * written after the machine exists. Optional because Fly is free to grow the shape; a machine that arrives
 * without either field is simply one the sweep cannot vouch for, which is read as "leave it alone". */
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

// An app's volumes, read for the same age question when the app holds no machine yet: the cold provision
// creates app → volume → machine → row, so a volume with nothing beside it is either the middle of that
// sequence or what a failed one left behind, and only the clock tells them apart.
const volumeListSchema = z.array(z.object({ id: z.string(), created_at: z.string().optional() }));

export const listVolumes = async (token: string, app: string): Promise<{ id: string; createdAt: Date | undefined }[]> => {
    const parsed = volumeListSchema.parse(await call(token, `GET`, `/apps/${encodeURIComponent(app)}/volumes`));
    return parsed.map((volume) => ({ id: volume.id, createdAt: parsedDate(volume.created_at) }));
};

// Start answers 200 with a small status body; a machine already running answers an error naming its state,
// which the caller treats as success via getMachine, hosted.ts owns that idempotence, not this client.
export const startMachine = async (token: string, app: string, machineId: string): Promise<void> => {
    await call(token, `POST`, `/apps/${encodeURIComponent(app)}/machines/${encodeURIComponent(machineId)}/start`);
};

/* Replace a machine's whole config (Fly's update semantics: the posted config IS the new one, nothing is
 * merged), the warm pool's claim writes a sandbox's real identity into a machine built before it had one.
 * Same image ⇒ no new pull, and the machine stays on its host, which is what keeps its volume attached.
 *
 * THE UPDATE IS THE POWER TRANSITION, and this is the whole reason the warm pool works at all. An update
 * replaces the machine, which Fly performs as a state of its own: for a few seconds the machine reads
 * `replacing` and refuses every start with `412 failed_precondition: machine getting replaced`. A caller that
 * posted `skip_launch: true` and then started the machine itself therefore lost that race EVERY time — the
 * measured effect was 100% of pool claims refused, both warm machines of a region burned and stranded per
 * sign-up, and the reader handed the exact cold build the pool exists to spare. So the launch rides WITH the
 * config: one call, no window to lose, and the caller's own start becomes a cheap idempotent confirmation
 * (hosted.ts's wakeHosted) rather than the operation that has to succeed. */
export const updateMachine = async (token: string, app: string, machineId: string, config: FlyMachineConfig): Promise<void> => {
    await call(token, `POST`, `/apps/${encodeURIComponent(app)}/machines/${encodeURIComponent(machineId)}`, { config });
};

export const stopMachine = async (token: string, app: string, machineId: string): Promise<void> => {
    await call(token, `POST`, `/apps/${encodeURIComponent(app)}/machines/${encodeURIComponent(machineId)}/stop`);
};
