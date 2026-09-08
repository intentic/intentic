import { pollUntil } from "@intentic/base/async";
import type { Provider, ResolvedInputs } from "@intentic/engine";
import { formatStamp, parseStamp, STAMP_KEY } from "@intentic/graph";
import { z } from "zod";
import { parseInputs } from "../core/inputs.js";
import type { CloudflareApi } from "./cloudflare-api.js";
import { cloudflareApi } from "./cloudflare-api.js";

const cfRouteSchema = z.object({ hostname: z.string(), zoneId: z.string(), apiToken: z.string(), cname: z.string() });
const parse = (inputs: ResolvedInputs): z.infer<typeof cfRouteSchema> => parseInputs(cfRouteSchema, inputs, "cf-route");
// Parsed separately from cname, so delete also works from a ListedResource's inputs (no cname there).
const deleteSchema = cfRouteSchema.omit({ cname: true });

// Waits until a fresh proxied record resolves before downstream providers hit it; a premature lookup would
// cache NXDOMAIN for the zone's negative TTL. Probes over DoH so the check itself never pollutes that cache;
// best-effort.
export type DnsPropagationWait = (hostname: string, log: (message: string) => void) => Promise<void>;

const dohResolves = async (hostname: string): Promise<boolean> => {
    try {
        const response = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=A`, {
            headers: { accept: "application/dns-json" },
            // A stalled DoH probe must not eat the whole propagation window in one call.
            signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) {
            return false;
        }
        const body = (await response.json()) as { readonly Status?: number; readonly Answer?: readonly unknown[] };
        return body.Status === 0 && Array.isArray(body.Answer) && body.Answer.length > 0;
    } catch {
        return false;
    }
};

const waitForDnsPropagation: DnsPropagationWait = async (hostname, log) => {
    if (!(await pollUntil(() => dohResolves(hostname), { timeoutMs: 90_000, intervalMs: 2000 }))) {
        log(`cf-route: ${hostname} not yet observable via DoH after 90s; proceeding (downstream calls may need a retry)`);
    }
};

// One public hostname's proxied CNAME, pointed at the host tunnel's cfargotunnel hostname. `read` surfaces the
// current target; `diff` compares it to the tunnel's cname; `apply` upserts the stamped CNAME and awaits propagation.
export const createCfRouteProvider = (
    api: CloudflareApi = cloudflareApi,
    awaitPropagation: DnsPropagationWait = waitForDnsPropagation,
): Provider => ({
    read: async (inputs) => {
        // cname and zoneId may still be PENDING $refs; parses only deleteSchema's fields, never cname.
        if (typeof inputs["zoneId"] !== "string") {
            return undefined;
        }
        const { hostname, zoneId, apiToken } = parseInputs(deleteSchema, inputs, "cf-route");
        const record = await api.findDnsRecord({ apiToken, zoneId, name: hostname });
        if (record === undefined) {
            return undefined;
        }
        return { outputs: { url: `https://${hostname}` }, detail: { content: record.content } };
    },
    diff: (inputs, observed) => {
        // Tunnel is still a pending create, so the target cname isn't derivable yet; report drift instead.
        if (typeof inputs["cname"] !== "string") {
            return { action: "update", reason: "tunnel not created yet, its cname is not derivable" };
        }
        const { cname } = parse(inputs);
        const content = observed.detail?.["content"];
        if (content === cname) {
            return { action: "noop" };
        }
        return { action: "update", reason: `CNAME target "${String(content)}" differs from "${cname}"` };
    },
    apply: async (inputs, _observed, ctx) => {
        const { hostname, zoneId, apiToken, cname } = parse(inputs);
        const comment = formatStamp(ctx.id);
        const record = await api.findDnsRecord({ apiToken, zoneId, name: hostname });
        if (record === undefined) {
            await api.createDnsRecord({ apiToken, zoneId, name: hostname, content: cname, comment });
        } else {
            await api.updateDnsRecord({ apiToken, zoneId, recordId: record.id, name: hostname, content: cname, comment });
        }
        await awaitPropagation(hostname, ctx.log);
        return { url: `https://${hostname}` };
    },
    delete: async (inputs) => {
        const { hostname, zoneId, apiToken } = parseInputs(deleteSchema, inputs, "cf-route");
        const record = await api.findDnsRecord({ apiToken, zoneId, name: hostname });
        if (record === undefined) {
            return;
        }
        await api.deleteDnsRecord({ apiToken, zoneId, recordId: record.id });
    },
    // Scans the zone for stamped records; zone id is re-resolved from the cloudflare source since a scan has no read
    // pass to seed it.
    list: async (sources, ctx) => {
        const account = sources.find((source) => source.type === "cloudflare");
        if (account === undefined) {
            return [];
        }
        const { apiToken, zone } = parseInputs(z.object({ apiToken: z.string(), zone: z.string() }), account.inputs, "cloudflare");
        const found = await api.getZone({ apiToken, zone });
        if (found === undefined) {
            ctx.log(`cf-route list: zone "${zone}" not found, skipping scan`);
            return [];
        }
        const records = await api.listStampedDnsRecords({ apiToken, zoneId: found.id, commentPrefix: `${STAMP_KEY}=` });
        return records.flatMap((record) => {
            const id = parseStamp(record.comment);
            return id === undefined ? [] : [{ id, inputs: { hostname: record.name, zoneId: found.id, apiToken } }];
        });
    },
});
