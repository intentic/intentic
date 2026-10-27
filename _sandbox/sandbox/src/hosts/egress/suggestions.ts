import type { Capability } from "@intentic/sandbox-contract/schemas/capabilities";
import { EGRESS_HOST, EGRESS_PRIVATE_V4, type EgressAllow, egressDestinationKind } from "@intentic/sandbox-contract/schemas/egress";
import type { Services } from "../../composition.js";
import { opt } from "../../opt.js";
import { vpnDrivers } from "../../vpn/vpn-drivers.js";

/* THE EXCEPTIONS THIS SANDBOX'S OWN CARDS NEED (2026-10-27).

Under `internet-only` a card that dials into the owner's own network stops working: an SSH host on the LAN, a network
disk on a NAS, a VPN gateway inside the office. Each such card yields one suggested exception, named after it (`from`),
which the Devices view offers beside the fence with an Allow that pre-fills it. Only a destination that is private
by its own spelling is suggested: an address in a private range, a name that only a local resolver answers
(`nas.lan`, a single label), or the machine itself. A public name needs no exception, since the internet stays open;
one a split DNS resolves to a private address is not knowable here, and is what the fence's blocked list then shows. */

// Names Docker and Podman give the machine a container runs on: that is the fence's own `host` word.
const HOST_NAMES: ReadonlySet<string> = new Set(["host.docker.internal", "gateway.docker.internal", "host.containers.internal", "localhost"]);
// Suffixes no public resolver answers.
const LOCAL_SUFFIXES = [".local", ".lan", ".home", ".internal", ".home.arpa", ".localdomain", ".intranet", ".corp", ".private"];

const v4Number = (address: string): number => address.split(".").reduce((sum, part) => sum * 256 + Number(part), 0);

const inV4Prefix = (address: string, cidr: string): boolean => {
    const [base = "", bits = "32"] = cidr.split("/");
    const size = 2 ** (32 - Number(bits));
    return Math.floor(v4Number(address) / size) === Math.floor(v4Number(base) / size);
};

// Whether a destination (an address, a prefix's base, a name) is somewhere `internet-only` refuses; the word to allow
// it under, or undefined for a destination that needs no exception.
export const privateDestination = (raw: string): string | undefined => {
    const to = raw.trim().toLowerCase().replace(/\.$/u, "");
    if (HOST_NAMES.has(to)) {
        return EGRESS_HOST;
    }
    const kind = egressDestinationKind(to);
    if (kind === "v4") {
        const address = to.split("/")[0] ?? to;
        return EGRESS_PRIVATE_V4.some((cidr) => inV4Prefix(address, cidr)) ? to : undefined;
    }
    if (kind === "v6") {
        // Unique-local, link-local, site-local and loopback: what a LAN or a VPN hands out.
        return /^(?:f[cd][0-9a-f]{0,2}:|fe[89ab][0-9a-f]?:|fe[cdef][0-9a-f]?:|::1(?:\/|$))/u.test(to) ? to : undefined;
    }
    if (kind === "name") {
        return !to.includes(".") || LOCAL_SUFFIXES.some((suffix) => to.endsWith(suffix)) ? to : undefined;
    }
    return undefined;
};

export interface HostPort {
    readonly host: string;
    readonly port: number | undefined;
}

// `host:port`, `[v6]:port` or a bare host, as gateways and endpoints are written.
export const splitHostPort = (value: string): HostPort => {
    const bracketed = /^\[([^\]]+)\](?::(\d+))?$/u.exec(value);
    if (bracketed !== null) {
        return { host: bracketed[1] ?? value, port: bracketed[2] === undefined ? undefined : Number(bracketed[2]) };
    }
    const colons = value.split(":").length - 1;
    const match = colons === 1 ? /^(.+):(\d+)$/u.exec(value) : null;
    return match === null ? { host: value, port: undefined } : { host: match[1] ?? value, port: Number(match[2]) };
};

const suggestion = (
    host: string,
    ports: readonly number[],
    protocol: "tcp" | "udp" | undefined,
    from: string,
    note: string,
): EgressAllow | undefined => {
    const to = privateDestination(host);
    if (to === undefined) {
        return undefined;
    }
    const valid = ports.filter((port) => Number.isInteger(port) && port >= 1 && port <= 65535);
    return { to, ...opt("ports", valid.length === 0 ? undefined : valid), ...opt("protocol", protocol), from, note };
};

// What a VPN gateway is dialled over: WireGuard is UDP to its endpoint, IPsec UDP 500 and 4500 (NAT traversal), a
// Fortinet SSL VPN TCP to its HTTPS port.
const vpnSuggestion = (card: Extract<Capability, { kind: "vpn" }>): EgressAllow | undefined => {
    const gateway = vpnDrivers[card.config.provider].gateway(card.config);
    if (gateway === undefined) {
        return undefined;
    }
    const { host, port } = splitHostPort(gateway);
    const note = `VPN gateway (${card.id})`;
    switch (card.config.provider) {
        case "wireguard":
            return suggestion(host, port === undefined ? [] : [port], "udp", card.id, note);
        case "ipsec":
            return suggestion(host, [500, 4500], "udp", card.id, note);
        default:
            return suggestion(host, port === undefined ? [443] : [port], "tcp", card.id, note);
    }
};

// One suggestion per card that points somewhere the fence refuses, in the order the cards are listed.
export const egressSuggestionsOf = (cards: readonly Capability[]): EgressAllow[] =>
    cards.flatMap((card): EgressAllow[] => {
        let found: EgressAllow | undefined;
        if (card.kind === "ssh") {
            found = suggestion(card.config.host, [card.config.port], "tcp", card.id, `SSH host (${card.id})`);
        } else if (card.kind === "netdisk") {
            found = suggestion(card.config.server, [445], "tcp", card.id, `Network disk (${card.id})`);
        } else if (card.kind === "vpn") {
            found = vpnSuggestion(card);
        }
        return found === undefined ? [] : [found];
    });

export const egressSuggestions = async (services: Pick<Services, "capabilities">): Promise<EgressAllow[]> =>
    egressSuggestionsOf(await services.capabilities.list());
