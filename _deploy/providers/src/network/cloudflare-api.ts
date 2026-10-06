import { type CloudflareInit, cloudflareCall, cloudflarePages } from "@intentic/base/cloudflare";
import { z } from "zod";
import { parseResponse } from "../core/inputs.js";

// One ingress rule: a public hostname routed to an internal service, or the trailing catch-all (no hostname).
export interface IngressRule {
    readonly hostname?: string;
    readonly service: string;
}

const ingressRuleSchema = z.object({ hostname: z.string().optional(), service: z.string() });

// Cloudflare v4 REST surface the providers use, injected so they're testable with a fake, with `cloudflareApi`
// below as the real implementation. Auth is a bearer token passed per call, never baked into the adapter.
export interface CloudflareApi {
    // Resolves an owned zone by name; the owning account comes back with it since zone names are globally unique.
    readonly getZone: (args: {
        readonly apiToken: string;
        readonly zone: string;
    }) => Promise<{ readonly id: string; readonly accountId: string } | undefined>;
    // Every zone the token can see, with its owning account; finds which zone an authored domain lives under.
    readonly listZones: (args: {
        readonly apiToken: string;
    }) => Promise<{ readonly id: string; readonly name: string; readonly accountId: string }[]>;
    // Find a cloudflared tunnel by exact name (excluding soft-deleted); undefined if none.
    readonly findTunnel: (args: {
        readonly accountId: string;
        readonly apiToken: string;
        readonly name: string;
    }) => Promise<{ readonly id: string } | undefined>;
    // Create a remotely-managed (config_src "cloudflare") tunnel; returns its id.
    readonly createTunnel: (args: {
        readonly accountId: string;
        readonly apiToken: string;
        readonly name: string;
    }) => Promise<{ readonly id: string }>;
    // The connector token used to run cloudflared on the host.
    readonly getTunnelToken: (args: { readonly accountId: string; readonly apiToken: string; readonly tunnelId: string }) => Promise<string>;
    // Tunnel connectivity per Cloudflare's edge: healthy/degraded serving, inactive if never registered, else down.
    readonly getTunnelStatus: (args: { readonly accountId: string; readonly apiToken: string; readonly tunnelId: string }) => Promise<string>;
    // The tunnel's current ingress; undefined if no configuration has been set yet.
    readonly getTunnelIngress: (args: {
        readonly accountId: string;
        readonly apiToken: string;
        readonly tunnelId: string;
    }) => Promise<IngressRule[] | undefined>;
    // Replace the tunnel's ingress with exactly the rules given (the caller appends the catch-all).
    readonly putTunnelIngress: (args: {
        readonly accountId: string;
        readonly apiToken: string;
        readonly tunnelId: string;
        readonly ingress: readonly IngressRule[];
    }) => Promise<void>;
    // Find a CNAME record by exact name in a zone, with its comment (the ownership stamp); undefined if none.
    readonly findDnsRecord: (args: {
        readonly apiToken: string;
        readonly zoneId: string;
        readonly name: string;
    }) => Promise<{ readonly id: string; readonly content: string; readonly comment?: string } | undefined>;
    // Every DNS record whose comment starts with the given prefix; backs cf-route's `list` scan.
    readonly listStampedDnsRecords: (args: {
        readonly apiToken: string;
        readonly zoneId: string;
        readonly commentPrefix: string;
    }) => Promise<{ readonly name: string; readonly comment: string }[]>;
    // Create a proxied CNAME stamped with the given comment.
    readonly createDnsRecord: (args: {
        readonly apiToken: string;
        readonly zoneId: string;
        readonly name: string;
        readonly content: string;
        readonly comment: string;
    }) => Promise<void>;
    // Replace a CNAME record (overwrites type/content/proxied) keeping the stamp.
    readonly updateDnsRecord: (args: {
        readonly apiToken: string;
        readonly zoneId: string;
        readonly recordId: string;
        readonly name: string;
        readonly content: string;
        readonly comment: string;
    }) => Promise<void>;
    // Deletes a tunnel by id; exists for the e2e harness to purge live resources, the engine has no destroy path.
    readonly deleteTunnel: (args: { readonly accountId: string; readonly apiToken: string; readonly tunnelId: string }) => Promise<void>;
    // Delete a DNS record by id, for the same teardown purpose.
    readonly deleteDnsRecord: (args: { readonly apiToken: string; readonly zoneId: string; readonly recordId: string }) => Promise<void>;
}

// The bearer, the envelope, the deadline and the paging are @intentic/base/cloudflare's, the one client the platform
// calls Cloudflare with too; what is here is each result's shape, checked at the boundary.
const call = async <S extends z.ZodType>(apiToken: string, path: string, resultSchema: S, init?: CloudflareInit): Promise<z.infer<S>> =>
    parseResponse(resultSchema, await cloudflareCall(apiToken, path, init), `Cloudflare API ${init?.method ?? "GET"} ${path}`);

export const cloudflareApi: CloudflareApi = {
    getZone: async ({ apiToken, zone }) => {
        const zones = await call(
            apiToken,
            `/zones?name=${encodeURIComponent(zone)}`,
            z.array(z.object({ id: z.string(), account: z.object({ id: z.string() }) })),
        );
        const found = zones[0];
        if (found === undefined) {
            return undefined;
        }
        return { id: found.id, accountId: found.account.id };
    },
    listZones: async ({ apiToken }) => {
        const zones = parseResponse(
            z.array(z.object({ id: z.string(), name: z.string(), account: z.object({ id: z.string() }) })),
            await cloudflarePages(apiToken, "/zones"),
            "Cloudflare API GET /zones",
        );
        return zones.map((zone) => ({ id: zone.id, name: zone.name, accountId: zone.account.id }));
    },
    findTunnel: async ({ accountId, apiToken, name }) => {
        const tunnels = await call(
            apiToken,
            `/accounts/${encodeURIComponent(accountId)}/cfd_tunnel?name=${encodeURIComponent(name)}&is_deleted=false`,
            z.array(z.object({ id: z.string() })),
        );
        const found = tunnels[0];
        if (found === undefined) {
            return undefined;
        }
        return { id: found.id };
    },
    createTunnel: ({ accountId, apiToken, name }) =>
        call(apiToken, `/accounts/${encodeURIComponent(accountId)}/cfd_tunnel`, z.object({ id: z.string() }), {
            method: "POST",
            body: { name, config_src: "cloudflare" },
        }),
    getTunnelToken: ({ accountId, apiToken, tunnelId }) =>
        call(apiToken, `/accounts/${encodeURIComponent(accountId)}/cfd_tunnel/${encodeURIComponent(tunnelId)}/token`, z.string()),
    getTunnelStatus: async ({ accountId, apiToken, tunnelId }) => {
        const tunnel = await call(
            apiToken,
            `/accounts/${encodeURIComponent(accountId)}/cfd_tunnel/${encodeURIComponent(tunnelId)}`,
            z.object({ status: z.string() }),
        );
        return tunnel.status;
    },
    getTunnelIngress: async ({ accountId, apiToken, tunnelId }) => {
        const config = await call(
            apiToken,
            `/accounts/${encodeURIComponent(accountId)}/cfd_tunnel/${encodeURIComponent(tunnelId)}/configurations`,
            z.object({ config: z.object({ ingress: z.array(ingressRuleSchema).optional() }).optional() }).nullable(),
        );
        const ingress = config?.config?.ingress;
        return ingress?.map((rule) => (rule.hostname === undefined ? { service: rule.service } : { hostname: rule.hostname, service: rule.service }));
    },
    putTunnelIngress: async ({ accountId, apiToken, tunnelId, ingress }) => {
        await call(apiToken, `/accounts/${encodeURIComponent(accountId)}/cfd_tunnel/${encodeURIComponent(tunnelId)}/configurations`, z.unknown(), {
            method: "PUT",
            body: { config: { ingress } },
        });
    },
    findDnsRecord: async ({ apiToken, zoneId, name }) => {
        const records = await call(
            apiToken,
            `/zones/${encodeURIComponent(zoneId)}/dns_records?type=CNAME&name=${encodeURIComponent(name)}`,
            z.array(z.object({ id: z.string(), content: z.string(), comment: z.string().nullish() })),
        );
        const found = records[0];
        if (found === undefined) {
            return undefined;
        }
        return { id: found.id, content: found.content, ...(typeof found.comment === "string" ? { comment: found.comment } : {}) };
    },
    listStampedDnsRecords: async ({ apiToken, zoneId, commentPrefix }) => {
        // One page of up to 1000 records; paginate if a zone ever exceeds that many stamped records.
        const records = await call(
            apiToken,
            `/zones/${encodeURIComponent(zoneId)}/dns_records?comment.startswith=${encodeURIComponent(commentPrefix)}&per_page=1000`,
            z.array(z.object({ name: z.string(), comment: z.string() })),
        );
        return records;
    },
    createDnsRecord: async ({ apiToken, zoneId, name, content, comment }) => {
        await call(apiToken, `/zones/${encodeURIComponent(zoneId)}/dns_records`, z.unknown(), {
            method: "POST",
            body: { type: "CNAME", name, content, proxied: true, comment },
        });
    },
    updateDnsRecord: async ({ apiToken, zoneId, recordId, name, content, comment }) => {
        await call(apiToken, `/zones/${encodeURIComponent(zoneId)}/dns_records/${encodeURIComponent(recordId)}`, z.unknown(), {
            method: "PUT",
            body: { type: "CNAME", name, content, proxied: true, comment },
        });
    },
    deleteTunnel: async ({ accountId, apiToken, tunnelId }) => {
        await call(apiToken, `/accounts/${encodeURIComponent(accountId)}/cfd_tunnel/${encodeURIComponent(tunnelId)}`, z.unknown(), {
            method: "DELETE",
        });
    },
    deleteDnsRecord: async ({ apiToken, zoneId, recordId }) => {
        await call(apiToken, `/zones/${encodeURIComponent(zoneId)}/dns_records/${encodeURIComponent(recordId)}`, z.unknown(), {
            method: "DELETE",
        });
    },
};
