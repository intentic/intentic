import type { CloudflareApi, IngressRule } from "@intentic/providers";
import { hostSshIdFromToken } from "@intentic/sandbox-contract/tunnel-ids";
import { unstubbed } from "@intentic/testing";
import { createHostSshTunnel } from "./host-ssh-tunnel.js";

// The host SSH tunnel goes through the providers' own flows (find-or-create, CNAME upsert) and the zone rule `resolve`
// uses, against a fake Cloudflare that records what it was asked.

interface Calls {
    created: string[];
    ingress: IngressRule[][];
    records: { op: `create` | `update`; name: string; content: string; comment: string }[];
}

const fake = (state: { tunnel?: string; record?: string; zones?: string[] }) => {
    const calls: Calls = { created: [], ingress: [], records: [] };
    const api = unstubbed<CloudflareApi>(`cloudflare`, {
        listZones: async () => (state.zones ?? [`example.com`]).map((name, at) => ({ id: `zone-${at}`, name, accountId: `acct` })),
        findTunnel: async () => (state.tunnel === undefined ? undefined : { id: state.tunnel }),
        createTunnel: async ({ name }) => {
            calls.created.push(name);
            return { id: `new-tunnel` };
        },
        getTunnelToken: async ({ tunnelId }) => `token-for-${tunnelId}`,
        putTunnelIngress: async ({ ingress }) => {
            calls.ingress.push([...ingress]);
        },
        findDnsRecord: async () => (state.record === undefined ? undefined : { id: state.record, content: `old.cfargotunnel.com` }),
        createDnsRecord: async ({ name, content, comment }) => {
            calls.records.push({ op: `create`, name, content, comment });
        },
        updateDnsRecord: async ({ name, content, comment }) => {
            calls.records.push({ op: `update`, name, content, comment });
        },
    });
    return { api, calls };
};

const run = (api: CloudflareApi) =>
    createHostSshTunnel({ apiToken: `tok`, connectToken: `connect`, hostName: `box`, log: () => {}, api });

it(`makes the tunnel when there is none, routes ssh to it and points a new CNAME at it`, async () => {
    const { api, calls } = fake({});
    const result = await run(api);
    expect(result.token).toBe(`token-for-new-tunnel`);
    expect(result.hostname).toMatch(/^ssh-[0-9a-f]+\.example\.com$/);
    expect(calls.created).toHaveLength(1);
    expect(calls.ingress).toEqual([[{ hostname: result.hostname, service: `ssh://localhost:22` }, { service: `http_status:404` }]]);
    expect(calls.records).toEqual([
        { op: `create`, name: result.hostname, content: `new-tunnel.cfargotunnel.com`, comment: `intentic host ssh tunnel` },
    ]);
});

it(`reuses the tunnel and updates the CNAME that is already there`, async () => {
    const { api, calls } = fake({ tunnel: `kept`, record: `rec-1` });
    const result = await run(api);
    expect(result.token).toBe(`token-for-kept`);
    expect(calls.created).toEqual([]);
    expect(calls.records).toEqual([{ op: `update`, name: result.hostname, content: `kept.cfargotunnel.com`, comment: `intentic host ssh tunnel` }]);
});

it(`refuses to guess between several zones, and says how to choose`, async () => {
    const { api } = fake({ zones: [`one.com`, `two.com`] });
    await expect(run(api)).rejects.toThrow(`set the ZONE env var or pass --zone to choose one, e.g. --zone one.com`);
});

it(`says a token with no zones is the token's to fix, with no flag to try`, async () => {
    const { api } = fake({ zones: [] });
    await expect(run(api)).rejects.toThrow(/^the Cloudflare API token can see no zones; mint a token scoped to the zone you deploy under$/);
});

it(`names the tunnel and its record for the HOST_ID it is handed, not for a digest of the single-use token`, async () => {
    // A server-connect code's CONNECT_TOKEN is new each run; the id the sandbox answers is the one its server keeps.
    const first = fake({});
    const again = fake({});
    const one = await createHostSshTunnel({ apiToken: `tok`, connectToken: `once-1`, hostName: `box`, id: `0123456789ab`, log: () => {}, api: first.api });
    const two = await createHostSshTunnel({ apiToken: `tok`, connectToken: `once-2`, hostName: `box`, id: `0123456789ab`, log: () => {}, api: again.api });
    expect(one.hostname).toBe(`ssh-0123456789ab.example.com`);
    expect(two.hostname).toBe(one.hostname);
    expect(first.calls.created).toEqual(again.calls.created);
    expect(first.calls.created[0]).toContain(`0123456789ab`);
    // Without one, the token's digest names it, as before.
    const digested = await run(fake({}).api);
    expect(digested.hostname).toBe(`ssh-${hostSshIdFromToken(`connect`, `box`)}.example.com`);
});

it(`refuses a HOST_ID that is not the shape the sandbox gives, before touching Cloudflare`, async () => {
    const { api, calls } = fake({});
    for (const id of [``, `0123456789AB`, `0123456789a`, `../etc/passwd`, `0123456789abc`]) {
        await expect(createHostSshTunnel({ apiToken: `tok`, connectToken: `connect`, hostName: `box`, id, log: () => {}, api })).rejects.toThrow(
            `HOST_ID must be 12 lowercase hex characters`,
        );
    }
    expect(calls.created).toEqual([]);
});
