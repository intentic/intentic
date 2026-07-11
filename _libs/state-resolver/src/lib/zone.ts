import type { IntentSet } from "@intentic/need-resolver";

// Every domain the author declared across apps and services — the hostnames the deployment routes through
// Cloudflare. The derived platform domains (git.<zone>/deploy.<zone>) are NOT included: they hang off the
// zone, they don't determine it.
export const collectDomains = (intent: IntentSet): string[] => [
    ...intent.apps.flatMap((app) => Object.values(app.environments).map((environment) => environment.domain)),
    ...intent.services.map((service) => service.domain),
];

// True when `domain` belongs to the zone `name`: the apex itself, or a subdomain matched on a label boundary
// (so "notexample.com" does not match zone "example.com").
const inZone = (domain: string, name: string): boolean => domain === name || domain.endsWith(`.${name}`);

// Pick the single Cloudflare zone every authored domain lives under, given the zones the token can see.
// intentic exposes everything through one zone, so all domains must resolve to the same one; the most
// specific (longest) matching zone wins per domain, which handles subdomain zones. With no authored domains
// (e.g. a platform-only deploy) it falls back to the token's single zone. Throws if the token sees no zones,
// the zone is ambiguous (no domains + several zones), a domain matches none, or the domains span >1 zone.
export const selectZone = (zoneNames: readonly string[], domains: readonly string[]): string => {
    const [firstZone, ...restZones] = zoneNames;
    if (firstZone === undefined) {
        throw new Error("the Cloudflare API token can see no zones; mint a token scoped to the zone you deploy under");
    }
    if (domains.length === 0) {
        if (restZones.length > 0) {
            throw new Error(
                "no domains are declared and the API token can see multiple zones, so the zone is ambiguous; declare an app/service domain or use a zone-scoped token",
            );
        }
        return firstZone;
    }
    let resolved: string | undefined;
    for (const domain of domains) {
        const best = zoneNames.filter((name) => inZone(domain, name)).toSorted((a, b) => b.length - a.length)[0];
        if (best === undefined) {
            throw new Error(`domain "${domain}" is not under any zone the Cloudflare API token can access`);
        }
        if (resolved !== undefined && resolved !== best) {
            throw new Error(`intentic supports a single Cloudflare zone, but the declared domains span "${resolved}" and "${best}"`);
        }
        resolved = best;
    }
    if (resolved === undefined) {
        throw new Error("could not resolve a Cloudflare zone from the declared domains");
    }
    return resolved;
};
