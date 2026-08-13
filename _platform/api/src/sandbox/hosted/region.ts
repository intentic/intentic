/* WHERE A HOSTED MACHINE LANDS, and the one rule that decides it.
 *
 * This is a published privacy commitment expressed as code: a European user's sandbox — their repositories,
 * their working files, whatever secrets they put in the box — is created in an EEA region and never crosses
 * to the US default. The privacy policy states it in those words, so the pick belongs somewhere a reader can
 * check it against the sentence, not inline in a provisioning call.
 *
 * The signal is Cloudflare's `cf-ipcountry` on the provisioning request, which is the only country the
 * platform ever learns and which it does not store: the machine's region is recorded, the country that chose
 * it is not. That is deliberate — the region is the fact the user is owed, and the IP-derived country behind
 * it is one more piece of personal data with no reason to persist.
 *
 * UNKNOWN FALLS BACK TO THE DEFAULT, not to Europe. A missing or `XX` header means the platform is running
 * without Cloudflare in front of it (self-hosters do), and quietly treating "I could not tell" as "European"
 * would put every self-hosted platform's machines in Stockholm for a reason nobody could see. The users this
 * promise is for reach a Cloudflare-fronted intentic.dev, where the header is always present. */

// The countries whose users get the EEA region: the EU 27, the rest of the EEA, plus the UK and Switzerland —
// jurisdictions whose users hold the same expectation and whose data protection law says the same thing.
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

// Cloudflare's country for the request, uppercased. `XX` is its own "unknown" (Tor, and anything it cannot
// place), and it means the same thing here as an absent header.
export const callerIsEuropean = (headers: Headers): boolean => {
    const country = headers.get(`cf-ipcountry`)?.trim().toUpperCase();
    return country !== undefined && EUROPEAN.has(country);
};

// The Fly region a machine provisioned for this caller lands in.
export const hostedRegionFor = (config: { region: string; regionEu: string }, headers: Headers): string =>
    callerIsEuropean(headers) ? config.regionEu : config.region;
