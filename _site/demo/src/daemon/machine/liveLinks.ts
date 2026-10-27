import type { ForticlientConnection, VpnLink } from "@intentic/sandbox-contract/schemas/vpn";
import type { NetdiskLink } from "@intentic/sandbox-contract/schemas/netdisk";
import type { IntenticLine } from "@intentic/sandbox-contract/events/system-events";
import type { CapabilitySummary } from "@intentic/sandbox-contract/schemas/capabilities";
import type { SandboxHandlerOutput } from "@intentic/sandbox-contract/protocol/procedure-types";
import { type Frames, refuse } from "@intentic/contract-serve";
import { demoCapabilities } from "../../fixture/sandbox";
import { pacedLines } from "./machineKit";

// Tunnels and network disks (the daemon's vpn/ and netdisk/): one per connection of that kind on the Capabilities
// page, with the live state the operating system would report. Dialling and mounting stream the client's own progress
// at a dial's pace and leave the link up for the next read; dropping it takes it down.

const STEP_MS = 650;

// What is up right now, by connection id, and since when.
const up = new Map<string, number>();

const configured = (kind: string): CapabilitySummary[] => demoCapabilities().filter((capability) => capability.kind === kind);

const setting = (capability: CapabilitySummary, key: string): string | undefined => {
    const value = capability.config[key];
    return value === undefined ? undefined : String(value);
};

const vpnLink = (capability: CapabilitySummary): VpnLink => {
    const provider = setting(capability, `provider`) === `wireguard` ? `wireguard` : setting(capability, `provider`) === `ipsec` ? `ipsec` : `fortinet`;
    const since = up.get(capability.id);
    return {
        id: capability.id,
        provider,
        state: since === undefined ? `disconnected` : `connected`,
        gateway: setting(capability, `server`) ?? `vpn.acme.dev`,
        interface: since === undefined ? undefined : provider === `wireguard` ? `wg0` : `ppp0`,
        address: since === undefined ? undefined : `10.212.134.27`,
        routes: since === undefined ? [] : [`10.20.0.0/16`, `192.168.40.0/24`],
        dns: since === undefined ? [] : [`10.20.0.2`],
        since,
        autoConnect: setting(capability, `autoConnect`) !== `off`,
    };
};

const netdiskLink = (capability: CapabilitySummary): NetdiskLink => {
    const since = up.get(capability.id);
    const access = setting(capability, `access`) === `readwrite` ? `readwrite` : `read`;
    return {
        id: capability.id,
        provider: `smb`,
        state: since === undefined ? `unmounted` : `mounted`,
        target: `//${setting(capability, `server`) ?? `nas.acme.internal`}/${setting(capability, `share`) ?? `shared`}`,
        mountPoint: `/mnt/netdisk/${capability.id}`,
        access,
        writable: since === undefined ? undefined : access === `readwrite`,
        since,
        autoMount: setting(capability, `autoMount`) !== `off`,
    };
};

export const vpnLinks = (): VpnLink[] => configured(`vpn`).map(vpnLink);
export const netdiskLinks = (): NetdiskLink[] => configured(`netdisk`).map(netdiskLink);

const known = (kind: string, id: string): CapabilitySummary =>
    configured(kind).find((capability) => capability.id === id) ?? refuse(`no ${kind === `vpn` ? `VPN` : `network disk`} called ${id}`, 404);

/** Dials a stored tunnel, narrated as openfortivpn or wg-quick narrate it; one already up just says so. */
export const connectVpn = (id: string): Frames<IntenticLine> => {
    const link = vpnLink(known(`vpn`, id));
    if (link.state === `connected`) {
        return pacedLines([{ kind: `result`, message: `${id} is already connected (${link.address}).` }], STEP_MS);
    }
    return pacedLines(
        [
            { message: `Connecting to ${link.gateway}:443…` },
            { message: `Gateway certificate matches the trusted digest.` },
            { message: `Authenticated; tunnel is up on ppp0.` },
            { message: `Routes added: 10.20.0.0/16, 192.168.40.0/24. DNS: 10.20.0.2.` },
            { kind: `result`, message: `${id} is connected as 10.212.134.27.`, after: () => up.set(id, Date.now()) },
        ],
        STEP_MS,
    );
};

/** Mounts a stored disk at its place under /mnt/netdisk; one already mounted just says so. */
export const mountNetdisk = (id: string): Frames<IntenticLine> => {
    const link = netdiskLink(known(`netdisk`, id));
    if (link.state === `mounted`) {
        return pacedLines([{ kind: `result`, message: `${link.target} is already mounted at ${link.mountPoint}.` }], STEP_MS);
    }
    return pacedLines(
        [
            { message: `Resolving ${link.target.split(`/`)[2] ?? ``}…` },
            { message: `Negotiated SMB 3.1.1 with signing.` },
            { kind: `result`, message: `Mounted ${link.target} at ${link.mountPoint}${link.access === `read` ? `, read-only` : ``}.`, after: () => up.set(id, Date.now()) },
        ],
        STEP_MS,
    );
};

/** Takes a link down; one already down is fine, the promise is that it is not up afterwards. */
export const dropLink = (kind: `vpn` | `netdisk`, id: string): SandboxHandlerOutput<`vpn`, `disconnect`> => {
    known(kind, id);
    up.delete(id);
    return { ok: true };
};

/** The connections an exported FortiClient file holds, read and thrown away; the password never survives the export. */
export const importForticlient = (xml: string): ForticlientConnection[] =>
    [...xml.matchAll(/<connection>([\s\S]*?)<\/connection>/g)].map((match, index) => {
        const block = match[1] ?? ``;
        const field = (name: string): string | undefined => new RegExp(`<${name}>([^<]*)</${name}>`).exec(block)?.[1]?.trim();
        const label = field(`name`) ?? `Connection ${index + 1}`;
        const [server = `vpn.example.com`, port = `443`] = (field(`server`) ?? ``).split(`:`);
        return {
            id: label.toLowerCase().replace(/[^a-z0-9]+/g, `-`).replace(/^-|-$/g, ``),
            label,
            provider: `fortinet` as const,
            server,
            port: Number(port) || 443,
            username: field(`username`)?.startsWith(`Enc`) === false ? field(`username`) : undefined,
            description: field(`description`),
            needs: [`password`],
        };
    });
