import { afterEach, describe, expect, it, vi } from "vitest";
import { flyMachineConfig } from "@intentic/sandbox-run/fly";
import { createApp, createMachine, createVolume, deleteApp, FlyError, getMachine, listAppNames, startMachine } from "./fly.js";

// The cloud.test.ts fetch stub: route by method + URL substring, record calls for payload assertions.
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
    it(`creates the app on its OWN network — hosted sandboxes must not share the org's 6PN`, async () => {
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
            { match: (method, url) => method === `POST` && url.includes(`/machines`), respond: () => json({ id: `mach_1`, state: `created` }) },
        ]);
        expect(await createVolume(`tok`, `intentic-sbx-abc`, `iad`, 20)).toEqual({ volumeId: `vol_1` });
        expect(await createMachine(`tok`, `intentic-sbx-abc`, { name: `intentic-sbx-abc`, region: `iad`, config })).toEqual({
            machineId: `mach_1`,
        });
        expect(calls[0]?.body).toEqual({ name: `data`, region: `iad`, size_gb: 20 });
        const machineBody = calls[1]?.body as { config: { mounts: unknown } };
        expect(machineBody.config.mounts).toEqual([{ volume: `vol_1`, path: `/data` }]);
    });

    it(`lists app names and tolerates delete's empty body`, async () => {
        stubFetch([
            {
                match: (method, url) => method === `GET` && url.includes(`/apps?org_slug=`),
                respond: () => json({ apps: [{ name: `a` }, { name: `b` }] }),
            },
            { match: (method) => method === `DELETE`, respond: () => new Response(``, { status: 202 }) },
        ]);
        expect(await listAppNames(`tok`, `intentic`)).toEqual([`a`, `b`]);
        await expect(deleteApp(`tok`, `a`)).resolves.toBeUndefined();
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

    it(`names the operator's problem on 401 and relays Fly's refusal otherwise`, async () => {
        stubFetch([
            { match: (_method, url) => url.includes(`/volumes`), respond: () => json({ error: `region has no capacity` }, 422) },
            { match: (method) => method === `POST`, respond: () => json({ error: `unauthorized` }, 401) },
        ]);
        await expect(createVolume(`tok`, `app`, `iad`, 20)).rejects.toThrow(/region has no capacity/);
        await expect(createApp(`tok`, `intentic`, `app`)).rejects.toThrow(FlyError);
        await expect(createApp(`tok`, `intentic`, `app`)).rejects.toThrow(/HOSTED_FLY_API_TOKEN/);
    });
});
