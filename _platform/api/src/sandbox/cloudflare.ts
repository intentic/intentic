import { LOCAL_ADDRESS, LOCAL_LABEL, localWildcardHostname } from "@intentic/sandbox-contract";
import { z } from "zod";

/* WHAT THIS PLATFORM STILL ASKS CLOUDFLARE FOR, which is two unrelated things and no longer a tunnel.
 *
 *   • The setup screen's ZONE PICKER, against the USER's own token. Request-scoped: the token lists the zones
 *     it can see and is then dropped with the request, never persisted, logged or stored. The browser cannot
 *     call Cloudflare directly (its API returns no CORS headers for a token'd request), so this minimal
 *     server-side proxy stands in.
 *   • The DNS behind the LOOPBACK CERTIFICATE, against intentic's own token: one wildcard record for the whole
 *     zone, and one transient ACME challenge per order.
 *
 * The tunnel fabric is the zrok hub (sandbox/zrok.ts). Provisioning, teardown, ingress, per-route CNAMEs, the
 * connector token and the tunnel reaper all lived here and are gone: nothing creates a Cloudflare tunnel, and
 * the only trace left is a sweep that reclaims the records the old machinery minted (reapOrphanDnsRecords).
 *
 * Deliberately standalone: the platform must not depend on the sandbox's @intentic/providers, the secret-free
 * architecture keeps platform and sandbox code apart. */

const BASE = "https://api.cloudflare.com/client/v4";

// Cloudflare rejected the token, invalid/inactive, or missing the Zone:Read scope. The router maps this to a
// user-facing BAD_REQUEST so the setup screen can tell the user to fix the token. Any other failure (network,
// unexpected response shape) propagates unchanged.
export class CloudflareTokenError extends Error {}

// A non-2xx Cloudflare response (other than the 401/403 token case, which is CloudflareTokenError). `codes` are
// the numeric error codes from the response envelope (e.g. 1022 = tunnel has active connections) so callers can
// branch on the code rather than the human message, which Cloudflare rewords. Extends Error so the existing
// `instanceof Error` → BAD_GATEWAY catchers keep mapping it.
class CloudflareApiError extends Error {
    constructor(
        message: string,
        readonly codes: number[],
    ) {
        super(message);
    }
}

// `result` is left unknown so an error envelope (success:false, result:null) surfaces its `errors` rather than
// failing the result-shape check first, validated as a zone array only after the success check passes.
const envelopeSchema = z.object({
    success: z.boolean(),
    errors: z.array(z.object({ code: z.number(), message: z.string() })),
    result: z.unknown(),
    result_info: z.object({ total_pages: z.number() }).partial().optional(),
});
const zonesResultSchema = z.array(z.object({ name: z.string() }));

// Every zone name the token can see, paginated (50/page). A 401/403 becomes a CloudflareTokenError so the
// caller can present "fix your token" rather than a generic failure.
// The platform keeps a self-contained Cloudflare REST client (zone listing here + tunnel provisioning below)
// rather than importing @intentic/providers, so the thin platform API never pulls the engine's SSH/Docker deps.
// The one thing that MUST agree with the CLI/daemon, the tunnel-id digest, is shared via
// @intentic/sandbox-contract/tunnel-ids (imported above), so only Cloudflare's own stable GET /zones shape is
// duplicated, and only that needs keeping in step.
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

// Fetch + validate a Cloudflare success envelope, returning the parsed `result`. A 401/403 becomes a
// CloudflareTokenError (a misconfigured intentic token surfaces the same way an under-scoped user token does);
// any other transport/API failure propagates unchanged.
const cfCall = async <T>(token: string, path: string, resultSchema: z.ZodType<T>, init?: RequestInit): Promise<T> => {
    const response = await fetch(`${BASE}${path}`, {
        ...init,
        headers: {
            Authorization: `Bearer ${token}`,
            ...(init?.body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        // A stalled Cloudflare API must reject (surfacing a 502 upstream) rather than hang the caller forever.
        signal: AbortSignal.timeout(30_000),
    });
    if (response.status === 401 || response.status === 403) {
        throw new CloudflareTokenError("the intentic Cloudflare API token is invalid or lacks the required scope");
    }
    const envelope = envelopeSchema.parse(await response.json());
    if (!response.ok || !envelope.success) {
        const detail = envelope.errors.map((error) => `${error.code} ${error.message}`).join("; ");
        const codes = envelope.errors.map((error) => error.code);
        /* THE ONE REFUSAL THAT IS THE OPERATOR'S TO FIX, NOT A MYSTERY. A zone has a hard record cap (a few
         * hundred on the smaller plans), and a full one refuses the ACME challenge every loopback certificate
         * needs, so issuance stops for every sandbox at once, the certified h2 shortcut resolves nowhere, and
         * browsers fall back to a plain HTTP/1.1 loopback with six connections per origin. That surfaces as
         * workspaces freezing, which names neither DNS nor a quota.
         *
         * Nothing per-sandbox is minted here any more (one wildcard, one transient challenge), so a zone that
         * fills now is carrying records from before that: the `sandbox-*`/`ssh-*` CNAMEs of the retired
         * Cloudflare tunnels and the `local-<id>` A records the wildcard replaced. reapOrphanDnsRecords
         * collects both. Left as Cloudflare's own words this reads as an intentic bug ("POST
         * /zones/44823fc.../dns_records failed (HTTP 400): 81045 Record quota exceeded") and the person who can
         * actually fix it is never told what to do. */
        if (codes.includes(81045)) {
            throw new CloudflareApiError(
                `the Cloudflare zone is out of DNS records (Cloudflare's per-zone quota). Nothing intentic mints now is per-sandbox, so the zone is holding residue: sandbox-*/ssh-* CNAMEs from the retired Cloudflare tunnels and local-* A records the wildcard replaced. The daily sweep collects both; deleting them in the Cloudflare dashboard is the immediate fix, or move the zone to a plan with a higher limit.`,
                codes,
            );
        }
        throw new CloudflareApiError(`Cloudflare ${init?.method ?? "GET"} ${path} failed (HTTP ${response.status}): ${detail}`, codes);
    }
    return resultSchema.parse(envelope.result);
};

/* The DNS half of every sandbox's LOOPBACK CERTIFICATE (see @intentic/sandbox-contract localHostname).
 *
 * ONE record for the whole platform: `*.local.<zone>` A → 127.0.0.1, UNPROXIED. Proxying would send it to
 * Cloudflare, which is the round trip this whole path exists to avoid, and Cloudflare will not proxy a loopback
 * origin anyway. Every `<id>.local.<zone>` a sandbox ever asks for resolves under it, so a sandbox costs the
 * zone NOTHING permanent, and no sandbox has to be told about a record before its name works.
 *
 * That is a correction, not a tidy-up. Each sandbox used to get its own `local-<id>` A record, and after the
 * tunnels moved to the zrok hub those were the last per-sandbox records left in this zone. They accumulated
 * until it hit the per-record quota (81045), and a full zone cannot take the ACME challenge either, so
 * issuance stopped for everyone: the certified shortcut resolved nowhere, every browser fell back to the plain
 * http loopback, and that transport is HTTP/1.1 with six connections per origin. Sandboxes froze, and the zone
 * that caused it was not something any sandbox could see.
 *
 * Asserted on every relay rather than at setup: it is idempotent and costs one call, it is the only way a
 * fresh deployment gets the record at all, and a record deleted by hand comes back on the next renewal check
 * rather than at the next quarter's reissue.
 *
 * The one thing still minted per sandbox is `_acme-challenge.<id>.local.<zone>` TXT, published for the length
 * of one ACME order and removed after, which the quota only ever sees a handful of at a time. The daemon
 * drives its own issuance and holds the key; it relays here for these records ONLY, because on the
 * intentic-provided path the sandbox has no token for this zone. The platform lends its zone, never the
 * private material.
 *
 * A TXT upsert must REPLACE rather than append: a retried order mints a fresh challenge value, and leaving the
 * previous one behind is how a DNS-01 validation starts passing against a stale token.
 */
export const ensureLocalDnsRecord = async (apiToken: string, zone: string): Promise<void> => {
    const { zoneId } = await resolveZone(apiToken, zone);
    const hostname = localWildcardHostname(zone);
    const records = await cfCall(
        apiToken,
        `/zones/${encodeURIComponent(zoneId)}/dns_records?type=A&name=${encodeURIComponent(hostname)}`,
        z.array(z.object({ id: z.string() })),
    );
    /* A DAY, against Cloudflare's 300s default, and the TTL is doing real work here rather than saving
     * lookups. This record says 127.0.0.1 and will say 127.0.0.1 forever, so nothing is risked by caching it —
     * and what it buys is the outage. A browser that has this name cached keeps reaching the daemon over the
     * certified h2 address after the machine goes offline; one that does not falls through to plain http, which
     * is HTTP/1.1 with six connections per origin for the whole app. The cache is the difference between a
     * dropped wifi being invisible and a workspace that starts lagging a few minutes later. */
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
        // 60s TTL: the record lives for one validation and is then withdrawn, so a long TTL only delays the
        // next order's fresh value becoming visible.
        body: JSON.stringify({ type: "TXT", name: recordName, content: value, ttl: 60, comment: "intentic sandbox acme" }),
    });
};

// Resolve an intentic-owned zone name to its zone id. The owning account id came back here too while tunnels
// were provisioned per sandbox; nothing outside a zone's own records is asked for any more.
const resolveZone = async (apiToken: string, zone: string): Promise<{ zoneId: string }> => {
    const zones = await cfCall(apiToken, `/zones?name=${encodeURIComponent(zone)}`, z.array(z.object({ id: z.string() })));
    const found = zones[0];
    if (found === undefined) {
        throw new Error(`the intentic Cloudflare zone "${zone}" was not found for the configured token`);
    }
    return { zoneId: found.id };
};

// Provision (idempotently) an intentic-owned remotely-managed tunnel + proxied DNS: find-or-create the tunnel
/* THE RECORD-LEVEL SWEEP: what this zone still holds that nothing is using, and the only thing standing
 * between a deployment and Cloudflare's per-zone record cap (81045). Hitting that cap is not a cosmetic
 * problem. A full zone cannot take the loopback certificate's ACME challenge either, so issuance stops for
 * every sandbox at once, the certified shortcut resolves nowhere, and every browser falls back to the plain
 * HTTP/1.1 loopback, six connections per origin, which is how a DNS quota surfaces as a frozen workspace.
 *
 * Three shapes, all of them residue by construction rather than by inspection:
 *
 *   • tunnel CNAMEs, the sandbox-, ssh-, port-slot, preview and public records pointing at
 *     `<tunnelId>.cfargotunnel.com`. The fabric moved to the zrok hub and nothing has minted one since, so
 *     every one of them is left over from before that migration;
 *   • per-sandbox loopback A records in either spelling, `<id>.local.<zone>` and the older `local-<id>.<zone>`.
 *     One wildcard now answers for all of them, so not one is needed, and no tunnel teardown ever cleaned one;
 *   • `_acme-challenge.<id>.local.<zone>` TXTs, meant to live for one ACME order, left behind by a crashed one.
 *     The only shape here a LIVE sandbox may own right now, so the only one keyed to liveness.
 *
 * The verdicts come from the caller's DB truth (liveSandboxIds, every 12-hex id derivable from the rows' token
 * digests) plus the zone listing itself, in one sweep and no other API surface: asking Cloudflare about
 * tunnels needs a scope this token no longer has, and when that call threw it took the entire sweep with it,
 * every day, silently, which is how the zone filled up in the first place. Only name shapes this
 * platform mints are ever touched: anything else in the zone, the apex, mail, a hand-made record, is
 * invisible to the filter by construction. `total` reports the zone's record count either way, because the
 * operator watching quota pressure needs the number before 81045 says it for them. */
const RECORD_PAGE = 100;
const MAX_RECORD_PAGES = 200;
const zoneRecordSchema = z.object({ id: z.string(), type: z.string(), name: z.string(), content: z.string() });

/* Whether one record in intentic's zone belongs to nothing. Pure, and separated from the sweep that deletes,
 * because "what is garbage" is the part that has to be RIGHT: a false positive here deletes a name a live
 * sandbox is reachable under, and the sweep runs unattended every day. */
const danglingTunnelCname = (record: z.infer<typeof zoneRecordSchema>): boolean =>
    /* Any CNAME onto a Cloudflare tunnel, with no check of whether that tunnel still exists. It used to ask,
     * which meant listing the account's tunnels, which needs a scope this token no longer has: the fabric moved
     * to the zrok hub and the token was narrowed to DNS. The listing then threw, the throw took the WHOLE sweep
     * with it, and the zone filled up with nobody collecting it, which is how a per-record quota ended up
     * freezing workspaces. There is nothing to ask now: this platform stopped creating tunnel records, so every
     * one of these is residue by definition. */
    record.type === `CNAME` && /^[0-9a-f-]{36}\.cfargotunnel\.com$/.test(record.content);

interface Reapable {
    readonly zone: string;
    readonly liveSandboxIds: Set<string>;
    /* Whether `*.local.<zone>` is actually in this zone right now, read off the same listing rather than
     * assumed. It is the PROOF that a per-sandbox loopback record is redundant: without it, deleting one takes
     * a live sandbox's certified shortcut off the internet, and the sweep runs unattended. Absent, the loopback
     * records are left alone and only the tunnel residue is collected. */
    readonly wildcardPresent: boolean;
}

const orphanLoopbackRecord = (record: z.infer<typeof zoneRecordSchema>, context: Reapable): boolean => {
    const { zone, liveSandboxIds, wildcardPresent } = context;
    // The one record every loopback name resolves under, and the reason none of them needs its own.
    if (record.name === localWildcardHostname(zone)) {
        return false;
    }
    /* A per-sandbox loopback record. Both spellings, the current `<id>.local.<zone>` and the
     * `local-<id>.<zone>` the wildcard replaced, since the zone is still carrying one of those for every
     * sandbox that ever asked for a certificate, and that accumulation is what exhausted the quota. */
    const perSandbox = record.name.endsWith(`.${LOCAL_LABEL}.${zone}`) || /^local-[0-9a-f]{12}\./.test(record.name);
    if (!perSandbox || !wildcardPresent) {
        return false;
    }
    /* The A is NOT keyed to liveness: with the wildcard up there is no sandbox, live or dead, that wants one of
     * its own. */
    if (record.type === `A`) {
        return true;
    }
    /* An ACME challenge, which lives for the length of one order and is withdrawn after. This is the one
     * loopback record a live sandbox may legitimately own right now, so it is the one that still asks. */
    const challenge = /^_acme-challenge\.(?:local-)?([0-9a-f]{12})\./.exec(record.name);
    return record.type === `TXT` && challenge !== null && !liveSandboxIds.has(challenge[1] ?? ``);
};

// Garbage is either kind, and both are scoped to intentic's own zone before anything else is asked.
const orphanRecord = (record: z.infer<typeof zoneRecordSchema>, context: Reapable): boolean =>
    record.name.endsWith(`.${context.zone}`) && (danglingTunnelCname(record) || orphanLoopbackRecord(record, context));

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
    // Read off the listing we already have rather than asked for separately: one request, and the answer is
    // about the same snapshot the verdicts below are made against.
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
