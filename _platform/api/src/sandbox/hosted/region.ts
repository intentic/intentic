// EEA users' sandboxes are provisioned in an EEA region, decided from Cloudflare's `cf-ipcountry` header; only the
// resulting region is stored, never the country. A missing or `XX` header falls back to the default region, not Europe:
// it means no Cloudflare in front (self-hosting), not a European caller.

// Countries mapped to the EEA region: the EU27, rest of the EEA, plus UK and Switzerland.
const EUROPEAN = new Set([
    `AT`,
    `BE`,
    `BG`,
    `HR`,
    `CY`,
    `CZ`,
    `DK`,
    `EE`,
    `FI`,
    `FR`,
    `DE`,
    `GR`,
    `HU`,
    `IE`,
    `IT`,
    `LV`,
    `LT`,
    `LU`,
    `MT`,
    `NL`,
    `PL`,
    `PT`,
    `RO`,
    `SK`,
    `SI`,
    `ES`,
    `SE`,
    `IS`,
    `LI`,
    `NO`,
    `GB`,
    `CH`,
]);

// Cloudflare's country for the request, uppercased; `XX` (unknown, e.g. Tor) is treated the same as an absent header.
export const callerIsEuropean = (headers: Headers): boolean => {
    const country = headers.get(`cf-ipcountry`)?.trim().toUpperCase();
    return country !== undefined && EUROPEAN.has(country);
};

export const hostedRegionFor = (config: { region: string; regionEu: string }, headers: Headers): string =>
    callerIsEuropean(headers) ? config.regionEu : config.region;
