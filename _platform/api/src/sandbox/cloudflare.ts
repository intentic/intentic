import {
    type CloudflareInit,
    CloudflareError,
    CloudflareTokenError as SharedTokenError,
    CloudflareZoneFullError,
    cloudflareCall,
    cloudflarePages,
} from "@intentic/base/cloudflare";
import { hostOwnerId, LOCAL_ADDRESS, LOCAL_LABEL, localWildcardHostname } from "@intentic/sandbox-contract";
import { z } from "zod";

// Cloudflare zone listing for the setup screen (user's token) and DNS for sandboxes' loopback certs (intentic's token);
// tunnels are provisioned in sandbox/reachability.ts. Pre-migration sandboxes are still reachable only through old
// tunnel DNS records, which the sweep below treats as live. No dependency on @intentic/providers.

// Cloudflare rejected the token (invalid, inactive, or missing Zone:Read); the router maps this to a user-facing
// BAD_REQUEST.
export class CloudflareTokenError extends Error {}

// The bearer, the envelope, the 30 s deadline and the paging are @intentic/base/cloudflare's, the one client the deploy
// engine calls Cloudflare with too. What is this platform's own is the wording a refusal reaches a person in: a bad
// token is the caller's 400, and a zone out of records (81045) blocks every sandbox's loopback certificate.
const refusal = (cause: unknown, tokenMessage: string): Error => {
    if (cause instanceof SharedTokenError) {
        return new CloudflareTokenError(tokenMessage, { cause });
    }
    if (cause instanceof CloudflareZoneFullError) {
        // Do not suggest deleting sandbox-*/ssh-* records: pre-migration sandboxes are reachable only through those.
        return new CloudflareError(
            `the Cloudflare zone is out of DNS records (Cloudflare's per-zone quota), so no sandbox in it can be issued a loopback certificate. The daily sweep reclaims what is genuinely unused (the records of sandboxes that no longer exist, and the per-sandbox local-* records one wildcard replaced) and logs what it found; deletions need INTENTIC_CLOUDFLARE_REAP=true on the deployment that owns this zone. Do not clear sandbox-*/ssh-*/port-slot records by hand: a sandbox created before the tunnel migration is reachable through exactly those. Raising the zone's plan limit is the other way out.`,
            cause.status,
            cause.codes,
        );
    }
    return cause instanceof Error ? cause : new Error(String(cause));
};

const zonesResultSchema = z.array(z.object({ name: z.string() }));

// Every zone name the token can see, paginated at 50/page. A 401/403 becomes a CloudflareTokenError.
export const listZoneNames = async (token: string): Promise<string[]> => {
    try {
        return zonesResultSchema.parse(await cloudflarePages(token, `/zones`)).map((zone) => zone.name);
    } catch (error) {
        throw refusal(error, "the Cloudflare API token is invalid or lacks the Zone:Read scope");
    }
};

// One Cloudflare call's validated `result`. A 401/403 becomes a CloudflareTokenError; any other failure propagates.
const cfCall = async <T>(token: string, path: string, resultSchema: z.ZodType<T>, init?: CloudflareInit): Promise<T> => {
    let result: unknown;
    try {
        result = await cloudflareCall(token, path, init);
    } catch (error) {
        throw refusal(error, "the intentic Cloudflare API token is invalid or lacks the required scope");
    }
    return resultSchema.parse(result);
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
    const body = {
        type: "A",
        name: hostname,
        content: LOCAL_ADDRESS,
        proxied: false,
        ttl: 86_400,
        comment: "intentic sandbox loopback",
    };
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
        // oxlint-disable-next-line eslint/no-await-in-loop -- Records are checked in sequence so stale state is deterministic.
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
        body: { type: "TXT", name: recordName, content: value, ttl: 60, comment: "intentic sandbox acme" },
    });
};

// Whether the zone's API holds `recordName` as a TXT carrying `value`: the provider's word that a challenge is published,
// for a host whose network cannot see the zone's nameservers (obtainCertificate's `confirmChallenge`).
export const acmeChallengeHolds = async (apiToken: string, zone: string, recordName: string, value: string): Promise<boolean> => {
    const { zoneId } = await resolveZone(apiToken, zone);
    const records = await cfCall(
        apiToken,
        `/zones/${encodeURIComponent(zoneId)}/dns_records?type=TXT&name=${encodeURIComponent(recordName)}`,
        z.array(z.object({ content: z.string() })),
    );
    // Cloudflare may hand a TXT's content back wrapped in quotes; the value inside is what a resolver serves.
    return records.some((record) => record.content.replace(/^"(.*)"$/, `$1`) === value);
};

const resolveZone = async (apiToken: string, zone: string): Promise<{ zoneId: string }> => {
    const zones = await cfCall(apiToken, `/zones?name=${encodeURIComponent(zone)}`, z.array(z.object({ id: z.string() })));
    const found = zones[0];
    if (found === undefined) {
        throw new Error(`the intentic Cloudflare zone "${zone}" was not found for the configured token`);
    }
    return { zoneId: found.id };
};

// Removes DNS residue that risks the zone's per-record quota (81045): tunnel CNAMEs and `_acme-challenge` TXTs of
// deleted sandboxes, and per-sandbox loopback A records now replaced by the wildcard. Verdicts come from the caller's
// sandbox ids and deletion records plus this same zone listing; only name shapes this platform mints are touched.
// (2026-10-05) A record is deleted for its sandbox only when that sandbox's id has a deletion record (SandboxTombstone).
// It used to go for any id with no row, so a platform restored from an older backup deleted the DNS of every sandbox
// made since; such a record is now counted as `forgotten` and left for an operator. A per-sandbox A record is still
// removed whatever its sandbox: the wildcard answers the same name, which is evidence of its own.
const RECORD_PAGE = 100;
const MAX_RECORD_PAGES = 200;
// Deletes per pass, the rest left for the next one (`deferred`): the destruction cap the hosted reaper has, so a bug in
// a verdict costs one pass's worth of records rather than the zone.
export const DNS_REAP_PER_PASS = 100;
const zoneRecordSchema = z.object({ id: z.string(), type: z.string(), name: z.string(), content: z.string() });

// The sandbox a tunnel record's name belongs to (`sandbox-<id>`, `ssh-<id>`, `<slot>-<id>`, ...), by the rule the edge
// routes a Host by, or undefined if it carries no id.
const recordSandboxId = (record: z.infer<typeof zoneRecordSchema>): string | undefined => hostOwnerId(record.name);

// The sandbox id a record of a sandbox-keyed shape belongs to: a CNAME onto a Cloudflare tunnel, or a loopback
// `_acme-challenge` TXT. Undefined for any other record, and for a name with no id, which this platform did not mint.
const keyedSandboxId = (record: z.infer<typeof zoneRecordSchema>, context: Pick<Reapable, `zone`>): string | undefined => {
    if (record.type === `CNAME` && /^[0-9a-f-]{36}\.cfargotunnel\.com$/.test(record.content)) {
        return recordSandboxId(record);
    }
    const perSandbox = record.name.endsWith(`.${LOCAL_LABEL}.${context.zone}`) || /^_acme-challenge\.local-[0-9a-f]{12}\./.test(record.name);
    const challenge = /^_acme-challenge\.(?:local-)?([0-9a-f]{12})\./.exec(record.name);
    return record.type === `TXT` && perSandbox && challenge !== null ? challenge[1] : undefined;
};

// A CNAME onto a Cloudflare tunnel whose sandbox was deleted. Not tied to whether anything still creates these:
// sandboxes from before the tunnel migration are still reachable only through them.
const danglingTunnelCname = (record: z.infer<typeof zoneRecordSchema>, context: Reapable): boolean => {
    if (record.type !== `CNAME`) {
        return false;
    }
    const owner = keyedSandboxId(record, context);
    // A name with no id wasn't minted by this platform, so it isn't collected.
    return owner !== undefined && context.deleted.has(owner) && !context.liveSandboxIds.has(owner);
};

interface Reapable {
    readonly zone: string;
    readonly liveSandboxIds: ReadonlySet<string>;
    // The ids among this zone's records that have a deletion record: the only "gone" a record is deleted for.
    readonly deleted: ReadonlySet<string>;
    // Whether `*.local.<zone>` is present in this zone; proves a per-sandbox loopback record is redundant.
    readonly wildcardPresent: boolean;
}

const orphanLoopbackRecord = (record: z.infer<typeof zoneRecordSchema>, context: Reapable): boolean => {
    const { zone, liveSandboxIds, deleted, wildcardPresent } = context;
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
    // An ACME challenge lives for one order; the only loopback record a live sandbox may still legitimately own, so it
    // goes only once its sandbox's deletion is on record.
    const challenge = /^_acme-challenge\.(?:local-)?([0-9a-f]{12})\./.exec(record.name);
    const owner = challenge?.[1] ?? ``;
    return record.type === `TXT` && challenge !== null && deleted.has(owner) && !liveSandboxIds.has(owner);
};

// Garbage is either kind, scoped to intentic's own zone first.
const orphanRecord = (record: z.infer<typeof zoneRecordSchema>, context: Reapable): boolean =>
    record.name.endsWith(`.${context.zone}`) && (danglingTunnelCname(record, context) || orphanLoopbackRecord(record, context));

export const reapOrphanDnsRecords = async (args: {
    apiToken: string;
    zone: string;
    liveSandboxIds: ReadonlySet<string>;
    // Which of these ids have a deletion record (SandboxTombstone); asked once per pass, for the ids the zone names.
    deletedAmong: (ids: readonly string[]) => Promise<ReadonlySet<string>>;
    dryRun: boolean;
    log: (record: { name: string; type: string; content: string }) => void;
    onError: (record: { name: string }, cause: unknown) => void;
    // How many records one pass deletes; DNS_REAP_PER_PASS unless a caller says otherwise.
    perPass?: number;
}): Promise<{ total: number; orphaned: number; reaped: number; failed: number; deferred: number; forgotten: number }> => {
    const { apiToken, zone, liveSandboxIds, deletedAmong, dryRun, log, onError, perPass = DNS_REAP_PER_PASS } = args;
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
    const scoped = records.filter((record) => record.name.endsWith(`.${zone}`));
    const keyed = [...new Set(scoped.map((record) => keyedSandboxId(record, { zone })).filter((id): id is string => id !== undefined))];
    const unknownIds = keyed.filter((id) => !liveSandboxIds.has(id));
    const deleted = unknownIds.length === 0 ? new Set<string>() : await deletedAmong(unknownIds);
    // Keyed to a sandbox this database has neither a row nor a deletion record for: never deleted, only counted.
    const forgotten = scoped.filter((record) => {
        const owner = keyedSandboxId(record, { zone });
        return owner !== undefined && !liveSandboxIds.has(owner) && !deleted.has(owner);
    }).length;
    const orphaned = records.filter((record) => orphanRecord(record, { zone, liveSandboxIds, deleted, wildcardPresent }));
    let reaped = 0;
    let failed = 0;
    for (const record of orphaned.slice(0, perPass)) {
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
    return { total: records.length, orphaned: orphaned.length, reaped, failed, deferred: Math.max(0, orphaned.length - perPass), forgotten };
};
