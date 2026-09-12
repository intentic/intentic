import { afterEach, describe, expect, it, vi } from "vitest";
import { flyMachineConfig } from "@intentic/sandbox-run/fly";
import {
    createApp,
    createMachine,
    createVolume,
    deleteApp,
    FlyError,
    getMachine,
    isFlyCapacity,
    isFlyGone,
    listAppNames,
    startMachine,
    updateMachine,
} from "./fly.js";

// Routes by method + URL substring; records each call for payload assertions.
const stubFetch = (routes: { match: (method: string, url: string) => boolean; respond: () => Response }[]) => {
    const calls: { method: string; url: string; body?: unknown }[] = [];
    vi.stubGlobal(`fetch`, (url: URL | string, init?: RequestInit): Promise<Response> => {
        const method = init?.method ?? `GET`;
        calls.push({ method, url: String(url), ...(typeof init?.body === `string` ? { body: JSON.parse(init.body) } : {}) });
        const route = routes.find((candidate) => candidate.match(method, String(url)));
        if (!route) {
            throw new Error(`unexpected fetch: ${method} ${String(url)}`);
        }
        return Promise.resolve(route.respond());
    });
    return calls;
};

const json = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), { status });

afterEach(() => {
    vi.unstubAllGlobals();
});

describe(`fly`, () => {
    it(`creates the app on its OWN network: hosted sandboxes must not share the org's 6PN`, async () => {
        const calls = stubFetch([{ match: (method, url) => method === `POST` && url.endsWith(`/apps`), respond: () => json({ id: `app1` }) }]);
        await createApp(`tok`, `intentic`, `intentic-sbx-abc`);
        expect(calls[0]?.body).toEqual({ app_name: `intentic-sbx-abc`, org_slug: `intentic`, network: `intentic-sbx-abc` });
    });

    it(`creates the volume and machine and reads back their ids`, async () => {
        const config = flyMachineConfig({
            name: `intentic-sbx-abc`,
            image: `ghcr.io/intentic/sandbox:stable`,
            baseImage: `ghcr.io/intentic/sandbox:stable`,
            guest: { cpus: 4, memoryMb: 8192 },
            volumeId: `vol_1`,
        });
        const calls = stubFetch([
            { match: (method, url) => method === `POST` && url.includes(`/volumes`), respond: () => json({ id: `vol_1` }) },
            {
                match: (method, url) => method === `POST` && url.includes(`/machines`),
                respond: () => json({ id: `mach_1`, state: `created`, instance_id: `inst_1` }),
            },
        ]);
        expect(await createVolume(`tok`, `intentic-sbx-abc`, `iad`, 20)).toEqual({ volumeId: `vol_1` });
        // instanceId is what a build row records to distinguish builder runs.
        expect(await createMachine(`tok`, `intentic-sbx-abc`, { name: `intentic-sbx-abc`, region: `iad`, config })).toEqual({
            machineId: `mach_1`,
            instanceId: `inst_1`,
        });
        expect(calls[0]?.body).toEqual({ name: `data`, region: `iad`, size_gb: 20 });
        const machineBody = calls[1]?.body as { config: { mounts: unknown } };
        expect(machineBody.config.mounts).toEqual([{ volume: `vol_1`, path: `/data` }]);
    });

    it(`lists app names and tolerates delete's empty body`, async () => {
        const calls = stubFetch([
            {
                match: (method, url) => method === `GET` && url.includes(`/apps?org_slug=`),
                respond: () => json({ apps: [{ name: `a` }, { name: `b` }] }),
            },
            { match: (method) => method === `DELETE`, respond: () => new Response(``, { status: 202 }) },
        ]);
        expect(await listAppNames(`tok`, `intentic`)).toEqual([`a`, `b`]);
        await expect(deleteApp(`tok`, `a`)).resolves.toBeUndefined();
        expect(calls.at(-1)).toMatchObject({ method: `DELETE`, url: `https://api.machines.dev/v1/apps/a?force=true` });
    });

    it(`reads machine state and starts machines`, async () => {
        const calls = stubFetch([
            { match: (method, url) => method === `GET` && url.includes(`/machines/`), respond: () => json({ id: `m1`, state: `stopped` }) },
            { match: (method, url) => method === `POST` && url.endsWith(`/start`), respond: () => json({ ok: true }) },
        ]);
        expect(await getMachine(`tok`, `app`, `m1`)).toEqual({ state: `stopped` });
        await startMachine(`tok`, `app`, `m1`);
        expect(calls).toHaveLength(2);
    });

    it(`launches the machine with the replaced config, never as a separate start`, async () => {
        const config = flyMachineConfig({
            name: `app`,
            image: `ghcr.io/intentic/sandbox:stable`,
            baseImage: `ghcr.io/intentic/sandbox:stable`,
            guest: { cpus: 2, memoryMb: 4096 },
            volumeId: `vol_1`,
        });
        const calls = stubFetch([{ match: (method, url) => method === `POST` && url.endsWith(`/machines/m1`), respond: () => json({ ok: true }) }]);
        await updateMachine(`tok`, `app`, `m1`, config);
        expect(calls[0]?.body).toEqual({ config });
    });

    it(`fails a hung Fly call as a status-less FlyError, so nothing reads it as "gone"`, async () => {
        vi.stubGlobal(`fetch`, (_url: URL | string, init?: RequestInit): Promise<Response> => {
            // What AbortSignal.timeout produces when it fires; undici rejects with this shape.
            const aborted = new Error(`The operation was aborted due to timeout`);
            aborted.name = `TimeoutError`;
            expect(init?.signal).toBeInstanceOf(AbortSignal);
            return Promise.reject(aborted);
        });
        const failure = await getMachine(`tok`, `app`, `m1`).catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(FlyError);
        expect((failure as FlyError).status).toBeUndefined();
        expect(isFlyGone(failure)).toBe(false);
        expect((failure as FlyError).message).toMatch(/did not answer GET .*within 30s/);
    });

    it(`names the operator's problem on 401 and relays Fly's refusal otherwise`, async () => {
        stubFetch([
            { match: (_method, url) => url.includes(`/volumes`), respond: () => json({ error: `region has no capacity` }, 422) },
            { match: (method) => method === `POST`, respond: () => json({ error: `unauthorized` }, 401) },
        ]);
        await expect(createVolume(`tok`, `app`, `iad`, 20)).rejects.toThrow(/region has no capacity/);
        await expect(createApp(`tok`, `intentic`, `app`)).rejects.toThrow(FlyError);
        await expect(createApp(`tok`, `intentic`, `app`)).rejects.toThrow(/HOSTED_FLY_API_TOKEN/);
    });

    // isFlyCapacity matches on Fly's error text, since it has no status code for out-of-capacity refusals across org,
    // region, and volume placement.
    describe(`isFlyCapacity`, () => {
        it(`recognises the provider having nothing left, however it says it`, async () => {
            stubFetch([
                {
                    match: (_method, url) => url.includes(`/machines`),
                    respond: () => json({ error: `failed to launch VM: You have reached the maximum number of machines for this app` }, 422),
                },
                { match: (_method, url) => url.includes(`/volumes`), respond: () => json({ error: `insufficient capacity in iad` }, 422) },
            ]);
            const machineConfig = flyMachineConfig({
                name: `app`,
                image: `ghcr.io/intentic/sandbox:stable`,
                baseImage: `ghcr.io/intentic/sandbox:stable`,
                guest: { cpus: 2, memoryMb: 4096 },
                volumeId: `vol_1`,
            });
            const refused = await createMachine(`tok`, `app`, { name: `app`, region: `iad`, config: machineConfig }).catch((error: unknown) => error);
            const placed = await createVolume(`tok`, `app`, `iad`, 20).catch((error: unknown) => error);
            expect(isFlyCapacity(refused)).toBe(true);
            expect(isFlyCapacity(placed)).toBe(true);
        });

        it(`is not fooled by the refusals that mean something else entirely`, async () => {
            stubFetch([
                { match: (method, url) => method === `POST` && url.endsWith(`/apps`), respond: () => json({ error: `unauthorized` }, 401) },
                { match: (method, url) => method === `GET` && url.includes(`/machines/`), respond: () => json({ error: `not found` }, 404) },
            ]);
            const rejected = await createApp(`tok`, `intentic`, `app`).catch((error: unknown) => error);
            const gone = await getMachine(`tok`, `app`, `m1`).catch((error: unknown) => error);
            expect(isFlyCapacity(rejected)).toBe(false);
            expect(isFlyCapacity(gone)).toBe(false);
            // A timeout carries no status text and must never be read as a capacity refusal.
            expect(isFlyCapacity(new FlyError(`Fly did not answer POST /machines within 30s`))).toBe(false);
        });
    });
});
