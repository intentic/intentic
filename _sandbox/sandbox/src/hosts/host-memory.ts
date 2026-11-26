import { HOST_NATIVE_ENVIRONMENT, hostConnectionKey, parseHostConnection } from "@intentic/sandbox-contract/schemas/hosts";
import type { Pinged } from "../peers/peer-hub.js";
import type { HostSource } from "../workload/resource-budget.js";
import type { Services } from "../composition.js";
import { devices } from "./device-reports.js";
import { hostRoomFrom } from "./host-room.js";
import { hostRunningSelf, ownSlug } from "./self-host.js";

/* THE MEMORY OF THE MACHINE THIS SANDBOX RUNS ON (2026-11-02), for the room gate (workload/resource-budget.ts). The
   sandbox's own reading is its cgroup and the kernel under it, which on a Windows PC is Docker Desktop's WSL2 VM, not
   Windows: on 2026-11-02 the VM read as roomy while rog's Windows had 1.1 GB left and froze for 43 s. The Windows side's
   agent answers every heartbeat with what Windows has (DevicePingSchema, every HOST_HEARTBEAT_MS), the hub keeps the
   last answer (peers/peer-hub.ts `pinged`), and this turns it into the host part of a reading (host-room.ts).

   It fails open everywhere: no connected machine runs this sandbox, or that machine has nothing fresh to say
   (host-room.ts): each is "no host to answer to", never "no room", so a PC that went to sleep never holds every heavy
   command. */

// How long the answer to "which connected machine runs me" is kept: it is read off device readings already held, and the
// budget asks every ten seconds.
const SELF_RECHECK_MS = 60_000;

// Which machine runs this sandbox is only known from a device listing, which nothing may have asked for since the daemon
// started. With none known and a machine connected, one listing is asked for this often, in the background.
const FIND_SELF_MS = 15 * 60_000;

// How long a fresh reading waits on the machine's answer: a ping answers in milliseconds, and the last heartbeat stands in
// for one that does not come in time.
const FRESH_PING_MS = 3_000;

// The doors a host part is read from (host-room.ts hostRoomFrom: this door, then its machine's Windows side), each asked
// now; a door that is not connected or does not answer in time is left out, so its last heartbeat is read instead.
const pingedNow = async (hub: Pick<Services["hostHub"], "client">, door: string, now: () => number): Promise<Map<string, Pinged>> => {
    const { card } = parseHostConnection(door);
    const doors = [...new Set([door, hostConnectionKey(card, HOST_NATIVE_ENVIRONMENT)])];
    const answers = await Promise.all(
        doors.map(async (id): Promise<readonly [string, Pinged] | undefined> => {
            const client = hub.client(id);
            // allow(silent-catch): a ping that fails or times out is no fresh answer; the last heartbeat is read instead.
            const answer = await client?.ping(undefined, { signal: AbortSignal.timeout(FRESH_PING_MS) }).catch(() => undefined);
            return answer === undefined ? undefined : [id, { at: now(), answer }];
        }),
    );
    return new Map(answers.filter((entry) => entry !== undefined));
};

// Which door runs this sandbox, and when that was last asked.
interface SelfDoor {
    readonly at: number;
    readonly door: string | undefined;
}

// The budget's source of the host part: never throws, and answers undefined until composing has finished (`whole` is
// read per call for that reason).
export const hostRoomSource = (whole: () => Services, now: () => number = Date.now): HostSource => {
    let self: SelfDoor = { at: Number.NEGATIVE_INFINITY, door: undefined };
    let listedAt = Number.NEGATIVE_INFINITY;
    const selfDoor = async (services: Services): Promise<string | undefined> => {
        if (now() - self.at < SELF_RECHECK_MS) {
            return self.door;
        }
        self = { at: now(), door: await hostRunningSelf(services) };
        if (self.door === undefined && ownSlug(services) !== undefined && services.hostHub.connected().length > 0 && now() - listedAt >= FIND_SELF_MS) {
            listedAt = now();
            // allow(silent-catch): a listing that failed leaves the host unknown, which is no constraint; the next one is in FIND_SELF_MS
            void devices(services).catch(() => undefined);
        }
        return self.door;
    };
    return async (options) => {
        try {
            const services = whole();
            const door = await selfDoor(services);
            const asked = options?.fresh === true && door !== undefined ? await pingedNow(services.hostHub, door, now) : new Map<string, Pinged>();
            return hostRoomFrom(door, (id) => asked.get(id) ?? services.hostHub.state(id).pinged, now());
        } catch {
            // allow(silent-catch): a host part that cannot be read is no host part, and the sandbox's own reading stands
            return undefined;
        }
    };
};
