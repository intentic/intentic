import type { CloudflareApi } from "@intentic/providers";

// Resolve the zone (id + account) a bootstrap hostname lives under: an explicit override (getZone), else the
// token's sole zone, erroring when the token sees none or several (the operator must then set ZONE).
export const resolveZone = async (
    api: CloudflareApi,
    apiToken: string,
    override: string | undefined,
): Promise<{ id: string; name: string; accountId: string }> => {
    if (override !== undefined && override !== "") {
        const found = await api.getZone({ apiToken, zone: override });
        if (found === undefined) {
            throw new Error(`Cloudflare zone "${override}" not found for this API token`);
        }
        return { id: found.id, name: override, accountId: found.accountId };
    }
    const zones = await api.listZones({ apiToken });
    const [only, ...rest] = zones;
    if (only === undefined) {
        throw new Error("the Cloudflare API token sees no zones — add a domain to the account, or broaden the token's Zone:Read scope");
    }
    if (rest.length > 0) {
        const names = [only, ...rest].map((zone) => zone.name);
        throw new Error(
            `the Cloudflare API token sees multiple zones (${names.join(", ")}) — set the ZONE env var or pass --zone to choose one, e.g. --zone ${only.name}`,
        );
    }
    return only;
};

// Upsert a proxied CNAME `name` → `cname` (idempotent), stamped with `comment` so it is attributable.
export const upsertCname = async (
    api: CloudflareApi,
    apiToken: string,
    zoneId: string,
    name: string,
    cname: string,
    comment: string,
): Promise<void> => {
    const record = await api.findDnsRecord({ apiToken, zoneId, name });
    if (record === undefined) {
        await api.createDnsRecord({ apiToken, zoneId, name, content: cname, comment });
    } else {
        await api.updateDnsRecord({ apiToken, zoneId, recordId: record.id, name, content: cname, comment });
    }
};
