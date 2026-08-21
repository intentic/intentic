import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import type { ExitConfig, IntenticLine, WireguardExitConfig } from "@intentic/sandbox-contract";
import { toolMissing } from "../vpn/net-probe.js";
import { isCountryCode, rankCountries } from "./exit-countries.js";
import type { ExitDriver, ExitProbe } from "./exit-driver.js";
import { observeThroughAddress } from "./exit-observe.js";
import { exitInterface, exitProxyPort, exitStateDir, wgConfPath } from "./exit-paths.js";
import { readSelection, writeSelection } from "./exit-state.js";
import { dropProxy, ensureProxy, proxyBound, tunnelAddress, tunnelResolver } from "./exit-tunnel.js";

/* BRING YOUR OWN EXITS: one or more WireGuard .conf files, pasted together, treated as a pool.
 *
 * This is the arm that makes the feature complete rather than free-only. Proton VPN's free tier hands out
 * .conf files for its five free countries; Mullvad hands out fifty; a self-hosted box hands out one. All three
 * arrive here as text and become the same thing: a list of exits with countries attached, switched under a
 * proxy port that never moves.
 *
 * It is also the only arm with no catalog to fetch, which makes AUTO-LABELLING the whole job. Nobody wants to
 * annotate five pasted files by hand, so the country is read out of what providers already write into them:
 * Proton labels its peers `# NL-FREE#1`, Mullvad and Proton both name their endpoint hosts `de-...`, and an
 * explicit `# country: DE` line always wins. Anything still unlabelled is resolved by dialling it once and
 * asking the internet, then remembered.
 *
 * TWO LINES ARE STRIPPED FROM EVERY PASTED CONF, and both matter:
 *   `DNS  =` , wg-quick applies it by REWRITING /etc/resolv.conf for the whole container. An exit is supposed
 *              to be inert until something opts in; silently repointing every name lookup in the sandbox at a
 *              VPN provider's resolver is the opposite of that.
 *   `Table =` , replaced with `Table = off` so wg-quick installs no routes at all. Without it, AllowedIPs of
 *              0.0.0.0/0 becomes a default route in the MAIN table and the sandbox loses its own uplink.
 */

const exec = promisify(execFile);
const config = (raw: ExitConfig): WireguardExitConfig => raw as WireguardExitConfig;

export interface WireguardProfile {
    // What to call it in a picker and in `geo list`. The provider's own peer label when there is one.
    readonly name: string;
    readonly country?: string | undefined;
    readonly endpoint?: string | undefined;
    readonly conf: string;
}

/* Country, in the order a label is most likely to be right, and each rule kept DELIBERATELY NARROW, because a
 * wrong label is worse than no label: an unlabelled conf is simply eligible for any country and gets resolved
 * by dialling it, while a mislabelled one produces a confusing "asked for MY, came out in DE" failure.
 *
 *   1. an explicit `# country: DE`, which a user can always add and which nothing else may override;
 *   2. an UPPERCASE country code opening a comment, which is exactly Proton's `# NL-FREE#1`. Uppercase is the
 *      whole guard here: without it `# my-server-1` reads as Malaysia and `# in-progress` as India;
 *   3. a relay-style endpoint hostname, `de-ber-wg-001.relays.mullvad.net`. At least three dash-separated
 *      parts before the first dot, or `my-vpn.example.com` becomes Malaysia by the same accident.
 *
 * A guess from the endpoint's IP address is not attempted at all: dialling it and observing the answer is both
 * cheaper to get right and already implemented. */
const ISO_PREFIX = /^([A-Za-z]{2})[-_# ]/;

export const countryOfConf = (conf: string): string | undefined => {
    const explicit = /^\s*#\s*country\s*[:=]\s*([A-Za-z]{2})\s*$/im.exec(conf)?.[1];
    if (explicit !== undefined && isCountryCode(explicit)) {
        return explicit.toUpperCase();
    }
    for (const line of conf.split("\n")) {
        const comment = /^\s*#\s*(.+)$/.exec(line)?.[1];
        const code = comment === undefined ? undefined : /^([A-Z]{2})[-_# ]/.exec(comment)?.[1];
        if (code !== undefined && isCountryCode(code)) {
            return code;
        }
    }
    const host = /^\s*Endpoint\s*=\s*\[?([^\]:]+)\]?:\d+/im.exec(conf)?.[1];
    const label = host === undefined || /^[\d.]+$/.test(host) ? undefined : host.split(".")[0];
    if (label === undefined || label.split("-").length < 3) {
        return undefined;
    }
    const fromHost = ISO_PREFIX.exec(`${label}-`)?.[1];
    return fromHost !== undefined && isCountryCode(fromHost) ? fromHost.toUpperCase() : undefined;
};

export const endpointOfConf = (conf: string): string | undefined => /^\s*Endpoint\s*=\s*(\S+)/im.exec(conf)?.[1];

/* Split the pasted blob into individual configs. `[Interface]` starts each one, which is true of every
 * WireGuard config there is (wg-quick requires it), so the split needs no separator convention of its own and
 * a user can paste files back to back with no editing at all. */
export const parseWireguardConfigs = (blob: string): WireguardProfile[] => {
    const chunks = blob
        .split(/^(?=\s*\[Interface\])/im)
        .map((chunk) => chunk.trim())
        .filter((chunk) => chunk !== "" && /\[Interface\]/i.test(chunk));
    const profiles: WireguardProfile[] = [];
    for (const [index, conf] of chunks.entries()) {
        const country = countryOfConf(conf);
        const endpoint = endpointOfConf(conf);
        profiles.push({
            name: country === undefined ? `exit-${index + 1}` : `${country}-${index + 1}`,
            country,
            endpoint,
            conf,
        });
    }
    return profiles;
};

// The pasted conf, made safe to bring up: no pushed DNS, no routes. See the header for why both matter.
export const neutralisedConf = (conf: string): string => {
    const lines = conf
        .split("\n")
        .filter((line) => !/^\s*DNS\s*=/i.test(line))
        .filter((line) => !/^\s*Table\s*=/i.test(line));
    const interfaceAt = lines.findIndex((line) => /^\s*\[Interface\]/i.test(line));
    const injected = [...lines];
    injected.splice(interfaceAt + 1, 0, "Table = off");
    return `${injected.join("\n").trimEnd()}\n`;
};

const profiles = (raw: ExitConfig): WireguardProfile[] => parseWireguardConfigs(config(raw).config);

// Which conf to bring up: the first in the wanted country that isn't the one already up. An unlabelled conf is
// eligible for any country, because the whole reason it is unlabelled is that nobody knows where it comes out
// yet and dialling it is how that gets answered.
const pick = (all: readonly WireguardProfile[], country: string | undefined, avoid: string | undefined): WireguardProfile | undefined => {
    const eligible = all.filter((profile) => country === undefined || profile.country === country.toUpperCase() || profile.country === undefined);
    return eligible.find((profile) => profile.name !== avoid) ?? eligible[0];
};

const tunnelUp = async (name: string): Promise<boolean> =>
    exec("wg", ["show", name]).then(
        () => true,
        () => false,
    );

const down = async (id: string): Promise<void> => {
    await exec("wg-quick", ["down", wgConfPath(id)]).catch(() => undefined);
};

async function* bring(id: string, profile: WireguardProfile): AsyncGenerator<IntenticLine> {
    await down(id);
    await dropProxy(id);
    await mkdir(exitStateDir(id), { recursive: true, mode: 0o700 });
    // The conf holds a private key; never group- or world-readable, and only the PATH ever reaches a command
    // line, so no key appears in argv or in `ps`.
    await writeFile(wgConfPath(id), neutralisedConf(profile.conf), { mode: 0o600 });
    yield { kind: "log", message: `Bringing up ${profile.name}${profile.endpoint === undefined ? "" : ` (${profile.endpoint})`}…` };
    await exec("wg-quick", ["up", wgConfPath(id)]);
    const address = await ensureProxy(id);
    await writeSelection(id, { ...(profile.country === undefined ? {} : { country: profile.country }), server: profile.name });
    yield { kind: "log", message: `Tunnel up on ${exitInterface(id)} (${address}). SOCKS proxy on 127.0.0.1:${exitProxyPort(id)}.` };
}

export const wireguardExitDriver: ExitDriver = {
    // The catalog IS the pasted confs; there is nothing to fetch, so it is always live. Unlabelled confs are
    // counted under a separate bucket rather than dropped, so a user can see that four of their five pasted
    // files were recognised and one was not.
    catalog: async (_id, raw) => {
        const counts = new Map<string, number>();
        for (const profile of profiles(raw)) {
            if (profile.country !== undefined) {
                counts.set(profile.country, (counts.get(profile.country) ?? 0) + 1);
            }
        }
        return { countries: rankCountries(counts), live: true };
    },
    write: async (id) => {
        await mkdir(exitStateDir(id), { recursive: true, mode: 0o700 });
    },
    erase: async (id) => {
        await rm(exitStateDir(id), { recursive: true, force: true });
    },
    missingTool: async () => ((await toolMissing("wg-quick", ["--help"])) ? "wg-quick" : undefined),
    start: async function* (id, raw, country): AsyncGenerator<IntenticLine> {
        const wanted = country ?? raw.country;
        const all = profiles(raw);
        if (all.length === 0) {
            throw new Error("This exit has no WireGuard configuration in it. Paste at least one .conf file into its capability.");
        }
        const profile = pick(all, wanted, undefined);
        if (profile === undefined) {
            const have = [...new Set(all.flatMap((entry) => (entry.country === undefined ? [] : [entry.country])))].toSorted().join(", ");
            throw new Error(
                `None of the pasted configurations is in ${wanted}. They cover: ${have === "" ? "no country this could read" : have}. Paste that country's .conf from your provider, or add a "# country: ${wanted}" line to the right one.`,
            );
        }
        yield* bring(id, profile);
    },
    rotate: async function* (id, raw): AsyncGenerator<IntenticLine> {
        const previous = await readSelection(id);
        const all = profiles(raw);
        const country = previous?.country ?? raw.country;
        const profile = pick(all, country, previous?.server);
        if (profile === undefined || profile.name === previous?.server) {
            throw new Error(
                `Only one pasted configuration covers ${country ?? "this pool"}, so there is no second address to rotate to. Paste another .conf for that country from your provider.`,
            );
        }
        yield* bring(id, profile);
    },
    stop: async (id) => {
        await down(id);
        await dropProxy(id);
    },
    probe: async (id): Promise<ExitProbe> => {
        const name = exitInterface(id);
        if (!(await tunnelUp(name))) {
            return (await toolMissing("wg-quick", ["--help"])) ? { state: "unavailable" } : { state: "down" };
        }
        if ((await tunnelAddress(id)) === undefined) {
            return { state: "starting", interface: name };
        }
        return proxyBound(id) ? { state: "up", interface: name } : { state: "starting", interface: name, detail: "re-publishing the proxy" };
    },
    observe: async (id) => {
        const address = await tunnelAddress(id);
        if (address === undefined) {
            throw new Error(`${id} has no tunnel address, so there is nothing to check.`);
        }
        return await observeThroughAddress(address, tunnelResolver(address));
    },
};
