import type { BrowserConfig, Capability, ExitConfig, IdentityConfig } from "@intentic/sandbox-contract";
import { countryLocale } from "../../exit/exit-countries.js";
import type { FingerprintPlace } from "./fingerprint.js";
import { exitLink, proxyUrl, startExitOnce } from "../../exit/exit-links.js";

// Binds a browser profile to a country: the unit is the profile, not the account, so an identity-born account takes its
// identity's exit, never its own field, since overriding it would let one session appear from two countries. Returns
// the `place` from the exit's observed country, not the requested one, since that's what the site sees.

// Everything a Chromium launch needs to be consistently elsewhere: where to send traffic, and the claimed spot.
export interface ProfileExit {
    readonly exitId: string;
    // socks5://127.0.0.1:<port>, stable across country switches, so a bound profile never needs relaunching.
    readonly proxy: string;
    readonly country: string | undefined;
    readonly place: FingerprintPlace;
}

// Which exit an owner is bound to: an identity's field, a standalone account's, never an identity-born one's.
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
        // Belt and braces: profileOwner already returns the identity for such an account, so `owner` isn't this id.
        return config.identity === undefined ? config.exit : undefined;
    }
    return undefined;
};

// A down exit is started here; a failure is a refusal to surface, never a fallback to this sandbox's address. The
// outcome is tagged (ok, failed, timedOut), so a timeout isn't confused with a thrown falsy value.
type StartOutcome = { ok: true } | { failed: unknown } | { timedOut: true };

export const resolveProfileExit = async (
    capabilities: readonly Capability[],
    owner: string,
    budgetMs?: number | undefined,
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
        // Shared with any start already in flight, so two owners bound to one exit dial it once between them.
        const start = startExitOnce(exitEntry, link.country);
        // Tagged rather than boolean|unknown, since a driver rejecting with `false` must not be misread as a timeout;
        // the unbudgeted case is just a one-element race.
        const settled = await Promise.race<StartOutcome>([
            start.then<StartOutcome, StartOutcome>(
                () => ({ ok: true }),
                (failed: unknown) => ({ failed }),
            ),
            // unref'd: a start nobody is waiting on any more must not hold the process open by itself.
            ...(budgetMs === undefined
                ? []
                : [new Promise<StartOutcome>((resolve) => setTimeout(() => resolve({ timedOut: true }), budgetMs).unref())]),
        ]);
        if ("timedOut" in settled) {
            return {
                refusal: `${owner} browses through the exit "${exitId}", which is still coming up. It was not opened from this sandbox's own address instead, so try again once the exit reports up.`,
            };
        }
        if ("failed" in settled) {
            return {
                refusal: `${owner} browses through the exit "${exitId}", which could not be brought up, so this browser was not opened: opening it would have connected from this sandbox's own address instead. ${settled.failed instanceof Error ? settled.failed.message : String(settled.failed)}`,
            };
        }
        link = await exitLink(exitEntry);
    }
    if (link.state !== "up") {
        return {
            refusal: `${owner} browses through the exit "${exitId}", which is ${link.state}${link.detail === undefined ? "" : ` (${link.detail})`}. Not opening the browser from this sandbox's own address instead.`,
        };
    }
    // Observed country dresses the browser, not the requested one, since a site sees where traffic comes from.
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
