import { LOCAL_ADDRESS, LOCAL_LABEL, localWildcardHostname } from "@intentic/sandbox-contract";
import { z } from "zod";

// Cloudflare zone listing for the setup screen (user's token) and DNS for sandboxes' loopback certs (intentic's token);
// tunnels are provisioned in sandbox/reachability.ts. Pre-migration sandboxes are still reachable only through old
// tunnel DNS records, which the sweep below treats as live. No dependency on @intentic/providers.

const BASE = "https://api.cloudflare.com/client/v4";

// Cloudflare rejected the token (invalid, inactive, or missing Zone:Read); the router maps this to a user-facing
// BAD_REQUEST.
export class CloudflareTokenError extends Error {}

// A non-2xx Cloudflare response other than the token case (see CloudflareTokenError). `codes` are the numeric error
// codes from the response envelope, since Cloudflare rewords messages.
class CloudflareApiError extends Error {
    constructor(
        message: string,
        readonly codes: number[],
    ) {
        super(message);
    }
}

// `result` stays unknown so an error envelope's `errors` surface before the result-shape check runs.
const envelopeSchema = z.object({
    success: z.boolean(),
    errors: z.array(z.object({ code: z.number(), message: z.string() })),
    result: z.unknown(),
    result_info: z.object({ total_pages: z.number() }).partial().optional(),
});
const zonesResultSchema = z.array(z.object({ name: z.string() }));

// Every zone name the token can see, paginated at 50/page. A 401/403 becomes a CloudflareTokenError.
export const listZoneNames = async (token: string): Promise<string[]> => {
    const names: string[] = [];
    let page = 1;
    let totalPages = 1;
    do {
        // oxlint-disable-next-line eslint/no-await-in-loop -- pagination: totalPages is only known after fetching each page, so pages must be fetched sequentially
        const response = await fetch(`${BASE}/zones?per_page=50&page=${page}`, {
            headers: { Authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(30_000),
        });
        if (response.status === 401 || response.status === 403) {
            throw new CloudflareTokenError("the Cloudflare API token is invalid or lacks the Zone:Read scope");
        }
        // oxlint-disable-next-line eslint/no-await-in-loop -- reading this page's body before deciding whether a next page exists
        const envelope = envelopeSchema.parse(await response.json());
        if (!response.ok || !envelope.success) {
            const detail = envelope.errors.map((error) => `${error.code} ${error.message}`).join("; ");
            throw new Error(`Cloudflare GET /zones failed (HTTP ${response.status}): ${detail}`);
        }
        for (const zone of zonesResultSchema.parse(envelope.result)) {
            names.push(zone.name);
        }
        totalPages = envelope.result_info?.total_pages ?? 1;
        page += 1;
    } while (page <= totalPages);
    return names;
};

// Fetches and validates a Cloudflare success envelope, returning the parsed `result`. A 401/403 becomes a
// CloudflareTokenError; any other failure propagates unchanged.
const cfCall = async <T>(token: string, path: string, resultSchema: z.ZodType<T>, init?: RequestInit): Promise<T> => {
    const response = await fetch(`${BASE}${path}`, {
        ...init,
        headers: {
            Authorization: `Bearer ${token}`,
            ...(init?.body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        // A stalled Cloudflare API must fail rather than hang the caller forever.
        signal: AbortSignal.timeout(30_000),
    });
    if (response.status === 401 || response.status === 403) {
        throw new CloudflareTokenError("the intentic Cloudflare API token is invalid or lacks the required scope");
    }
    const envelope = envelopeSchema.parse(await response.json());
    if (!response.ok || !envelope.success) {
        const detail = envelope.errors.map((error) => `${error.code} ${error.message}`).join("; ");
        const codes = envelope.errors.map((error) => error.code);
        // 81045 means the zone is out of DNS records, which blocks ACME issuance for every sandbox, not just one.
        if (codes.includes(81045)) {
            // Do not suggest deleting sandbox-*/ssh-* records: pre-migration sandboxes are reachable only through
            // those.
            throw new CloudflareApiError(
                `the Cloudflare zone is out of DNS records (Cloudflare's per-zone quota), so no sandbox in it can be issued a loopback certificate. The daily sweep reclaims what is genuinely unused (the records of sandboxes that no longer exist, and the per-sandbox local-* records one wildcard replaced) and logs what it found; deletions need INTENTIC_CLOUDFLARE_REAP=true on the deployment that owns this zone. Do not clear sandbox-*/ssh-*/port-slot records by hand: a sandbox created before the tunnel migration is reachable through exactly those. Raising the zone's plan limit is the other way out.`,
                codes,
            );
        }
        throw new CloudflareApiError(`Cloudflare ${init?.method ?? "GET"} ${path} failed (HTTP ${response.status}): ${detail}`, codes);
    }
    return resultSchema.parse(envelope.result);
};

// One wildcard A record (`*.local.<zone>` to 127.0.0.1, unproxied) answers every sandbox's loopback hostname. Asserted
// on every relay; ACME challenge TXTs are still minted per sandbox since it has no token for this zone.
export const ensureLocalDnsRecord = async (apiToken: string, zone: string): Promise<void> => {
    const { zoneId } = await resolveZone(apiToken, zone);
    const hostname = localWildcardHostname(zone);
    const records = await cfCall(
        apiToken,
        `/zones/${encodeURIComponent(zoneId)}/dns_records?type=A&name=${encodeURIComponent(hostname)}`,
        z.array(z.object({ id: z.string() })),
    );
    // A day: the content never changes, so a long TTL only helps caching, never risks staleness.
    const body = JSON.stringify({
        type: "A",
        name: hostname,
        content: LOCAL_ADDRESS,
        proxied: false,
        ttl: 86_400,
        comment: "intentic sandbox loopback",
    });
    const recordId = records[0]?.id;
    await cfCall(
        apiToken,
        recordId === undefined
            ? `/zones/${encodeURIComponent(zoneId)}/dns_records`
            : `/zones/${encodeURIComponent(zoneId)}/dns_records/${encodeURIComponent(recordId)}`,
        z.unknown(),
        { method: recordId === undefined ? "POST" : "PUT", body },
    );
};

// Publish (value given) or withdraw (value undefined) the sandbox's DNS-01 challenge record.
export const setAcmeChallenge = async (apiToken: string, zone: string, recordName: string, value: string | undefined): Promise<void> => {
    const { zoneId } = await resolveZone(apiToken, zone);
    const existing = await cfCall(
        apiToken,
        `/zones/${encodeURIComponent(zoneId)}/dns_records?type=TXT&name=${encodeURIComponent(recordName)}`,
        z.array(z.object({ id: z.string() })),
    );
    for (const record of existing) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- at most a couple of records; a stale one left behind can validate a dead token
        await cfCall(apiToken, `/zones/${encodeURIComponent(zoneId)}/dns_records/${encodeURIComponent(record.id)}`, z.unknown(), {
            method: "DELETE",
        });
    }
    if (value === undefined) {
        return;
    }
    await cfCall(apiToken, `/zones/${encodeURIComponent(zoneId)}/dns_records`, z.unknown(), {
        method: "POST",
        // 60s: the record is withdrawn right after validation, so nothing needs a longer TTL.
        body: JSON.stringify({ type: "TXT", name: recordName, content: value, ttl: 60, comment: "intentic sandbox acme" }),
    });
};

const resolveZone = async (apiToken: string, zone: string): Promise<{ zoneId: string }> => {
    const zones = await cfCall(apiToken, `/zones?name=${encodeURIComponent(zone)}`, z.array(z.object({ id: z.string() })));
    const found = zones[0];
    if (found === undefined) {
        throw new Error(`the intentic Cloudflare zone "${zone}" was not found for the configured token`);
    }
    return { zoneId: found.id };
};

// Removes DNS residue that risks the zone's per-record quota (81045): stale tunnel CNAMEs, per-sandbox loopback A
// records now replaced by the wildcard, and abandoned `_acme-challenge` TXTs. Verdicts come from the caller's
// liveSandboxIds plus this same zone listing; only name shapes this platform mints are touched.
const RECORD_PAGE = 100;
const MAX_RECORD_PAGES = 200;
const zoneRecordSchema = z.object({ id: z.string(), type: z.string(), name: z.string(), content: z.string() });

// Extracts the trailing 12-hex sandbox id from a tunnel record's name (`sandbox-<id>`, `ssh-<id>`, `<slot>-<id>`, ...),
// or undefined if absent.
const recordSandboxId = (record: z.infer<typeof zoneRecordSchema>): string | undefined => /^[^.]*-([0-9a-f]{12})\./.exec(record.name)?.[1];

// A CNAME onto a Cloudflare tunnel whose sandbox no longer exists. Not tied to whether anything still creates these:
// sandboxes from before the tunnel migration are still reachable only through them.
const danglingTunnelCname = (record: z.infer<typeof zoneRecordSchema>, context: Reapable): boolean => {
    if (record.type !== `CNAME` || !/^[0-9a-f-]{36}\.cfargotunnel\.com$/.test(record.content)) {
        return false;
    }
    const owner = recordSandboxId(record);
    // A name with no id wasn't minted by this platform, so it isn't collected.
    return owner !== undefined && !context.liveSandboxIds.has(owner);
};

interface Reapable {
    readonly zone: string;
    readonly liveSandboxIds: Set<string>;
    // Whether `*.local.<zone>` is present in this zone; proves a per-sandbox loopback record is redundant.
    readonly wildcardPresent: boolean;
}

const orphanLoopbackRecord = (record: z.infer<typeof zoneRecordSchema>, context: Reapable): boolean => {
    const { zone, liveSandboxIds, wildcardPresent } = context;
    // The record every loopback name resolves under; never itself orphaned.
    if (record.name === localWildcardHostname(zone)) {
        return false;
    }
    // Either spelling: the current `<id>.local.<zone>` or the `local-<id>.<zone>` the wildcard replaced.
    const perSandbox = record.name.endsWith(`.${LOCAL_LABEL}.${zone}`) || /^local-[0-9a-f]{12}\./.test(record.name);
    if (!perSandbox || !wildcardPresent) {
        return false;
    }
    // Not keyed to liveness: with the wildcard up, no sandbox needs its own A record.
    if (record.type === `A`) {
        return true;
    }
    // An ACME challenge lives for one order; the only loopback record a live sandbox may still legitimately own.
    const challenge = /^_acme-challenge\.(?:local-)?([0-9a-f]{12})\./.exec(record.name);
    return record.type === `TXT` && challenge !== null && !liveSandboxIds.has(challenge[1] ?? ``);
};

// Garbage is either kind, scoped to intentic's own zone first.
const orphanRecord = (record: z.infer<typeof zoneRecordSchema>, context: Reapable): boolean =>
    record.name.endsWith(`.${context.zone}`) && (danglingTunnelCname(record, context) || orphanLoopbackRecord(record, context));

export const reapOrphanDnsRecords = async (args: {
    apiToken: string;
    zone: string;
    liveSandboxIds: Set<string>;
    dryRun: boolean;
    log: (record: { name: string; type: string; content: string }) => void;
    onError: (record: { name: string }, error: unknown) => void;
}): Promise<{ total: number; orphaned: number; reaped: number; failed: number }> => {
    const { apiToken, zone, liveSandboxIds, dryRun, log, onError } = args;
    const { zoneId } = await resolveZone(apiToken, zone);
    const records: z.infer<typeof zoneRecordSchema>[] = [];
    for (let page = 1; page <= MAX_RECORD_PAGES; page += 1) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- pagination
        const batch = await cfCall(
            apiToken,
            `/zones/${encodeURIComponent(zoneId)}/dns_records?per_page=${RECORD_PAGE}&page=${page}`,
            z.array(zoneRecordSchema),
        );
        records.push(...batch);
        if (batch.length < RECORD_PAGE) {
            break;
        }
    }
    // Reuses the listing already fetched, so it matches the same snapshot as the verdicts below.
    const wildcardPresent = records.some((record) => record.type === `A` && record.name === localWildcardHostname(zone));
    const orphaned = records.filter((record) => orphanRecord(record, { zone, liveSandboxIds, wildcardPresent }));
    let reaped = 0;
    let failed = 0;
    for (const record of orphaned) {
        log({ name: record.name, type: record.type, content: record.content });
        if (dryRun) {
            continue;
        }
        try {
            // oxlint-disable-next-line eslint/no-await-in-loop -- sequenced deletes keep Cloudflare rate limits comfortable
            await cfCall(apiToken, `/zones/${encodeURIComponent(zoneId)}/dns_records/${encodeURIComponent(record.id)}`, z.unknown(), {
                method: "DELETE",
            });
            reaped += 1;
        } catch (error) {
            failed += 1;
            onError({ name: record.name }, error);
        }
    }
    return { total: records.length, orphaned: orphaned.length, reaped, failed };
};
