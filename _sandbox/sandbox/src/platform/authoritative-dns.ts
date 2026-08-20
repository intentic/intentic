import { Resolver } from "node:dns/promises";

/* WHAT A ZONE'S OWN NAMESERVERS SERVE FOR A NAME, the lookup that stands between publishing a DNS-01
 * challenge and asking a CA to validate it.
 *
 * It has to be AUTHORITATIVE rather than an ordinary recursive lookup, and the reason is the whole point of
 * this module. The name being asked about did not exist a moment ago, so the first recursive query for it
 * caches an NXDOMAIN for the zone's SOA minimum — 1800 seconds on a Cloudflare zone. Polling a recursive
 * resolver to find out whether a record has appeared would therefore prime the very cache that answers "no"
 * for the next half hour. A zone's own nameservers hold no cache: they answer from the zone, and change the
 * instant the zone does.
 *
 * Every failure reads as "nothing visible yet" rather than throwing. The caller is a poll with a deadline, so
 * a nameserver that blinks costs one lookup instead of an issuance, and a genuinely broken zone surfaces as
 * the timeout it actually is. */

// A nameserver that has not answered in this long is not going to inside one poll interval. `tries: 1` because
// the poll is the retry, c-ares' own backoff would only make each round less responsive.
const QUERY_TIMEOUT_MS = 3_000;

const resolverFor = (servers?: readonly string[]): Resolver => {
    const resolver = new Resolver({ timeout: QUERY_TIMEOUT_MS, tries: 1 });
    if (servers !== undefined) {
        resolver.setServers([...servers]);
    }
    return resolver;
};

/* The nameservers for whichever zone contains this record. Found by walking UP from the full name: the first
 * ancestor that has an NS set is the zone cut we want. Walking down from the root would stop at the TLD, and
 * asking the record's own name is wrong too, a leaf never carries NS records. */
const nameserversFor = async (recordName: string): Promise<string[]> => {
    const resolver = resolverFor();
    const labels = recordName.split(".");
    // Stop before the last label: a TLD's nameservers know the delegation, not the records inside it.
    for (let index = 0; index < labels.length - 1; index += 1) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- a search, not a batch: each answer decides whether the next query is asked at all
        const nameservers = await resolver.resolveNs(labels.slice(index).join(".")).catch(() => []);
        if (nameservers.length > 0) {
            return nameservers;
        }
    }
    return [];
};

/* The TXT values EVERY nameserver of the zone serves for this name. The intersection rather than the union is
 * deliberate: a value present on one nameserver and absent on another is a zone mid-propagation, which is
 * exactly the state the caller is waiting out, reporting it as published would defeat the wait. */
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
            // A TXT record arrives as its 255-byte strings; the value is their concatenation.
            return records.map((chunks) => chunks.join(""));
        }),
    );
    return perNameserver.reduce<string[]>((shared, values) => shared.filter((value) => values.includes(value)), perNameserver[0] ?? []);
};
