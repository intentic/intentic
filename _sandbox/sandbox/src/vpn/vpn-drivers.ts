import type { VpnProvider } from "@intentic/sandbox-contract";
import { fortinetDriver } from "./fortinet.js";
import { ipsecDriver } from "./ipsec.js";
import type { VpnDriver } from "./vpn-driver.js";
import { wireguardDriver } from "./wireguard.js";

// Every VPN protocol's driver. Total over VpnProvider, so a new arm on the contract's discriminated union is a
// compile error here until it has an implementation — the capability registry's bet, one level down.
export const vpnDrivers: Record<VpnProvider, VpnDriver> = {
    wireguard: wireguardDriver,
    fortinet: fortinetDriver,
    ipsec: ipsecDriver,
};
