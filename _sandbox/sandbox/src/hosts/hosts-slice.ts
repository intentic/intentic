import type { Capability } from "@intentic/sandbox-contract";
import type { Pairings } from "../peers/enrollment.js";
import type { SyncFleet, SyncMode } from "./desktop-sync.js";
import type { HostHub, HostStore } from "./host-peer.js";
import type { HostDeviceReach } from "./self-host.js";

// The owner's computers: the device door, its hub and reach, and desktop sync's pairings and fleet.
export interface HostsSlice {
    // The user's own computers as a peer door: durable enrollment plus who is holding a socket right now.
    readonly hosts: HostStore;
    readonly hostHub: HostHub;
    // Which of those computers a turn may act on, and which one runs this sandbox: composed here rather than reached
    // for, so a turn's prompt says "run it there" without the agent importing the hosts subsystem.
    readonly hostReach: (granted: readonly Capability[]) => Promise<HostDeviceReach | undefined>;
    // The desktop-sync enrollments, for the same reason and in the same shape: the devices view merges them with host
    // pulls without the hosts subsystem importing the platform's sync store.
    readonly syncFleet: () => Promise<SyncFleet>;
    // Desktop sync's pairing; only the pairing lives here, its SSH-keyed enrollment half stays in hosts/desktop-sync.ts.
    readonly syncPairings: Pairings<SyncMode>;
}
