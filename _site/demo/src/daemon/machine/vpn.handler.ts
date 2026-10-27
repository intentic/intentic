import { connectVpn, dropLink, importForticlient, vpnLinks } from "./liveLinks";
import type { Doors } from "../doors";

// The sandbox's tunnels, one per VPN connection on the Capabilities page (daemon/liveLinks.ts): dialled with the
// client's progress streamed, dropped, and an exported FortiClient file read into connections to add.
export const vpnDoors = {
    list: () => ({ links: vpnLinks() }),
    connect: ({ id }) => connectVpn(id),
    disconnect: ({ id }) => dropLink(`vpn`, id),
    importForticlient: ({ xml }) => ({ connections: importForticlient(xml) }),
} satisfies Doors<`vpn`>;
