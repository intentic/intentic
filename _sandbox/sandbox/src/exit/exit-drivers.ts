import type { ExitProvider } from "@intentic/sandbox-contract";
import type { ExitDriver } from "./exit-driver.js";
import { torDriver } from "./tor.js";
import { vpngateDriver } from "./vpngate.js";
import { wireguardExitDriver } from "./wireguard-exit.js";

// Every exit provider's driver. Total over ExitProvider, so a new arm on the contract's discriminated union is
// a compile error here until it has an implementation, the vpn subsystem's bet, and the capability registry's
// one level down.
export const exitDrivers: Record<ExitProvider, ExitDriver> = {
    tor: torDriver,
    vpngate: vpngateDriver,
    wireguard: wireguardExitDriver,
};
