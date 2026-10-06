import { Resolver } from "node:dns/promises";

// Authoritative TXT lookup for a DNS-01 challenge: a recursive resolver would cache the pre-publish NXDOMAIN for the
// zone's SOA minimum. A failure never throws, since the caller is a poll with a deadline; it reads as no values, and
// `reached` says whether that was the zone answering or this host never getting through to it.

// A nameserver silent this long won't answer in one poll; tries: 1 since the poll is the retry.
const QUERY_TIMEOUT_MS = 3_000;

// The resolver codes that are a nameserver answering "no such record" rather than failing to answer at all.
const ANSWERED_EMPTY = new Set(["ENOTFOUND", "ENODATA"]);

export interface TxtLookup {
    // The values every one of the zone's nameservers serves; empty when any of them did not answer.
    readonly values: string[];
    // How many of the zone's nameservers answered, a TXT set or a definitive no: "none" also covers a zone whose
    // nameservers could not be found. A host whose network blocks or intercepts direct DNS sees "none" forever.
    readonly reached: "all" | "some" | "none";
}

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
        // oxlint-disable-next-line eslint/no-await-in-loop -- Each answer decides whether the next query runs.
        // allow(silent-catch): nothing visible yet, since the caller is a poll with a deadline.
        const nameservers = await resolver.resolveNs(labels.slice(index).join(".")).catch(() => []);
        if (nameservers.length > 0) {
            return nameservers;
        }
    }
    return [];
};

// One nameserver's TXT values, or undefined when it never answered (its address unknown, a timeout, a refusal).
const askNameserver = async (nameserver: string, recordName: string): Promise<string[] | undefined> => {
    const addresses = await resolverFor()
        .resolve4(nameserver)
        // allow(silent-catch): an unresolvable nameserver is one this host cannot reach; the caller polls again.
        .catch(() => []);
    if (addresses.length === 0) {
        return undefined;
    }
    try {
        const records = await resolverFor(addresses).resolveTxt(recordName);
        // A TXT record arrives as 255-byte strings; the value is their concatenation.
        return records.map((chunks) => chunks.join(""));
    } catch (error) {
        return error instanceof Error && "code" in error && ANSWERED_EMPTY.has(String(error.code)) ? [] : undefined;
    }
};

// Intersects each nameserver's TXT values rather than taking the union: a value on one but not another means the zone
// is still propagating, not yet published.
export const resolveTxtAuthoritatively = async (recordName: string): Promise<TxtLookup> => {
    const nameservers = await nameserversFor(recordName);
    const answers = await Promise.all(nameservers.map((nameserver) => askNameserver(nameserver, recordName)));
    const answered = answers.filter((values) => values !== undefined);
    const reached = answered.length === 0 ? "none" : answered.length === answers.length ? "all" : "some";
    const values = reached === "all" ? answered.reduce((shared, next) => shared.filter((value) => next.includes(value)), answered[0] ?? []) : [];
    return { values, reached };
};
