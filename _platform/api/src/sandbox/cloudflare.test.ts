import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudflareTokenError, listZoneNames, reapOrphanDnsRecords } from "./cloudflare.js";

// The two things this platform still asks Cloudflare for: the zone list, and the DNS behind the loopback cert.

// Canned Cloudflare success envelope.
const ok = (result: unknown, resultInfo?: { total_pages: number }) =>
    new Response(JSON.stringify({ success: true, errors: [], result, ...(resultInfo ? { result_info: resultInfo } : {}) }));

// Routes the stubbed fetch by method + URL substring, recording calls for order/payload assertions.
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

describe(`reapOrphanDnsRecords`, () => {
    const zone = `example.com`;
    // A churned zone's records; the two tunnel CNAMEs matter most: same shape, opposite in meaning.
    const records = [
        {
            id: `r-tunnel-a`,
            type: `CNAME`,
            name: `sandbox-aaaaaaaaaaaa.example.com`,
            content: `11111111-1111-4111-8111-111111111111.cfargotunnel.com`,
        },
        {
            id: `r-tunnel-b`,
            type: `CNAME`,
            name: `p0rt5l0t4bcd-bbbbbbbbbbbb.example.com`,
            content: `22222222-2222-4222-8222-222222222222.cfargotunnel.com`,
        },
        { id: `r-wildcard`, type: `A`, name: `*.local.example.com`, content: `127.0.0.1` },
        { id: `r-local-live`, type: `A`, name: `aaaaaaaaaaaa.local.example.com`, content: `127.0.0.1` },
        { id: `r-local-old`, type: `A`, name: `local-cccccccccccc.example.com`, content: `127.0.0.1` },
        { id: `r-acme-live`, type: `TXT`, name: `_acme-challenge.aaaaaaaaaaaa.local.example.com`, content: `order-in-flight` },
        { id: `r-acme-gone`, type: `TXT`, name: `_acme-challenge.cccccccccccc.local.example.com`, content: `stale-order` },
        { id: `r-apex`, type: `A`, name: `example.com`, content: `203.0.113.7` },
        { id: `r-mail`, type: `MX`, name: `example.com`, content: `mail.example.com` },
    ];

    const stubRecords = () =>
        stubFetch([
            { match: (method, url) => method === `GET` && url.includes(`/zones?name=`), respond: () => ok([{ id: `z1` }]) },
            { match: (method, url) => method === `GET` && url.includes(`/dns_records?per_page=`), respond: () => ok(records) },
            { match: (method) => method === `DELETE`, respond: () => ok({}) },
        ]);

    it(`never touches a record belonging to a sandbox that still exists`, async () => {
        const calls = stubRecords();
        const result = await reapOrphanDnsRecords({
            apiToken: `api`,
            zone,
            liveSandboxIds: new Set([`aaaaaaaaaaaa`]),
            dryRun: false,
            log: () => {},
            onError: () => {},
        });
        // Only nothing depends on it licenses a delete, not nothing mints it anymore; the id in the name answers this.
        const deleted = calls.filter((call) => call.method === `DELETE`).map((call) => call.url.split(`/dns_records/`)[1]);
        expect(deleted.toSorted()).toEqual([`r-acme-gone`, `r-local-live`, `r-local-old`, `r-tunnel-b`]);
        expect(result).toEqual({ total: 9, orphaned: 4, reaped: 4, failed: 0 });
    });

    it(`leaves a record it cannot attribute to any sandbox alone`, async () => {
        // Unknown is not the same as unused: a name with no sandbox id in it cannot be attributed either way.
        const calls = stubFetch([
            { match: (method, url) => method === `GET` && url.includes(`/zones?name=`), respond: () => ok([{ id: `z1` }]) },
            {
                match: (method, url) => method === `GET` && url.includes(`/dns_records?per_page=`),
                respond: () =>
                    ok([
                        {
                            id: `r-hand-made`,
                            type: `CNAME`,
                            name: `staging.example.com`,
                            content: `33333333-3333-4333-8333-333333333333.cfargotunnel.com`,
                        },
                    ]),
            },
            { match: (method) => method === `DELETE`, respond: () => ok({}) },
        ]);
        const result = await reapOrphanDnsRecords({
            apiToken: `api`,
            zone,
            liveSandboxIds: new Set(),
            dryRun: false,
            log: () => {},
            onError: () => {},
        });
        expect(result.orphaned).toBe(0);
        expect(calls.some((call) => call.method === `DELETE`)).toBe(false);
    });

    it(`asks Cloudflare for nothing but DNS: the sweep must survive a DNS-only token`, async () => {
        // A tunnel-listing call needs a scope this token no longer has; asking for it would break the sweep silently.
        const calls = stubRecords();
        await reapOrphanDnsRecords({ apiToken: `api`, zone, liveSandboxIds: new Set(), dryRun: true, log: () => {}, onError: () => {} });
        expect(calls.some((call) => call.url.includes(`cfd_tunnel`))).toBe(false);
    });

    it(`dry-run reports the zone's totals and candidates without deleting`, async () => {
        const calls = stubRecords();
        const seen: string[] = [];
        const result = await reapOrphanDnsRecords({
            apiToken: `api`,
            zone,
            liveSandboxIds: new Set([`aaaaaaaaaaaa`]),
            dryRun: true,
            log: (record) => seen.push(record.name),
            onError: () => {},
        });
        expect(result).toEqual({ total: 9, orphaned: 4, reaped: 0, failed: 0 });
        expect(seen).toHaveLength(4);
        expect(calls.some((call) => call.method === `DELETE`)).toBe(false);
    });
});
