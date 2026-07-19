import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    CloudflareTokenError,
    deleteSandboxTunnel,
    ensurePreviewRoute,
    listZoneNames,
    provisionHostSshTunnel,
    provisionSandboxTunnel,
    reapStaleTunnels,
} from "./cloudflare.js";

// Canned Cloudflare success envelope.
const ok = (result: unknown, resultInfo?: { total_pages: number }) =>
    new Response(JSON.stringify({ success: true, errors: [], result, ...(resultInfo ? { result_info: resultInfo } : {}) }));

// Canned Cloudflare error envelope (e.g. 1022 = tunnel has active connections). A non-2xx + success:false makes
// cfCall throw CloudflareApiError carrying the numeric code.
const cfError = (code: number, status = 400) =>
    new Response(JSON.stringify({ success: false, errors: [{ code, message: `err ${code}` }], result: null }), { status });

// Route the stubbed fetch by method + URL substring, recording calls for order/payload assertions.
const stubFetch = (routes: { match: (method: string, url: string) => boolean; respond: () => Response }[]) => {
    const calls: { method: string; url: string; body?: unknown }[] = [];
    vi.stubGlobal(`fetch`, (url: string, init?: RequestInit): Promise<Response> => {
        const method = init?.method ?? `GET`;
        calls.push({ method, url, ...(typeof init?.body === `string` ? { body: JSON.parse(init.body) } : {}) });
        const route = routes.find((candidate) => candidate.match(method, url));
        if (!route) {
            throw new Error(`unexpected fetch: ${method} ${url}`);
        }
        return Promise.resolve(route.respond());
    });
    return calls;
};

afterEach(() => {
    vi.unstubAllGlobals();
});

describe(`listZoneNames`, () => {
    it(`walks every page and collects zone names`, async () => {
        stubFetch([
            { match: (_, url) => url.includes(`page=1`), respond: () => ok([{ name: `one.com` }], { total_pages: 2 }) },
            { match: (_, url) => url.includes(`page=2`), respond: () => ok([{ name: `two.com` }], { total_pages: 2 }) },
        ]);
        await expect(listZoneNames(`token`)).resolves.toEqual([`one.com`, `two.com`]);
    });

    it(`maps 401/403 to CloudflareTokenError and surfaces API error envelopes`, async () => {
        stubFetch([{ match: () => true, respond: () => new Response(``, { status: 403 }) }]);
        await expect(listZoneNames(`bad`)).rejects.toBeInstanceOf(CloudflareTokenError);

        vi.unstubAllGlobals();
        stubFetch([
            {
                match: () => true,
                respond: () =>
                    new Response(JSON.stringify({ success: false, errors: [{ code: 9109, message: `nope` }], result: null }), { status: 400 }),
            },
        ]);
        await expect(listZoneNames(`token`)).rejects.toThrow(`9109 nope`);
    });
});

describe(`provisionSandboxTunnel`, () => {
    const zone = `example.com`;
    const connectToken = `connect-token`;
    const id = createHash(`sha256`).update(connectToken).digest(`hex`).slice(0, 12);
    const hostname = `sandbox-${id}.${zone}`;
    const sshHostname = `ssh-${id}.${zone}`;

    it(`creates the tunnel, routes the daemon + sshd, and creates both DNS records when none exist`, async () => {
        const calls = stubFetch([
            { match: (method, url) => method === `GET` && url.includes(`/zones?name=`), respond: () => ok([{ id: `z1`, account: { id: `a1` } }]) },
            { match: (method, url) => method === `GET` && url.includes(`/cfd_tunnel?name=`), respond: () => ok([]) },
            { match: (method, url) => method === `POST` && url.endsWith(`/cfd_tunnel`), respond: () => ok({ id: `t1` }) },
            { match: (method, url) => method === `GET` && url.endsWith(`/cfd_tunnel/t1/token`), respond: () => ok(`connector-token`) },
            { match: (method, url) => method === `PUT` && url.endsWith(`/cfd_tunnel/t1/configurations`), respond: () => ok({}) },
            { match: (method, url) => method === `GET` && url.includes(`/dns_records?type=CNAME`), respond: () => ok([]) },
            { match: (method, url) => method === `POST` && url.endsWith(`/dns_records`), respond: () => ok({}) },
        ]);

        const result = await provisionSandboxTunnel({ apiToken: `api`, zone, connectToken });

        expect(result).toEqual({ hostname, tunnelToken: `connector-token` });
        const ingress = calls.find((call) => call.url.endsWith(`/configurations`))!.body as {
            config: { ingress: { hostname?: string; service: string }[] };
        };
        expect(ingress.config.ingress[0]).toEqual({ hostname, service: `http://intentic-sandbox-workspace:8787` });
        expect(ingress.config.ingress[1]).toEqual({ hostname: sshHostname, service: `ssh://intentic-sandbox-workspace:22` });
        const dns = calls
            .filter((call) => call.method === `POST` && call.url.endsWith(`/dns_records`))
            .map((call) => call.body as Record<string, unknown>);
        expect(dns).toHaveLength(2);
        expect(dns[0]).toMatchObject({ type: `CNAME`, name: hostname, content: `t1.cfargotunnel.com`, proxied: true });
        expect(dns[1]).toMatchObject({ type: `CNAME`, name: sshHostname, content: `t1.cfargotunnel.com`, proxied: true });
    });

    it(`reuses an existing tunnel and updates an existing DNS record in place`, async () => {
        const calls = stubFetch([
            { match: (method, url) => method === `GET` && url.includes(`/zones?name=`), respond: () => ok([{ id: `z1`, account: { id: `a1` } }]) },
            { match: (method, url) => method === `GET` && url.includes(`/cfd_tunnel?name=`), respond: () => ok([{ id: `t9` }]) },
            { match: (method, url) => method === `GET` && url.endsWith(`/cfd_tunnel/t9/token`), respond: () => ok(`connector-token`) },
            { match: (method, url) => method === `PUT` && url.endsWith(`/cfd_tunnel/t9/configurations`), respond: () => ok({}) },
            { match: (method, url) => method === `GET` && url.includes(`/dns_records?type=CNAME`), respond: () => ok([{ id: `r1` }]) },
            { match: (method, url) => method === `PUT` && url.endsWith(`/dns_records/r1`), respond: () => ok({}) },
        ]);

        await provisionSandboxTunnel({ apiToken: `api`, zone, connectToken });

        expect(calls.some((call) => call.method === `POST`)).toBe(false);
    });

    it(`fails clearly when the configured zone is not visible to the token`, async () => {
        stubFetch([{ match: () => true, respond: () => ok([]) }]);
        await expect(provisionSandboxTunnel({ apiToken: `api`, zone, connectToken })).rejects.toThrow(`was not found`);
    });
});

describe(`deleteSandboxTunnel`, () => {
    const zone = `example.com`;
    const connectToken = `connect-token`;

    it(`clears the tunnel's connections before deleting it, then removes its CNAMEs`, async () => {
        const calls = stubFetch([
            { match: (method, url) => method === `GET` && url.includes(`/zones?name=`), respond: () => ok([{ id: `z1`, account: { id: `a1` } }]) },
            { match: (method, url) => method === `GET` && url.includes(`/cfd_tunnel?name=`), respond: () => ok([{ id: `t1` }]) },
            { match: (method, url) => method === `DELETE` && url.endsWith(`/cfd_tunnel/t1/connections`), respond: () => ok({}) },
            { match: (method, url) => method === `DELETE` && url.endsWith(`/cfd_tunnel/t1`), respond: () => ok({}) },
            { match: (method, url) => method === `GET` && url.includes(`/dns_records?type=CNAME`), respond: () => ok([{ id: `r1` }]) },
            { match: (method, url) => method === `DELETE` && url.includes(`/dns_records/r1`), respond: () => ok({}) },
        ]);

        await deleteSandboxTunnel({ apiToken: `api`, zone, connectToken });

        // Connections are cleared BEFORE the tunnel delete — a just-stopped cloudflared leaves stale connections
        // that would otherwise 1022 — then the CNAMEs are removed.
        const deletes = calls.filter((call) => call.method === `DELETE`).map((call) => call.url);
        const connectionsIdx = deletes.findIndex((url) => url.endsWith(`/cfd_tunnel/t1/connections`));
        const tunnelIdx = deletes.findIndex((url) => url.endsWith(`/cfd_tunnel/t1`));
        expect(connectionsIdx).toBeGreaterThanOrEqual(0);
        expect(tunnelIdx).toBeGreaterThan(connectionsIdx);
        expect(deletes.some((url) => url.includes(`/dns_records/r1`))).toBe(true);
    });
});

describe(`provisionHostSshTunnel`, () => {
    const zone = `example.com`;
    const connectToken = `connect-token`;
    const hostName = `server1`;
    // Must match the CLI's createHostSshTunnel digest exactly, so either path reuses the other's tunnel.
    const id = createHash(`sha256`).update(`${connectToken}:${hostName}`).digest(`hex`).slice(0, 12);
    const hostname = `ssh-${id}.${zone}`;

    it(`creates the host-ssh tunnel with an ssh ingress and routes ssh-<id>.<zone>`, async () => {
        const calls = stubFetch([
            { match: (method, url) => method === `GET` && url.includes(`/zones?name=`), respond: () => ok([{ id: `z1`, account: { id: `a1` } }]) },
            { match: (method, url) => method === `GET` && url.includes(`/cfd_tunnel?name=`), respond: () => ok([]) },
            { match: (method, url) => method === `POST` && url.endsWith(`/cfd_tunnel`), respond: () => ok({ id: `t1` }) },
            { match: (method, url) => method === `GET` && url.endsWith(`/cfd_tunnel/t1/token`), respond: () => ok(`connector-token`) },
            { match: (method, url) => method === `PUT` && url.endsWith(`/cfd_tunnel/t1/configurations`), respond: () => ok({}) },
            { match: (method, url) => method === `GET` && url.includes(`/dns_records?type=CNAME`), respond: () => ok([]) },
            { match: (method, url) => method === `POST` && url.endsWith(`/dns_records`), respond: () => ok({}) },
        ]);

        const result = await provisionHostSshTunnel({ apiToken: `api`, zone, connectToken, hostName });

        expect(result).toEqual({ hostname, tunnelToken: `connector-token` });
        const created = calls.find((call) => call.method === `POST` && call.url.endsWith(`/cfd_tunnel`))!.body as Record<string, unknown>;
        expect(created).toMatchObject({ name: `host-ssh-${id}` });
        const ingress = calls.find((call) => call.url.endsWith(`/configurations`))!.body as {
            config: { ingress: { hostname?: string; service: string }[] };
        };
        expect(ingress.config.ingress[0]).toEqual({ hostname, service: `ssh://localhost:22` });
        const dns = calls.find((call) => call.method === `POST` && call.url.endsWith(`/dns_records`))!.body as Record<string, unknown>;
        expect(dns).toMatchObject({
            type: `CNAME`,
            name: hostname,
            content: `t1.cfargotunnel.com`,
            proxied: true,
            comment: `intentic host ssh tunnel`,
        });
    });

    it(`reuses an existing tunnel and updates an existing DNS record in place`, async () => {
        const calls = stubFetch([
            { match: (method, url) => method === `GET` && url.includes(`/zones?name=`), respond: () => ok([{ id: `z1`, account: { id: `a1` } }]) },
            { match: (method, url) => method === `GET` && url.includes(`/cfd_tunnel?name=`), respond: () => ok([{ id: `t9` }]) },
            { match: (method, url) => method === `GET` && url.endsWith(`/cfd_tunnel/t9/token`), respond: () => ok(`connector-token`) },
            { match: (method, url) => method === `PUT` && url.endsWith(`/cfd_tunnel/t9/configurations`), respond: () => ok({}) },
            { match: (method, url) => method === `GET` && url.includes(`/dns_records?type=CNAME`), respond: () => ok([{ id: `r1` }]) },
            { match: (method, url) => method === `PUT` && url.endsWith(`/dns_records/r1`), respond: () => ok({}) },
        ]);

        await provisionHostSshTunnel({ apiToken: `api`, zone, connectToken, hostName });

        expect(calls.some((call) => call.method === `POST`)).toBe(false);
    });
});

describe(`ensurePreviewRoute`, () => {
    const zone = `example.com`;
    const connectToken = `connect-token`;
    const id = createHash(`sha256`).update(connectToken).digest(`hex`).slice(0, 12);
    const hostname = `preview-app-${id}.${zone}`;
    const existingIngress = [
        { hostname: `sandbox-${id}.${zone}`, service: `http://intentic-sandbox-workspace:8787` },
        { hostname: `ssh-${id}.${zone}`, service: `ssh://intentic-sandbox-workspace:22` },
        { service: `http_status:404` },
    ];

    it(`appends the panel route above the catch-all, preserving existing rules, and creates the CNAME`, async () => {
        const calls = stubFetch([
            { match: (method, url) => method === `GET` && url.includes(`/zones?name=`), respond: () => ok([{ id: `z1`, account: { id: `a1` } }]) },
            { match: (method, url) => method === `GET` && url.includes(`/cfd_tunnel?name=`), respond: () => ok([{ id: `t1` }]) },
            {
                match: (method, url) => method === `GET` && url.endsWith(`/cfd_tunnel/t1/configurations`),
                respond: () => ok({ config: { ingress: existingIngress } }),
            },
            { match: (method, url) => method === `PUT` && url.endsWith(`/cfd_tunnel/t1/configurations`), respond: () => ok({}) },
            { match: (method, url) => method === `GET` && url.includes(`/dns_records?type=CNAME`), respond: () => ok([]) },
            { match: (method, url) => method === `POST` && url.endsWith(`/dns_records`), respond: () => ok({}) },
        ]);

        await expect(ensurePreviewRoute({ apiToken: `api`, zone, connectToken, label: `preview-app` })).resolves.toEqual({ hostname });

        // The tunnel searched is the sandbox's own.
        expect(calls.some((call) => call.url.includes(`/cfd_tunnel?name=sandbox-${id}`))).toBe(true);
        const put = calls.find((call) => call.method === `PUT` && call.url.endsWith(`/configurations`))!.body as {
            config: { ingress: { hostname?: string; service: string }[] };
        };
        expect(put.config.ingress).toEqual([
            existingIngress[0],
            existingIngress[1],
            { hostname, service: `http://intentic-sandbox-workspace:5173` },
            { service: `http_status:404` },
        ]);
        const dns = calls.find((call) => call.method === `POST` && call.url.endsWith(`/dns_records`))!.body as Record<string, unknown>;
        expect(dns).toMatchObject({ type: `CNAME`, name: hostname, content: `t1.cfargotunnel.com`, proxied: true });
    });

    it(`skips the config PUT when the route already exists but still repairs the CNAME`, async () => {
        const calls = stubFetch([
            { match: (method, url) => method === `GET` && url.includes(`/zones?name=`), respond: () => ok([{ id: `z1`, account: { id: `a1` } }]) },
            { match: (method, url) => method === `GET` && url.includes(`/cfd_tunnel?name=`), respond: () => ok([{ id: `t1` }]) },
            {
                match: (method, url) => method === `GET` && url.endsWith(`/cfd_tunnel/t1/configurations`),
                respond: () =>
                    ok({
                        config: {
                            ingress: [
                                ...existingIngress.slice(0, 2),
                                { hostname, service: `http://intentic-sandbox-workspace:5173` },
                                { service: `http_status:404` },
                            ],
                        },
                    }),
            },
            { match: (method, url) => method === `GET` && url.includes(`/dns_records?type=CNAME`), respond: () => ok([{ id: `r1` }]) },
            { match: (method, url) => method === `PUT` && url.endsWith(`/dns_records/r1`), respond: () => ok({}) },
        ]);

        await ensurePreviewRoute({ apiToken: `api`, zone, connectToken, label: `preview-app` });

        expect(calls.some((call) => call.method === `PUT` && call.url.endsWith(`/configurations`))).toBe(false);
        expect(calls.some((call) => call.method === `PUT` && call.url.endsWith(`/dns_records/r1`))).toBe(true);
    });

    it(`fails clearly when the sandbox tunnel does not exist`, async () => {
        stubFetch([
            { match: (method, url) => method === `GET` && url.includes(`/zones?name=`), respond: () => ok([{ id: `z1`, account: { id: `a1` } }]) },
            { match: (method, url) => method === `GET` && url.includes(`/cfd_tunnel?name=`), respond: () => ok([]) },
        ]);
        await expect(ensurePreviewRoute({ apiToken: `api`, zone, connectToken, label: `preview-app` })).rejects.toThrow(`was not found`);
    });
});

const DAY_MS = 24 * 60 * 60 * 1000;
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

describe(`reapStaleTunnels`, () => {
    const zone = `example.com`;

    // A mixed account: only the aged sandbox-*/host-ssh- tunnels with no live connector should be reaped —
    // including one that never connected (status null).
    const tunnels = [
        { id: `t-healthy`, name: `sandbox-healthy`, status: `healthy`, conns_active_at: iso(0), created_at: iso(30 * DAY_MS) },
        { id: `t-recent`, name: `sandbox-recent`, status: `down`, conns_active_at: iso(2 * DAY_MS), created_at: iso(30 * DAY_MS) },
        { id: `t-old`, name: `sandbox-old`, status: `down`, conns_active_at: iso(10 * DAY_MS), created_at: iso(30 * DAY_MS) },
        { id: `t-host`, name: `host-ssh-old`, status: `inactive`, conns_active_at: iso(10 * DAY_MS), created_at: iso(30 * DAY_MS) },
        { id: `t-other`, name: `deploy`, status: `down`, conns_active_at: iso(10 * DAY_MS), created_at: iso(30 * DAY_MS) },
        { id: `t-fresh`, name: `sandbox-fresh`, status: `inactive`, conns_active_at: null, created_at: iso(1 * DAY_MS) },
        { id: `t-null`, name: `sandbox-null`, status: null, conns_active_at: null, created_at: iso(10 * DAY_MS) },
    ];

    const stubReap = () =>
        stubFetch([
            { match: (method, url) => method === `GET` && url.includes(`/zones?name=`), respond: () => ok([{ id: `z1`, account: { id: `a1` } }]) },
            { match: (method, url) => method === `GET` && url.includes(`/cfd_tunnel?is_deleted=false`), respond: () => ok(tunnels) },
            {
                match: (method, url) => method === `GET` && url.includes(`/dns_records?type=CNAME`),
                respond: () => ok([{ id: `r-${Math.random()}` }]),
            },
            { match: (method) => method === `DELETE`, respond: () => ok({}) },
        ]);

    it(`reaps aged tunnels with no live connector — including never-connected (null) — and spares the rest`, async () => {
        const calls = stubReap();

        const result = await reapStaleTunnels({
            apiToken: `api`,
            zone,
            reapAfterMs: 7 * DAY_MS,
            dryRun: false,
            exclude: new Set(),
            log: () => {},
            onError: () => {},
        });

        expect(result).toEqual({ scanned: 7, reaped: 3, skipped: 0, failed: 0 });
        const deletedTunnels = calls
            .filter((call) => call.method === `DELETE` && call.url.includes(`/cfd_tunnel/`) && !call.url.endsWith(`/connections`))
            .map((call) => call.url.split(`/cfd_tunnel/`)[1]);
        expect(deletedTunnels.toSorted()).toEqual([`t-host`, `t-null`, `t-old`]);
        // Each reaped tunnel also has its CNAMEs looked up (by content) and deleted.
        expect(calls.some((call) => call.method === `DELETE` && call.url.includes(`/dns_records/`))).toBe(true);
    });

    it(`paginates past the first page when it comes back full`, async () => {
        // A full first page (50) forces a second fetch; the stale tunnel lives only on page 2.
        const page1 = Array.from({ length: 50 }, (_, index) => ({
            id: `p1-${index}`,
            name: `sandbox-p1-${index}`,
            status: `healthy`,
            conns_active_at: iso(0),
            created_at: iso(30 * DAY_MS),
        }));
        const page2 = [{ id: `p2-stale`, name: `sandbox-p2`, status: `down`, conns_active_at: iso(10 * DAY_MS), created_at: iso(30 * DAY_MS) }];
        const calls = stubFetch([
            { match: (method, url) => method === `GET` && url.includes(`/zones?name=`), respond: () => ok([{ id: `z1`, account: { id: `a1` } }]) },
            {
                match: (method, url) => method === `GET` && url.includes(`cfd_tunnel?is_deleted=false`) && url.includes(`page=1`),
                respond: () => ok(page1),
            },
            {
                match: (method, url) => method === `GET` && url.includes(`cfd_tunnel?is_deleted=false`) && url.includes(`page=2`),
                respond: () => ok(page2),
            },
            { match: (method, url) => method === `GET` && url.includes(`/dns_records?type=CNAME`), respond: () => ok([]) },
            { match: (method) => method === `DELETE`, respond: () => ok({}) },
        ]);

        const result = await reapStaleTunnels({
            apiToken: `api`,
            zone,
            reapAfterMs: 7 * DAY_MS,
            dryRun: false,
            exclude: new Set(),
            log: () => {},
            onError: () => {},
        });

        expect(result).toEqual({ scanned: 51, reaped: 1, skipped: 0, failed: 0 });
        expect(calls.some((call) => call.method === `DELETE` && call.url.endsWith(`/cfd_tunnel/p2-stale`))).toBe(true);
    });

    it(`deletes nothing in dry-run but still reports the candidates`, async () => {
        const seen: string[] = [];
        const calls = stubReap();

        const result = await reapStaleTunnels({
            apiToken: `api`,
            zone,
            reapAfterMs: 7 * DAY_MS,
            dryRun: true,
            exclude: new Set(),
            log: (tunnel) => seen.push(tunnel.name),
            onError: () => {},
        });

        expect(result).toEqual({ scanned: 7, reaped: 0, skipped: 0, failed: 0 });
        expect(calls.some((call) => call.method === `DELETE`)).toBe(false);
        expect(seen.toSorted()).toEqual([`host-ssh-old`, `sandbox-null`, `sandbox-old`]);
    });

    it(`spares excluded tunnels even when aged and down (the pre-provisioned pool)`, async () => {
        const calls = stubReap();

        // sandbox-old is aged + down (normally reaped) but excluded — so only host-ssh-old and the never-connected
        // sandbox-null are reaped.
        const result = await reapStaleTunnels({
            apiToken: `api`,
            zone,
            reapAfterMs: 7 * DAY_MS,
            dryRun: false,
            exclude: new Set([`sandbox-old`]),
            log: () => {},
            onError: () => {},
        });

        expect(result).toEqual({ scanned: 7, reaped: 2, skipped: 0, failed: 0 });
        const deletedTunnels = calls
            .filter((call) => call.method === `DELETE` && call.url.includes(`/cfd_tunnel/`) && !call.url.endsWith(`/connections`))
            .map((call) => call.url.split(`/cfd_tunnel/`)[1]);
        expect(deletedTunnels.toSorted()).toEqual([`t-host`, `t-null`]);
    });

    // A stubbed reap where sandbox-old's *tunnel* delete responds with `code`, while its connections delete and
    // every other tunnel's deletes succeed — so we can prove one bad delete no longer aborts the sweep.
    const stubReapWithFailure = (code: number, status?: number) =>
        stubFetch([
            { match: (method, url) => method === `GET` && url.includes(`/zones?name=`), respond: () => ok([{ id: `z1`, account: { id: `a1` } }]) },
            { match: (method, url) => method === `GET` && url.includes(`/cfd_tunnel?is_deleted=false`), respond: () => ok(tunnels) },
            { match: (method, url) => method === `GET` && url.includes(`/dns_records?type=CNAME`), respond: () => ok([{ id: `r1` }]) },
            { match: (method, url) => method === `DELETE` && url.endsWith(`/cfd_tunnel/t-old`), respond: () => cfError(code, status) },
            { match: (method) => method === `DELETE`, respond: () => ok({}) },
        ]);

    it(`skips a tunnel whose connector is still live (1022) and reaps the rest`, async () => {
        const calls = stubReapWithFailure(1022);
        const failures: string[] = [];

        const result = await reapStaleTunnels({
            apiToken: `api`,
            zone,
            reapAfterMs: 7 * DAY_MS,
            dryRun: false,
            exclude: new Set(),
            log: () => {},
            onError: (tunnel) => failures.push(tunnel.name),
        });

        expect(result).toEqual({ scanned: 7, reaped: 2, skipped: 1, failed: 0 });
        expect(failures).toEqual([]);
        // The 1022 did not abort the sweep — the other aged tunnels were still reaped.
        expect(calls.some((call) => call.method === `DELETE` && call.url.endsWith(`/cfd_tunnel/t-host`))).toBe(true);
        expect(calls.some((call) => call.method === `DELETE` && call.url.endsWith(`/cfd_tunnel/t-null`))).toBe(true);
    });

    it(`counts a non-1022 delete failure as failed, reports it, and continues the sweep`, async () => {
        const calls = stubReapWithFailure(1016, 500);
        const failures: string[] = [];

        const result = await reapStaleTunnels({
            apiToken: `api`,
            zone,
            reapAfterMs: 7 * DAY_MS,
            dryRun: false,
            exclude: new Set(),
            log: () => {},
            onError: (tunnel) => failures.push(tunnel.name),
        });

        expect(result).toEqual({ scanned: 7, reaped: 2, skipped: 0, failed: 1 });
        expect(failures).toEqual([`sandbox-old`]);
        expect(calls.some((call) => call.method === `DELETE` && call.url.endsWith(`/cfd_tunnel/t-host`))).toBe(true);
    });

    it(`clears connector registrations before deleting each reaped tunnel`, async () => {
        const calls = stubReap();

        await reapStaleTunnels({
            apiToken: `api`,
            zone,
            reapAfterMs: 7 * DAY_MS,
            dryRun: false,
            exclude: new Set(),
            log: () => {},
            onError: () => {},
        });

        const connectionsAt = calls.findIndex((call) => call.method === `DELETE` && call.url.endsWith(`/cfd_tunnel/t-old/connections`));
        const deleteAt = calls.findIndex((call) => call.method === `DELETE` && call.url.endsWith(`/cfd_tunnel/t-old`));
        expect(connectionsAt).toBeGreaterThanOrEqual(0);
        expect(connectionsAt).toBeLessThan(deleteAt);
    });
});
