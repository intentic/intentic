import { Resolver } from "node:dns/promises";

// Authoritative TXT lookup for a DNS-01 challenge: a recursive resolver would cache the pre-publish NXDOMAIN for the
// zone's SOA minimum. Every failure reads as "nothing visible yet", since the caller is a poll with a deadline.

// A nameserver silent this long won't answer in one poll; tries: 1 since the poll is the retry.
const QUERY_TIMEOUT_MS = 3_000;

const resolverFor = (servers?: readonly string[]): Resolver => {
    const resolver = new Resolver({ timeout: QUERY_TIMEOUT_MS, tries: 1 });
    if (servers !== undefined) {
        resolver.setServers([...servers]);
    }
    return resolver;
};

// Walks up from the full name to find the zone's own nameservers; walking down would stop at the TLD, and the record's
// own name never carries NS records.
const nameserversFor = async (recordName: string): Promise<string[]> => {
    const resolver = resolverFor();
    const labels = recordName.split(".");
    // Stops before the last label: a TLD's nameservers know the delegation, not what's inside it.
    for (let index = 0; index < labels.length - 1; index += 1) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- a search, not a batch: each answer decides whether the next query is asked at all
        const nameservers = await resolver.resolveNs(labels.slice(index).join(".")).catch(() => []);
        if (nameservers.length > 0) {
            return nameservers;
        }
    }
    return [];
};

// Intersects each nameserver's TXT values rather than taking the union: a value on one but not another means the zone
// is still propagating, not yet published.
export const resolveTxtAuthoritatively = async (recordName: string): Promise<string[]> => {
    const nameservers = await nameserversFor(recordName);
    const perNameserver = await Promise.all(
        nameservers.map(async (nameserver) => {
            const addresses = await resolverFor()
                .resolve4(nameserver)
                .catch(() => []);
            if (addresses.length === 0) {
                return [];
            }
            const records = await resolverFor(addresses)
                .resolveTxt(recordName)
                .catch(() => []);
            // A TXT record arrives as 255-byte strings; the value is their concatenation.
            return records.map((chunks) => chunks.join(""));
        }),
    );
    return perNameserver.reduce<string[]>((shared, values) => shared.filter((value) => values.includes(value)), perNameserver[0] ?? []);
};
