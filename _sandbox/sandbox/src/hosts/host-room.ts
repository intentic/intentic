import type { HostRoom } from "@intentic/constants/memory-room";
import { DevicePingSchema, HOST_NATIVE_ENVIRONMENT, hostConnectionKey, type HostMemory, hostMemoryLowBytes, parseHostConnection } from "@intentic/sandbox-contract/schemas/hosts";
import { opt } from "../opt.js";
import type { Pinged } from "../peers/peer-hub.js";

/* WHAT A CONNECTED MACHINE'S OWN OS HAS FREE, from the last heartbeat its agent answered (DevicePingSchema `memory`).
   Pure, so both readers share it without the device-report machinery: the room gate asks it for the machine this
   sandbox runs on (host-memory.ts), and the fleet reading for the machine each runner runs on (runners/fleet-advice.ts).

   It fails open everywhere: no door, a distro whose Windows side is not connected, an agent older than the field, or a
   last answer older than HOST_MEMORY_STALE_MS: each is "no host to answer to", never "no room", so a PC that went to
   sleep never holds every heavy command. */

// Four missed heartbeats: a reading older than that is a machine that stopped answering, and its memory says nothing now.
export const HOST_MEMORY_STALE_MS = 2 * 60_000;

// Whether the machine behind a door answered a heartbeat lately, on that door or its card's native one, whatever its
// answer said: an awake machine. A runner gone quiet while its machine still answers is down there, not asleep with it
// (runners/held-turns/runner-relay.ts).
export const hostAnswering = (door: string | undefined, pinged: (door: string) => Pinged | undefined, now: number): boolean => {
    if (door === undefined) {
        return false;
    }
    const { card } = parseHostConnection(door);
    return [door, hostConnectionKey(card, HOST_NATIVE_ENVIRONMENT)].some((asked) => {
        const beat = pinged(asked);
        return beat !== undefined && now - beat.at <= HOST_MEMORY_STALE_MS;
    });
};

// The host part of a reading, from a door (a hub key: a card, or `<card>::wsl:<distro>`) and each door's last heartbeat.
// That door's own answer first; a distro's door has none, so its machine's Windows side (the card's native door) is
// asked next, since the distro and Docker Desktop's VM live in the same Windows.
export const hostRoomFrom = (door: string | undefined, pinged: (door: string) => Pinged | undefined, now: number): HostRoom | undefined => {
    if (door === undefined) {
        return undefined;
    }
    const { card } = parseHostConnection(door);
    for (const asked of new Set([door, hostConnectionKey(card, HOST_NATIVE_ENVIRONMENT)])) {
        const beat = pinged(asked);
        if (beat === undefined || now - beat.at > HOST_MEMORY_STALE_MS) {
            continue;
        }
        const parsed = DevicePingSchema.safeParse(beat.answer);
        const memory = parsed.success ? parsed.data.memory : undefined;
        if (memory !== undefined) {
            return roomOf(card, memory);
        }
    }
    return undefined;
};

// One heartbeat's memory as the host part of a reading, with the WSL VM's share where the agent read it (a VM that is not
// running reads 0, which says nothing about this one).
const roomOf = (name: string, memory: HostMemory): HostRoom => ({
    name,
    availableBytes: memory.availableBytes,
    totalBytes: memory.totalBytes,
    reserveBytes: hostMemoryLowBytes(memory.totalBytes),
    ...opt("vmBytes", memory.vm === undefined || memory.vm.workingSetBytes === 0 ? undefined : memory.vm.workingSetBytes),
    ...opt("vmUnusedBytes", memory.guestFree?.strandedBytes),
    ...opt("vmReportableBytes", memory.guestFree?.reportableBytes),
});
