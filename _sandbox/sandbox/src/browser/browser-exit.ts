import type { BrowserConfig, Capability, ExitConfig, IdentityConfig } from "@intentic/sandbox-contract";
import { countryLocale } from "../exit/exit-countries.js";
import type { FingerprintPlace } from "./fingerprint.js";
import { exitLink, proxyUrl, startExit } from "../exit/exit-links.js";

/* BINDING A BROWSER PROFILE TO A COUNTRY, which is the form this feature actually gets used in. Nobody
 * proxies a browser by hand for long; what they want is "this account lives in Berlin", set once.
 *
 * THE UNIT IS THE PROFILE, NOT THE ACCOUNT, and that is the whole design decision here. session-store.ts's
 * profileOwner already decides what an account's browser IS: an identity-born account shares its identity's
 * Chromium profile, cookies, passkeys and all, while a standalone account owns its own. Everything that
 * carries identity resolves through that function, and where the browser appears to be is exactly such a
 * thing. So an account inside an identity takes the identity's exit and its own `exit` field is ignored.
 *
 * Letting an account override its identity would let one Google session appear from two countries at once,
 * which is a far louder signal than any address: sites do not flag "datacenter IP" nearly as hard as they flag
 * "this logged-in session teleported". Making that unexpressible is worth more than the flexibility it costs.
 *
 * AND THE ADDRESS IS ONLY HALF OF IT. A German address on a browser whose clock says New York and whose only
 * accepted language is en-US is more conspicuous than one that never moved, because no real visitor looks like
 * that. That half is fingerprint.ts's job, not this module's: it already owns the rule that the clock follows
 * the EGRESS, and a bound profile is simply a profile whose egress is not the sandbox's. So this returns the
 * `place` that module takes, derived from the OBSERVED country rather than the requested one, since the
 * observed one is what the site will see. Everything else about the device, the GPU, the cores, the memory,
 * stays drawn from the seed: the same machine, sitting somewhere else.
 */

// Everything a Chromium launch needs to be consistently somewhere else: where to send the traffic, and the
// place the fingerprint should claim while it is going there.
export interface ProfileExit {
    readonly exitId: string;
    // socks5://127.0.0.1:<port>. Stable across country switches by construction (exit-paths.ts), so a profile
    // bound to an exit does not need relaunching when the exit moves.
    readonly proxy: string;
    readonly country: string | undefined;
    readonly place: FingerprintPlace;
}

// Which exit a profile owner is bound to. An identity's own field, or a standalone account's; never an
// identity-born account's, for the reason in the header.
export const boundExitId = (capabilities: readonly Capability[], owner: string): string | undefined => {
    const capability = capabilities.find((candidate) => candidate.id === owner);
    if (capability === undefined) {
        return undefined;
    }
    if (capability.kind === "identity") {
        return (capability.config as IdentityConfig).exit;
    }
    if (capability.kind === "browser") {
        const config = capability.config as BrowserConfig;
        // Belt and braces: profileOwner already returns the identity for such an account, so `owner` would not
        // be this entry's id. Kept because the invariant is worth stating where it is relied on.
        return config.identity === undefined ? config.exit : undefined;
    }
    return undefined;
};

/* Resolve a profile's exit and make sure it is actually up, because the failure mode of not doing so is the
 * worst one available: a browser bound to a stopped exit would open perfectly happily from this sandbox's own
 * address, under an account whose whole point was that it appears to be somewhere else.
 *
 * So a down exit is STARTED here, and a start that fails is a hard `undefined` with a reason the caller must
 * surface as a refusal rather than a warning. There is no degraded mode: "open it anyway from the real
 * address" is precisely what must not happen.
 */
export const resolveProfileExit = async (
    capabilities: readonly Capability[],
    owner: string,
): Promise<{ exit: ProfileExit } | { refusal: string } | undefined> => {
    const exitId = boundExitId(capabilities, owner);
    if (exitId === undefined) {
        return undefined;
    }
    const entry = capabilities.find((candidate) => candidate.id === exitId && candidate.kind === "exit");
    if (entry === undefined || entry.kind !== "exit") {
        return {
            refusal: `${owner} is set to browse through the exit "${exitId}", which no longer exists. Point it at an existing exit, or clear the field, before using this browser.`,
        };
    }
    const exitEntry = { id: entry.id, config: entry.config as ExitConfig };
    let link = await exitLink(exitEntry);
    if (link.state !== "up") {
        try {
            for await (const line of startExit(exitEntry, link.country)) {
                void line;
            }
        } catch (error) {
            return {
                refusal: `${owner} browses through the exit "${exitId}", which could not be brought up, so this browser was not opened: opening it would have connected from this sandbox's own address instead. ${error instanceof Error ? error.message : String(error)}`,
            };
        }
        link = await exitLink(exitEntry);
    }
    if (link.state !== "up") {
        return {
            refusal: `${owner} browses through the exit "${exitId}", which is ${link.state}${link.detail === undefined ? "" : ` (${link.detail})`}. Not opening the browser from this sandbox's own address instead.`,
        };
    }
    // The OBSERVED country dresses the browser, not the requested one: a site sees where traffic actually
    // comes from, and the two only differ when something is wrong, in which case matching the observation is
    // still the more consistent of the two lies.
    const country = link.observedCountry ?? link.country;
    const dressing = countryLocale(country ?? "US");
    return {
        exit: {
            exitId,
            proxy: proxyUrl(exitId),
            country,
            place: { locale: dressing.locale, timezoneId: dressing.timezone, languages: dressing.languages },
        },
    };
};
