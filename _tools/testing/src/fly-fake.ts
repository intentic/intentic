/* A FLY MACHINES API THAT REMEMBERS WHAT IT WAS TOLD, installed over `globalThis.fetch`.
 *
 * One fake for the seam, not one per suite. The platform's hosted lane talks to Fly through apps, machines, volumes
 * and snapshots whose states depend on each other — a volume cannot be forked smaller than its source, a machine that
 * was stopped does not answer `started`, a snapshot has to finish before it can be restored from — and a stub that
 * answers each request in isolation cannot express any of that. Six suites had grown their own, each true about a
 * different third of the provider, and none of them noticed when the client learned to extend a volume.
 *
 * What it models is exactly what `_platform/api/src/sandbox/hosted/fly/fly.ts` calls, and nothing else: an unrouted
 * request is a loud 404 rather than a cheerful `{ ok: true }`, because a fake that answers everything is a fake that
 * hides the call you got wrong.
 *
 * FAULTS are asked for by name (`faults`), never simulated by luck: a capacity refusal, a snapshot that never
 * finishes, a machine that will not start. Each is a real failure the engine has a branch for.
 */

/** A machine as this fake holds it; `exit` is what a probe or a killed process left behind. */
export interface FakeFlyMachine {
    readonly id: string;
    readonly app: string;
    region: string;
    state: string;
    config: Record<string, unknown>;
    createdAt: string;
    updatedAt: string;
    exit?: { exitCode?: number; oomKilled?: boolean };
}

export interface FakeFlyVolume {
    readonly id: string;
    readonly app: string;
    region: string;
    sizeGb: number;
    state: string;
    /** Bytes written, which a fork or a restore carries across and an extend leaves alone. */
    usedBytes: number;
}

export interface FakeFlySnapshot {
    readonly id: string;
    readonly volumeId: string;
    status: string;
    createdAt: string;
    sizeBytes: number;
}

/** One request the platform made, as the assertions read it: the method, the URL's path, and the decoded body. */
export interface FakeFlyCall {
    readonly method: string;
    readonly path: string;
    readonly url: string;
    readonly body?: unknown;
}

export interface FakeFlyFaults {
    /** Every `POST …/machines` and `POST …/volumes` is refused in Fly's own out-of-capacity words. */
    readonly atCapacity?: boolean;
    /** Snapshots are taken but never leave `running`, so nothing may be restored from one. */
    readonly snapshotNeverFinishes?: boolean;
    /** A start is accepted and the machine stays where it was: the shape of a host that will not take it. */
    readonly machineWontStart?: boolean;
    /** Every request answers this status with Fly's error envelope; for the "provider is down" branches. */
    readonly status?: number;
}

const BASE = "https://api.machines.dev/v1";

let counter = 0;
const nextId = (prefix: string): string => {
    counter += 1;
    return `${prefix}_${counter.toString(16).padStart(6, "0")}`;
};

export interface FakeFly {
    /** Every call made, in order, so a teardown's ordering can be asserted and not just its fact. */
    readonly calls: FakeFlyCall[];
    readonly apps: Set<string>;
    readonly machines: Map<string, FakeFlyMachine>;
    readonly volumes: Map<string, FakeFlyVolume>;
    readonly snapshots: Map<string, FakeFlySnapshot>;
    /** Turns faults on and off mid-test, for the cases where a call succeeds and the next one must not. */
    fail: (faults: FakeFlyFaults) => void;
    /** Seeds an app with one machine on one volume, which is what a provisioned sandbox is. */
    seedSandbox: (app: string, over?: { region?: string; sizeGb?: number; usedBytes?: number }) => { machine: FakeFlyMachine; volume: FakeFlyVolume };
    /** Only the calls matching this method and the END of the path; `/volumes/v/snapshots` is not a volume create. */
    called: (method: string, endsWith: string) => FakeFlyCall[];
    /** Where that call sits in the order, or -1; the one way to assert "after" rather than "also". */
    indexOf: (method: string, endsWith: string) => number;
}

/**
 * Installs the fake over `globalThis.fetch`. Requests to anything but Fly are passed through to the real one, so a
 * suite that also speaks to Stripe or an edge keeps working; `vi.unstubAllGlobals()` takes it away again.
 */
export const installFakeFly = (
    stub: (name: string, value: unknown) => void,
    options: { readonly faults?: FakeFlyFaults; readonly passThrough?: typeof fetch } = {},
): FakeFly => {
    const calls: FakeFlyCall[] = [];
    const apps = new Set<string>();
    const machines = new Map<string, FakeFlyMachine>();
    const volumes = new Map<string, FakeFlyVolume>();
    const snapshots = new Map<string, FakeFlySnapshot>();
    let faults: FakeFlyFaults = options.faults ?? {};
    const passThrough = options.passThrough ?? globalThis.fetch;

    const now = (): string => new Date().toISOString();
    const json = (payload: unknown, status = 200): Response =>
        new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
    const refuse = (status: number, message: string): Response => json({ error: message }, status);

    const wireMachine = (machine: FakeFlyMachine) => ({
        id: machine.id,
        state: machine.state,
        region: machine.region,
        created_at: machine.createdAt,
        updated_at: machine.updatedAt,
        config: machine.config,
        image_ref: { digest: `sha256:${machine.id}` },
        ...(machine.exit === undefined
            ? {}
            : { events: [{ type: "exit", timestamp: 1, request: { exit_event: { exit_code: machine.exit.exitCode, oom_killed: machine.exit.oomKilled } } }] }),
    });

    const wireVolume = (volume: FakeFlyVolume) => ({
        id: volume.id,
        name: "data",
        size_gb: volume.sizeGb,
        state: volume.state,
        region: volume.region,
        block_size: 4096,
        blocks: Math.ceil((volume.sizeGb * 1024 ** 3) / 4096),
        blocks_avail: Math.ceil((volume.sizeGb * 1024 ** 3 - volume.usedBytes) / 4096),
    });

    const wireSnapshot = (snapshot: FakeFlySnapshot) => ({
        id: snapshot.id,
        status: snapshot.status,
        created_at: snapshot.createdAt,
        size: snapshot.sizeBytes,
    });

    /** Where a new volume's bytes come from: the volume it forks, or the one its snapshot was taken of. */
    const originOf = (body: Record<string, unknown>): FakeFlyVolume | undefined => {
        const forked = volumes.get(String(body["source_volume_id"] ?? ""));
        if (forked !== undefined) {
            return forked;
        }
        const from = snapshots.get(String(body["snapshot_id"] ?? ""));
        return from === undefined ? undefined : volumes.get(from.volumeId);
    };

    /** Why Fly would refuse this volume create, in its own words; undefined when it would take it. */
    const volumeRefusal = (body: Record<string, unknown>, origin: FakeFlyVolume | undefined): string | undefined => {
        if (faults.atCapacity === true) {
            return "insufficient capacity to create the volume";
        }
        const from = snapshots.get(String(body["snapshot_id"] ?? ""));
        if (from !== undefined && from.status !== "created") {
            return `snapshot ${from.id} is not ready to restore from`;
        }
        // Fly restores and forks only into an equal-or-larger volume; this is what makes a downgrade keep its disk.
        return origin !== undefined && Number(body["size_gb"] ?? 0) < origin.sizeGb
            ? "volume size must be greater than or equal to the source"
            : undefined;
    };

    /* POST /apps/{app}/volumes: a create, a fork (`source_volume_id`) or a restore (`snapshot_id`). The copy carries
     * the source's used bytes across, which is what makes "did the data move" answerable from outside the guest. */
    const createVolume = (app: string, body: Record<string, unknown>): Response => {
        const origin = originOf(body);
        const refusal = volumeRefusal(body, origin);
        if (refusal !== undefined) {
            return refuse(422, refusal);
        }
        const volume: FakeFlyVolume = {
            id: nextId("vol"),
            app,
            region: String(body["region"] ?? origin?.region ?? "iad"),
            sizeGb: Number(body["size_gb"] ?? 0),
            state: "created",
            usedBytes: origin?.usedBytes ?? 0,
        };
        volumes.set(volume.id, volume);
        return json(wireVolume(volume));
    };

    const createMachine = (app: string, body: Record<string, unknown>): Response => {
        if (faults.atCapacity === true) {
            return refuse(422, "reached the limit of machines for this organization");
        }
        const machine: FakeFlyMachine = {
            id: nextId("m"),
            app,
            region: String(body["region"] ?? "iad"),
            // Created and running, which is what Fly answers for a machine with no `skip_launch`.
            state: faults.machineWontStart === true ? "created" : "started",
            config: (body["config"] ?? {}) as Record<string, unknown>,
            createdAt: now(),
            updatedAt: now(),
        };
        machines.set(machine.id, machine);
        return json(wireMachine(machine));
    };

    const deleteApp = (app: string): Response => {
        apps.delete(app);
        for (const [key, machine] of machines) {
            if (machine.app === app) {
                machines.delete(key);
            }
        }
        for (const [key, volume] of volumes) {
            if (volume.app === app) {
                volumes.delete(key);
            }
        }
        return new Response("", { status: 202 });
    };

    /* A ROUTE TABLE RATHER THAN A CHAIN OF IFS, in the order fly.ts asks them. `found` narrows the id to the thing
     * it names or answers Fly's own 404, so no handler below repeats that. */
    const found = <T>(held: Map<string, T>, id: string, what: string, handle: (item: T) => Response): Response => {
        const item = held.get(id);
        return item === undefined ? refuse(404, `${what} '${id}' not found`) : handle(item);
    };

    interface Route {
        readonly method: string;
        readonly pattern: RegExp;
        readonly handle: (match: RegExpExecArray, body: Record<string, unknown>) => Response;
    }

    const routes: Route[] = [
        { method: "GET", pattern: /^\/v1\/apps$/u, handle: () => json({ apps: [...apps].map((name) => ({ name })) }) },
        {
            method: "POST",
            pattern: /^\/v1\/apps$/u,
            handle: (_match, body) => {
                apps.add(String(body["app_name"] ?? ""));
                return json({ id: nextId("app") });
            },
        },
        {
            method: "GET",
            pattern: /^\/v1\/apps\/([^/]+)$/u,
            handle: (match) => (apps.has(match[1] as string) ? json({ name: match[1] }) : refuse(404, `App '${match[1] ?? ""}' not found`)),
        },
        { method: "DELETE", pattern: /^\/v1\/apps\/([^/]+)$/u, handle: (match) => deleteApp(match[1] as string) },

        {
            method: "GET",
            pattern: /^\/v1\/apps\/([^/]+)\/volumes$/u,
            handle: (match) => json([...volumes.values()].filter((volume) => volume.app === match[1]).map(wireVolume)),
        },
        { method: "POST", pattern: /^\/v1\/apps\/([^/]+)\/volumes$/u, handle: (match, body) => createVolume(match[1] as string, body) },
        {
            method: "GET",
            pattern: /^\/v1\/apps\/[^/]+\/volumes\/([^/]+)$/u,
            handle: (match) => found(volumes, match[1] as string, "Volume", (volume) => json(wireVolume(volume))),
        },
        {
            method: "DELETE",
            pattern: /^\/v1\/apps\/[^/]+\/volumes\/([^/]+)$/u,
            handle: (match) =>
                found(volumes, match[1] as string, "Volume", (volume) => {
                    volumes.delete(volume.id);
                    return new Response("", { status: 200 });
                }),
        },
        {
            method: "PUT",
            pattern: /^\/v1\/apps\/[^/]+\/volumes\/([^/]+)\/extend$/u,
            handle: (match, body) =>
                found(volumes, match[1] as string, "Volume", (volume) => {
                    const sizeGb = Number(body["size_gb"] ?? 0);
                    if (sizeGb < volume.sizeGb) {
                        return refuse(422, "volumes can only be extended");
                    }
                    volume.sizeGb = sizeGb;
                    return json({ volume: wireVolume(volume), needs_restart: true });
                }),
        },
        {
            method: "GET",
            pattern: /^\/v1\/apps\/[^/]+\/volumes\/([^/]+)\/snapshots$/u,
            handle: (match) => json([...snapshots.values()].filter((snapshot) => snapshot.volumeId === match[1]).map(wireSnapshot)),
        },
        {
            method: "POST",
            pattern: /^\/v1\/apps\/[^/]+\/volumes\/([^/]+)\/snapshots$/u,
            handle: (match) =>
                found(volumes, match[1] as string, "Volume", (volume) => {
                    const snapshot: FakeFlySnapshot = {
                        id: nextId("vs"),
                        volumeId: volume.id,
                        status: faults.snapshotNeverFinishes === true ? "running" : "created",
                        createdAt: now(),
                        sizeBytes: volume.usedBytes,
                    };
                    snapshots.set(snapshot.id, snapshot);
                    return json(wireSnapshot(snapshot));
                }),
        },

        {
            method: "GET",
            pattern: /^\/v1\/apps\/([^/]+)\/machines$/u,
            handle: (match) => json([...machines.values()].filter((machine) => machine.app === match[1]).map(wireMachine)),
        },
        { method: "POST", pattern: /^\/v1\/apps\/([^/]+)\/machines$/u, handle: (match, body) => createMachine(match[1] as string, body) },
        {
            method: "GET",
            pattern: /^\/v1\/apps\/[^/]+\/machines\/([^/]+)$/u,
            handle: (match) => found(machines, match[1] as string, "Machine", (machine) => json(wireMachine(machine))),
        },
        {
            method: "POST",
            pattern: /^\/v1\/apps\/[^/]+\/machines\/([^/]+)$/u,
            handle: (match, body) =>
                // A config replacement leaves a stopped machine stopped; the caller's own start is the real operation.
                found(machines, match[1] as string, "Machine", (machine) => {
                    machine.config = (body["config"] ?? machine.config) as Record<string, unknown>;
                    machine.updatedAt = now();
                    return json(wireMachine(machine));
                }),
        },
        {
            method: "DELETE",
            pattern: /^\/v1\/apps\/[^/]+\/machines\/([^/]+)$/u,
            handle: (match) =>
                found(machines, match[1] as string, "Machine", (machine) => {
                    machines.delete(machine.id);
                    return new Response("", { status: 200 });
                }),
        },
        {
            method: "POST",
            pattern: /^\/v1\/apps\/[^/]+\/machines\/([^/]+)\/start$/u,
            handle: (match) =>
                found(machines, match[1] as string, "Machine", (machine) => {
                    machine.state = faults.machineWontStart === true ? "stopped" : "started";
                    machine.updatedAt = now();
                    return json({ ok: true });
                }),
        },
        {
            method: "POST",
            pattern: /^\/v1\/apps\/[^/]+\/machines\/([^/]+)\/stop$/u,
            handle: (match) =>
                found(machines, match[1] as string, "Machine", (machine) => {
                    machine.state = "stopped";
                    machine.updatedAt = now();
                    return json({ ok: true });
                }),
        },
        { method: "POST", pattern: /^\/v1\/apps\/[^/]+\/machines\/[^/]+\/metadata\/[^/]+$/u, handle: () => json({ ok: true }) },
    ];

    // An unmatched request is a loud 404 naming it, never a cheerful `{ ok: true }`: a fake that answers everything
    // is a fake that hides the call you got wrong.
    const answer = (method: string, path: string, body: Record<string, unknown>): Response => {
        for (const route of routes) {
            const match = route.method === method ? route.pattern.exec(path) : null;
            if (match !== null) {
                return route.handle(match, body);
            }
        }
        return refuse(404, `fake fly: nothing is mounted at ${method} ${path}`);
    };

    const urlOf = (input: RequestInfo | URL): string => {
        if (typeof input === "string") {
            return input;
        }
        return input instanceof URL ? input.href : input.url;
    };

    stub("fetch", (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = urlOf(input);
        if (!url.startsWith(BASE)) {
            return passThrough(input as RequestInfo, init);
        }
        const method = init?.method ?? "GET";
        const sent = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
        const { pathname } = new URL(url);
        calls.push({ method, path: pathname, url, ...(sent === undefined ? {} : { body: sent }) });
        return Promise.resolve(
            faults.status === undefined
                ? answer(method, pathname, sent ?? {})
                : refuse(faults.status, `fake fly: refusing every call with ${faults.status}`),
        );
    });

    const matches = (call: FakeFlyCall, method: string, endsWith: string): boolean => call.method === method && call.path.endsWith(endsWith);

    return {
        calls,
        apps,
        machines,
        volumes,
        snapshots,
        fail: (next) => {
            faults = next;
        },
        seedSandbox: (app, over = {}) => {
            apps.add(app);
            const volume: FakeFlyVolume = {
                id: nextId("vol"),
                app,
                region: over.region ?? "iad",
                sizeGb: over.sizeGb ?? 10,
                state: "created",
                usedBytes: over.usedBytes ?? 2 * 1024 ** 3,
            };
            volumes.set(volume.id, volume);
            const machine: FakeFlyMachine = {
                id: nextId("m"),
                app,
                region: volume.region,
                state: "started",
                config: { mounts: [{ volume: volume.id, path: "/data" }] },
                createdAt: now(),
                updatedAt: now(),
            };
            machines.set(machine.id, machine);
            return { machine, volume };
        },
        called: (method, endsWith) => calls.filter((call) => matches(call, method, endsWith)),
        indexOf: (method, endsWith) => calls.findIndex((call) => matches(call, method, endsWith)),
    };
};
