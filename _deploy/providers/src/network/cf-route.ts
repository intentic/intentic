import { pollUntil, type Provider, type ResolvedInputs } from "@intentic/engine";
import { formatStamp, parseStamp, STAMP_KEY } from "@intentic/graph";
import { z } from "zod";
import { parseInputs } from "../core/inputs.js";
import type { CloudflareApi } from "./cloudflare-api.js";
import { cloudflareApi } from "./cloudflare-api.js";

const cfRouteSchema = z.object({ hostname: z.string(), zoneId: z.string(), apiToken: z.string(), cname: z.string() });
const parse = (inputs: ResolvedInputs): z.infer<typeof cfRouteSchema> => parseInputs(cfRouteSchema, inputs, "cf-route");
// Delete tears down by hostname alone — parsed separately so it also works from a ListedResource's inputs
// (which carry no cname; the target of an orphaned record is irrelevant to removing it).
const deleteSchema = cfRouteSchema.omit({ cname: true });

// Wait until a freshly-created proxied record is globally resolvable BEFORE any downstream provider (repo,
// app, deployment) resolves the hostname. This matters because the control-plane providers hit the public
// url from wherever the CLI runs: if they resolve the name during its propagation window the lookup fails
// AND the resolver caches NXDOMAIN for the zone's SOA negative-TTL (30 min on a Cloudflare zone), wedging
// every later attempt. We probe over DoH (an HTTPS call to Cloudflare's resolver) rather than the OS
// resolver, precisely so this readiness check never pollutes the cache the consumers depend on. Best-effort:
// if DoH itself is unreachable we log and proceed rather than block the apply.
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

// A cf-route owns one public hostname's proxied DNS CNAME pointing at the host tunnel's cfargotunnel
// hostname (the tunnel owns the ingress mapping the hostname to the internal service). read returns the
// route if a CNAME for the hostname exists, surfacing its current target via detail; diff reports drift
// when that target differs from the tunnel cname; apply upserts the proxied CNAME (stamped so it is
// attributable) and waits for it to propagate. The url output is derived from the hostname.
export const createCfRouteProvider = (
    api: CloudflareApi = cloudflareApi,
    awaitPropagation: DnsPropagationWait = waitForDnsPropagation,
): Provider => ({
    read: async (inputs) => {
        // On a fresh plan the cname ($ref to the tunnel's output) and even zoneId ($ref to the cf node) can
        // still be PENDING symbols — read must tolerate that (it's the engine's read contract), so it parses
        // only what it actually uses (the deleteSchema fields) and never touches cname. A PENDING zoneId
        // means the zone itself is a pending create — nothing to introspect yet.
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
        // The route exists but its tunnel is a pending create — the target cname is not derivable yet.
        // Report drift; apply resolves the real cname once the tunnel exists.
        if (typeof inputs["cname"] !== "string") {
            return { action: "update", reason: "tunnel not created yet — its cname is not derivable" };
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
    // Scan the zone for records stamped through their comment. The zone id is re-resolved from the
    // cloudflare source's authored (apiToken, zone) — a scan runs without any read pass to seed outputs.
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
