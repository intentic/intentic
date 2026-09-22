import { describe, it, expect, afterEach } from "bun:test";
import { stubGlobal, unstubAllGlobals } from "@intentic/testing/bun";
import { flyMachineConfig } from "@intentic/sandbox-run/fly";
import {
    createApp,
    createMachine,
    createVolume,
    createVolumeSnapshot,
    deleteApp,
    destroyVolume,
    extendVolume,
    getVolume,
    listVolumeSnapshots,
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
    stubGlobal(`fetch`, (url: URL | string, init?: RequestInit): Promise<Response> => {
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
    unstubAllGlobals();
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
            guest: { cpuKind: `shared`, cpus: 4, memoryMb: 8192 },
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
            guest: { cpuKind: `shared`, cpus: 2, memoryMb: 4096 },
            volumeId: `vol_1`,
        });
        const calls = stubFetch([{ match: (method, url) => method === `POST` && url.endsWith(`/machines/m1`), respond: () => json({ ok: true }) }]);
        await updateMachine(`tok`, `app`, `m1`, config);
        expect(calls[0]?.body).toEqual({ config });
    });

    it(`fails a hung Fly call as a status-less FlyError, so nothing reads it as "gone"`, async () => {
        stubGlobal(`fetch`, (_url: URL | string, init?: RequestInit): Promise<Response> => {
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
                guest: { cpuKind: `shared`, cpus: 2, memoryMb: 4096 },
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

// The calls a migration is made of. Each is one request with one shape, and the shapes are Fly's own: a mistyped key
// is a silent no-op there, not a refusal, which is why the payloads are asserted rather than the round trip.
describe(`the volume calls a migration needs`, () => {
    it(`forks a volume into a region, at a size, on a host with room for the guest that will mount it`, async () => {
        const calls = stubFetch([{ match: (method, url) => method === `POST` && url.endsWith(`/volumes`), respond: () => json({ id: `vol_2` }) }]);
        const { volumeId } = await createVolume(`tok`, `app`, `arn`, 25, {
            sourceVolumeId: `vol_1`,
            compute: { cpuKind: `shared`, cpus: 8, memoryMb: 8192 },
            snapshotRetention: 7,
        });
        expect(volumeId).toBe(`vol_2`);
        expect(calls[0]?.body).toEqual({
            name: `data`,
            region: `arn`,
            size_gb: 25,
            source_volume_id: `vol_1`,
            snapshot_retention: 7,
            compute: { cpu_kind: `shared`, cpus: 8, memory_mb: 8192 },
        });
    });

    it(`restores from a snapshot instead, and sends neither key when neither was asked for`, async () => {
        const calls = stubFetch([{ match: (method, url) => method === `POST` && url.endsWith(`/volumes`), respond: () => json({ id: `vol_3` }) }]);
        await createVolume(`tok`, `app`, `iad`, 10, { snapshotId: `vs_1` });
        await createVolume(`tok`, `app`, `iad`, 10);
        expect(calls[0]?.body).toEqual({ name: `data`, region: `iad`, size_gb: 10, snapshot_id: `vs_1` });
        expect(calls[1]?.body).toEqual({ name: `data`, region: `iad`, size_gb: 10 });
    });

    it(`reads a volume's size and what is used of it, from the block counts`, async () => {
        stubFetch([
            {
                match: (method, url) => method === `GET` && url.includes(`/volumes/vol_1`),
                respond: () => json({ id: `vol_1`, size_gb: 10, state: `created`, block_size: 4096, blocks: 2_500_000, blocks_avail: 2_000_000 }),
            },
        ]);
        // 500,000 blocks of 4 KiB: just over 2 GB of a 10 GB disk.
        expect(await getVolume(`tok`, `app`, `vol_1`)).toEqual({ id: `vol_1`, sizeGb: 10, state: `created`, usedBytes: 2_048_000_000 });
    });

    // A volume mid-restore reports no blocks at all; answering 0 used would read as an empty disk, which it is not.
    it(`says it does not know how much is used, rather than guessing zero`, async () => {
        stubFetch([
            {
                match: (method, url) => method === `GET` && url.includes(`/volumes/vol_1`),
                respond: () => json({ id: `vol_1`, size_gb: 10, state: `restoring` }),
            },
        ]);
        expect((await getVolume(`tok`, `app`, `vol_1`)).usedBytes).toBeUndefined();
    });

    it(`extends a volume and reports whether the filesystem needs the machine restarted to see it`, async () => {
        const calls = stubFetch([
            {
                match: (method, url) => method === `PUT` && url.endsWith(`/extend`),
                respond: () => json({ volume: { id: `vol_1`, size_gb: 25, state: `created` }, needs_restart: true }),
            },
        ]);
        expect(await extendVolume(`tok`, `app`, `vol_1`, 25)).toEqual({ needsRestart: true });
        expect(calls[0]?.body).toEqual({ size_gb: 25 });
    });

    it(`takes a snapshot on demand and reads its state back`, async () => {
        stubFetch([
            {
                match: (method, url) => method === `POST` && url.endsWith(`/snapshots`),
                respond: () => json({ id: `vs_9`, status: `waiting`, created_at: `2026-09-20T10:00:00Z` }),
            },
        ]);
        expect(await createVolumeSnapshot(`tok`, `app`, `vol_1`)).toEqual({
            id: `vs_9`,
            status: `waiting`,
            createdAt: new Date(`2026-09-20T10:00:00Z`),
            sizeBytes: undefined,
        });
    });

    // Newest first, because the only question ever asked of this list is "when was the last backup".
    it(`lists snapshots newest first`, async () => {
        stubFetch([
            {
                match: (method, url) => method === `GET` && url.endsWith(`/snapshots`),
                respond: () =>
                    json([
                        { id: `vs_old`, status: `created`, created_at: `2026-09-18T10:00:00Z`, size: 100 },
                        { id: `vs_new`, status: `created`, created_at: `2026-09-20T10:00:00Z`, size: 40 },
                    ]),
            },
        ]);
        expect((await listVolumeSnapshots(`tok`, `app`, `vol_1`)).map((snapshot) => snapshot.id)).toEqual([`vs_new`, `vs_old`]);
    });

    // Delete's contract is "not there any more", and a volume already gone satisfies it.
    it(`destroys a volume, and counts one that is already gone as destroyed`, async () => {
        const calls = stubFetch([
            { match: (method, url) => method === `DELETE` && url.includes(`/volumes/vol_1`), respond: () => new Response(``, { status: 200 }) },
            { match: (method, url) => method === `DELETE` && url.includes(`/volumes/vol_gone`), respond: () => json({ error: `not found` }, 404) },
        ]);
        await destroyVolume(`tok`, `app`, `vol_1`);
        await destroyVolume(`tok`, `app`, `vol_gone`);
        expect(calls).toHaveLength(2);
    });
});
