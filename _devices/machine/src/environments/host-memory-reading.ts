import type { HostMemory } from "@intentic/sandbox-contract/schemas/hosts";
import { windowsMemory, withVmFigures } from "./windows-memory.js";
import { guestFreeMemory } from "./wsl-cache-drop.js";
import { wslVmMemory } from "./wsl-memory-watch.js";

/** The heartbeat's `memory` (DevicePingSchema): Windows' available and total memory, read now, with the WSL VM's
 *  footprint (wsl-memory-watch.ts) and the guest's free memory split at its reporting order (wsl-guest.ts) as last read,
 *  while fresh. Undefined anywhere but Windows' own side. */
export const hostMemoryReading = (now: number = Date.now()): HostMemory | undefined => withVmFigures(windowsMemory(), wslVmMemory(), guestFreeMemory(), now);
