import { z } from "zod";
import type { FlyMachineConfig } from "@intentic/sandbox-run/fly";

/* Fly Machines, the HOSTED lane's provider: a plain-fetch client against the documented Machines API — the
 * ../cloud house rule (no provider SDK dependencies) — but the OPPOSITE credential stance. The cloud adapters
 * spend a user-pasted token and drop it with the request; here the token is intentic's OWN (config.hosted),
 * lives for the platform's lifetime, and the platform deliberately KEEPS the way back into every machine it
 * creates — start, stop, destroy. That inversion is the hosted lane's whole trade and is documented where the
 * trust model lives (ARCHITECTURE.md); this file just talks to the API.
 *
 * Topology: one Fly APP per sandbox (apps are free), created on its OWN private network — Fly's 6PN spans an
 * org by default, and two strangers' sandboxes must not share a LAN. The app name is <prefix>-<sandbox id>,
 * which is what lets the reaper recognize ours by prefix and the delete dialog name what it is deleting.
 * Ingress stays Cloudflare: the machine dials out through the sandbox's own tunnel like every other lane, so
 * no Fly services, proxies or certificates are configured at all. */

const BASE = `https://api.machines.dev/v1`;

// The operator misconfigured the platform (bad/expired token, wrong org) — nothing a user can fix, and the
// route surfaces it as a gateway failure. Named so hosted.ts can log it apart from capacity weather.
export class FlyError extends Error {}

// Fly's error envelope on a non-2xx: { error: "…" }.
const errorSchema = z.object({ error: z.string() });

const appsSchema = z.object({ apps: z.array(z.object({ name: z.string() })) });
const idSchema = z.object({ id: z.string() });
// `updated_at` is Fly's own stamp of the last state transition, which for a stopped machine is when it
// stopped — the hour meter's only way to learn a moment nothing on our side witnessed (the machine sleeps
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
        throw new FlyError(`Fly rejected the platform's API token (HTTP ${response.status}) — check HOSTED_FLY_API_TOKEN / HOSTED_FLY_ORG.`);
    }
    const failure = errorSchema.safeParse(await response.json().catch(() => undefined));
    if (failure.success) {
        throw new FlyError(`Fly refused ${method} ${path}: ${failure.data.error}`);
    }
    throw new FlyError(`Fly API ${method} ${path} failed with HTTP ${response.status}`);
};

// The app is the sandbox's outer identity on Fly. `network: name` is the isolation move — each app gets its
// own private network so hosted sandboxes never share Fly's org-wide 6PN.
export const createApp = async (token: string, org: string, name: string): Promise<void> => {
    await call(token, `POST`, `/apps`, { app_name: name, org_slug: org, network: name });
};

// Deleting the app tears down its machines AND volumes with it — the one-call teardown both the delete flow
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
        throw new FlyError(`Fly rejected the platform's API token (HTTP ${response.status}) — check HOSTED_FLY_API_TOKEN / HOSTED_FLY_ORG.`);
    }
    const failure = errorSchema.safeParse(await response.json().catch(() => undefined));
    throw new FlyError(
        failure.success ? `Fly refused DELETE /apps/${name}: ${failure.data.error}` : `Fly DELETE /apps/${name} failed with HTTP ${response.status}`,
    );
};

// Every app name in the org — the reaper diffs this against the DB to find orphans (prefix-filtered there;
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
    // An unparseable stamp is dropped rather than propagated as an Invalid Date — the meter's fallback (bill
    // to now) is a worse answer than Fly's, but a NaN one would silently poison every sum it reaches.
    return { state: parsed.state, updatedAt: updatedAt !== undefined && !Number.isNaN(updatedAt.getTime()) ? updatedAt : undefined };
};

// Start answers 200 with a small status body; a machine already running answers an error naming its state,
// which the caller treats as success via getMachine — hosted.ts owns that idempotence, not this client.
export const startMachine = async (token: string, app: string, machineId: string): Promise<void> => {
    await call(token, `POST`, `/apps/${encodeURIComponent(app)}/machines/${encodeURIComponent(machineId)}/start`);
};

// Replace a machine's whole config (Fly's update semantics: the posted config IS the new one, nothing is
// merged) — the warm pool's claim writes a sandbox's real identity into a machine built before it had one.
// Same image ⇒ no new pull, and the machine stays on its host, which is what keeps its volume attached.
export const updateMachine = async (token: string, app: string, machineId: string, config: FlyMachineConfig): Promise<void> => {
    // Keep the update and the power transition separate. Both warm-pool claims and explicit repairs update a
    // stopped machine, then use the ordinary idempotent start path; without skip_launch Fly starts as part of
    // the update and the following start is a provider error rather than the operation its caller requested.
    await call(token, `POST`, `/apps/${encodeURIComponent(app)}/machines/${encodeURIComponent(machineId)}`, { config, skip_launch: true });
};

export const stopMachine = async (token: string, app: string, machineId: string): Promise<void> => {
    await call(token, `POST`, `/apps/${encodeURIComponent(app)}/machines/${encodeURIComponent(machineId)}/stop`);
};
