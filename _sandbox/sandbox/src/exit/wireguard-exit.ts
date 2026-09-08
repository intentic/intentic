import { mkdir, rm } from "node:fs/promises";
import type { ExitConfig, IntenticLine, WireguardExitConfig } from "@intentic/sandbox-contract";
import { wireguardDial, wireguardDrop, wireguardEndpoint, wireguardMissing, wireguardUp, writeWireguardConf } from "../tunnel/wireguard-tools.js";
import { isCountryCode, rankCountries } from "./exit-countries.js";
import type { ExitDriver, ExitProbe } from "./exit-driver.js";
import { observeThroughAddress } from "./exit-observe.js";
import { exitInterface, exitProxyPort, exitStateDir, wgConfPath } from "./exit-paths.js";
import { readSelection, writeSelection } from "./exit-state.js";
import { dropProxy, ensureProxy, proxyBound, tunnelAddress, tunnelResolver } from "./exit-tunnel.js";

// One or more pasted WireGuard .conf files treated as a pool; Proton, Mullvad or a self-hosted box all arrive as text
// and switch under one fixed proxy port.
// The only arm with no catalog to fetch, so auto-labelling is the whole job: peer label, hostname, or an explicit `#
// country: DE` line, else resolved by dialling once.
// Every pasted conf is stripped of DNS (would rewrite the whole container's resolver) and Table (replaced with `off`,
// or a pushed default route hijacks the main table).

const config = (raw: ExitConfig): WireguardExitConfig => raw as WireguardExitConfig;

export interface WireguardProfile {
    // What to call it in a picker and `geo list`; the provider's own peer label when there is one.
    readonly name: string;
    readonly country?: string | undefined;
    readonly endpoint?: string | undefined;
    readonly conf: string;
}

// Country, in order of how likely a label is right; each rule kept narrow, since a wrong label is worse than none.
//   1. an explicit `# country: DE` line, which always wins.
//   2. an uppercase country code opening a comment (Proton's `# NL-FREE#1`); the case is the guard, or `# my-server-1`
//      reads as Malaysia.
//   3. a relay-style endpoint hostname with 3+ dash-separated parts before the first dot, or `my-vpn.example.com` reads
//      as Malaysia too.
// No guess from the endpoint's IP: dialling and observing is cheaper to get right and already implemented.
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

// Splits on `[Interface]`, which every WireGuard config has (wg-quick requires it), so pasting files back to back needs
// no separator of its own.
export const parseWireguardConfigs = (blob: string): WireguardProfile[] => {
    const chunks = blob
        .split(/^(?=\s*\[Interface\])/im)
        .map((chunk) => chunk.trim())
        .filter((chunk) => chunk !== "" && /\[Interface\]/i.test(chunk));
    const profiles: WireguardProfile[] = [];
    for (const [index, conf] of chunks.entries()) {
        const country = countryOfConf(conf);
        const endpoint = wireguardEndpoint(conf);
        profiles.push({
            name: country === undefined ? `exit-${index + 1}` : `${country}-${index + 1}`,
            country,
            endpoint,
            conf,
        });
    }
    return profiles;
};

// Strips pushed DNS and routes so bringing up an arbitrary pasted conf can't rewrite the resolver or main table.
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

// The first conf in the wanted country not already up; an unlabelled conf is eligible for any country, since dialling
// it is how its country gets learned.
const pick = (all: readonly WireguardProfile[], country: string | undefined, avoid: string | undefined): WireguardProfile | undefined => {
    const eligible = all.filter((profile) => country === undefined || profile.country === country.toUpperCase() || profile.country === undefined);
    return eligible.find((profile) => profile.name !== avoid) ?? eligible[0];
};

async function* bring(id: string, profile: WireguardProfile): AsyncGenerator<IntenticLine> {
    await wireguardDrop(wgConfPath(id));
    await dropProxy(id);
    await writeWireguardConf(wgConfPath(id), neutralisedConf(profile.conf));
    yield { kind: "log", message: `Bringing up ${profile.name}${profile.endpoint === undefined ? "" : ` (${profile.endpoint})`}…` };
    await wireguardDial(wgConfPath(id));
    const address = await ensureProxy(id);
    await writeSelection(id, { ...(profile.country === undefined ? {} : { country: profile.country }), server: profile.name });
    yield { kind: "log", message: `Tunnel up on ${exitInterface(id)} (${address}). SOCKS proxy on 127.0.0.1:${exitProxyPort(id)}.` };
}

export const wireguardExitDriver: ExitDriver = {
    // The catalog is the pasted confs themselves, always live. Unlabelled ones count separately rather than get
    // dropped, so a user can see which pasted files weren't recognised.
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
    missingTool: wireguardMissing,
    async *start(id, raw, country): AsyncGenerator<IntenticLine> {
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
    async *rotate(id, raw): AsyncGenerator<IntenticLine> {
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
        await wireguardDrop(wgConfPath(id));
        await dropProxy(id);
    },
    probe: async (id): Promise<ExitProbe> => {
        const name = exitInterface(id);
        if (!(await wireguardUp(name))) {
            return (await wireguardMissing()) === undefined ? { state: "down" } : { state: "unavailable" };
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
