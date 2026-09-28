import type { Device } from "@intentic/sandbox-contract";
import { sandboxRpc } from "../client/sandboxRpc";
import { type AcrossRecord, createAcrossStore } from "./acrossSandboxes";

// The machines every other sandbox of this owner can reach, read only while the recovery panel is up: when the active
// sandbox has gone quiet, a sibling connected to the same machine can roll it back or start it from its own Devices page.
// Polling rules are the across store's (acrossSandboxes.ts); every read is a background one, so a sessionless box never
// raises a sign-in for a question nobody asked it directly.

const POLL_MS = 60_000;
const FRESH_MS = 30_000;

export interface BoxDevices extends AcrossRecord {
    readonly devices: readonly Device[];
}

const store = createAcrossStore<BoxDevices>({
    pollMs: POLL_MS,
    freshMs: FRESH_MS,
    blank: (sandbox) => ({ sandbox, devices: [], readAt: undefined }),
    // A box that stopped answering keeps what it said last: the machines it could reach a minute ago are still the best
    // guess, and an empty list would read as "none".
    unreachable: (previous) => ({ devices: previous?.devices ?? [] }),
    // Only the owner's own sandboxes manage the owner's machines; a shared one is not asked.
    read: async (sandbox) =>
        sandbox.role === `owner` ? { devices: (await sandboxRpc.system.devices(undefined, { context: { at: sandbox.id, background: true } })).devices } : { devices: [] },
});

export const subscribeDevicesAcross = store.subscribe;

/** Every other connected sandbox and the devices it last reported; one never read reports none. */
export const devicesAcross = store.entries;
