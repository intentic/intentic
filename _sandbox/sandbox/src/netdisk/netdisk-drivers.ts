import type { NetdiskProvider } from "@intentic/sandbox-contract";
import type { NetdiskDriver } from "./netdisk-driver.js";
import { smbDriver } from "./smb.js";

// Every share protocol's driver. Total over NetdiskProvider, so a new arm on the contract's discriminated union is a
// compile error here until it has an implementation.
export const netdiskDrivers: Record<NetdiskProvider, NetdiskDriver> = {
    smb: smbDriver,
};
