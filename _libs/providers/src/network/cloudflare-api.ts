import { z } from "zod";
import { parseResponse } from "../core/inputs.js";

// One ingress rule of a Cloudflare Tunnel: a public hostname routed to an internal service URL, or the
// trailing catch-all (no hostname, service "http_status:404"). The provider owns the catch-all policy.
export interface IngressRule {
    readonly hostname?: string;
    readonly service: string;
}

const ingressRuleSchema = z.object({ hostname: z.string().optional(), service: z.string() });

// The Cloudflare v4 REST surface the providers use, injected so the providers are unit-testable with a
// fake; the default `cloudflareApi` below talks to api.cloudflare.com over native fetch. Auth flows
// per-call (the bearer token is a resolved node input), never baked into the adapter at construction.
export interface CloudflareApi {
    // Resolve an OWNED zone by name; undefined if no such zone exists. The account that owns it comes back
    // with the zone (a zone name is globally unique across Cloudflare), so callers need not supply it.
    readonly getZone: (args: {
        readonly apiToken: string;
        readonly zone: string;
    }) => Promise<{ readonly id: string; readonly accountId: string } | undefined>;
    // Every zone the token can see, with the account that owns each. Used to discover which zone the authored
    // domains live under — the token is the only Cloudflare credential the author supplies.
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
    // The tunnel's connectivity as Cloudflare's edge sees it: "healthy"/"degraded" when a connector is
    // serving, "inactive" when none ever registered, "down" when the last one dropped. The tunnel provider
    // polls this after (re)starting cloudflared so apply returns only once the tunnel actually serves.
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
    // Find a CNAME record by exact name in a zone; undefined if none.
    readonly findDnsRecord: (args: {
        readonly apiToken: string;
        readonly zoneId: string;
        readonly name: string;
    }) => Promise<{ readonly id: string; readonly content: string } | undefined>;
    // Every DNS record in the zone whose comment starts with the given prefix — the zone-wide scan behind
    // cf-route's `list` (records are stamped through their comment).
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
    // Delete a tunnel by id. The engine has no destroy path; this exists so the e2e harness can purge the
    // live Cloudflare resources it created during teardown.
    readonly deleteTunnel: (args: { readonly accountId: string; readonly apiToken: string; readonly tunnelId: string }) => Promise<void>;
    // Delete a DNS record by id, for the same teardown purpose.
    readonly deleteDnsRecord: (args: { readonly apiToken: string; readonly zoneId: string; readonly recordId: string }) => Promise<void>;
}

const BASE = "https://api.cloudflare.com/client/v4";

// The Cloudflare success envelope. `result` is validated per-call against the shape we consume; here it is
// left unknown so an error envelope (success:false) still surfaces its `errors` rather than failing the
// result schema first.
const envelopeSchema = z.object({
    success: z.boolean(),
    errors: z.array(z.object({ code: z.number(), message: z.string() })),
    result: z.unknown(),
    // Pagination metadata, present in varying shapes on list endpoints — left unknown so the shared
    // success-envelope check never trips on an endpoint whose result_info omits total_pages (cfd_tunnel,
    // dns_records). listZones extracts the page count from it defensively.
    result_info: z.unknown().optional(),
});

// Fetch + validate the success envelope, throwing transport/API errors. Returns the whole envelope so list
// callers can read result_info (pagination) alongside result. Transport failures carry the elapsed time so a
// postmortem can tell a 30s timeout from an instant refusal without any tracing.
const request = async (apiToken: string, path: string, init?: RequestInit): Promise<z.infer<typeof envelopeSchema>> => {
    const label = `Cloudflare API ${init?.method ?? "GET"} ${path}`;
    const started = Date.now();
    let response: Response;
    try {
        response = await fetch(`${BASE}${path}`, {
            ...init,
            headers: {
                Authorization: `Bearer ${apiToken}`,
                ...(init?.body !== undefined ? { "Content-Type": "application/json" } : {}),
            },
            // A stalled connection would otherwise block for undici's ~5-minute headers timeout — per call.
            signal: AbortSignal.timeout(30_000),
        });
    } catch (error) {
        throw new Error(`${label} transport failed after ${Date.now() - started}ms: ${error instanceof Error ? error.message : String(error)}`, {
            cause: error,
        });
    }
    const envelope = parseResponse(envelopeSchema, await response.json(), label);
    if (!response.ok || !envelope.success) {
        const detail = envelope.errors.map((error) => `${error.code} ${error.message}`).join("; ");
        throw new Error(`${label} failed (HTTP ${response.status}): ${detail}`);
    }
    return envelope;
};

const call = async <S extends z.ZodType>(apiToken: string, path: string, resultSchema: S, init?: RequestInit): Promise<z.infer<S>> => {
    const envelope = await request(apiToken, path, init);
    return parseResponse(resultSchema, envelope.result, `Cloudflare API ${init?.method ?? "GET"} ${path}`);
};

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
        const zones: { id: string; name: string; accountId: string }[] = [];
        let page = 1;
        let totalPages = 1;
        do {
            const envelope = await request(apiToken, `/zones?per_page=50&page=${page}`);
            const parsed = parseResponse(
                z.array(z.object({ id: z.string(), name: z.string(), account: z.object({ id: z.string() }) })),
                envelope.result,
                `Cloudflare API GET /zones?per_page=50&page=${page}`,
            );
            for (const zone of parsed) {
                zones.push({ id: zone.id, name: zone.name, accountId: zone.account.id });
            }
            totalPages = z.object({ total_pages: z.number() }).safeParse(envelope.result_info).data?.total_pages ?? 1;
            page += 1;
        } while (page <= totalPages);
        return zones;
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
            body: JSON.stringify({ name, config_src: "cloudflare" }),
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
            body: JSON.stringify({ config: { ingress } }),
        });
    },
    findDnsRecord: async ({ apiToken, zoneId, name }) => {
        const records = await call(
            apiToken,
            `/zones/${encodeURIComponent(zoneId)}/dns_records?type=CNAME&name=${encodeURIComponent(name)}`,
            z.array(z.object({ id: z.string(), content: z.string() })),
        );
        const found = records[0];
        if (found === undefined) {
            return undefined;
        }
        return { id: found.id, content: found.content };
    },
    listStampedDnsRecords: async ({ apiToken, zoneId, commentPrefix }) => {
        // ponytail: one page of up to 1000 records — paginate if a zone ever carries more stamped records.
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
            body: JSON.stringify({ type: "CNAME", name, content, proxied: true, comment }),
        });
    },
    updateDnsRecord: async ({ apiToken, zoneId, recordId, name, content, comment }) => {
        await call(apiToken, `/zones/${encodeURIComponent(zoneId)}/dns_records/${encodeURIComponent(recordId)}`, z.unknown(), {
            method: "PUT",
            body: JSON.stringify({ type: "CNAME", name, content, proxied: true, comment }),
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
