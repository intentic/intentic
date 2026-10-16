import type { SandboxSummary } from "@intentic/api-contract";
import { within } from "@intentic/base/async";
import { computed, type ComputedRef, type Ref, ref, watch } from "vue";
import { useSandbox } from "../../../client/sandbox/useSandbox";
import { useDevices } from "../devices/useDevices";
import { devicesAcross, readDevicesAcross } from "../live/devicesAcross";
import { machinesLooked, type RemovalDoor, removalDoor, type RemovalRelay } from "./removalDoor";

// THE REMOVE DIALOG'S QUESTION: can the container out there be deleted with a press, and through which sandbox. Asked
// fresh each time the dialog opens, of the sandbox open and of every other one the owner has, since the switcher reads
// its device list once per page and a sandbox made on a machine since then would otherwise be a command to type.

// Longest the dialog says "looking": a machine's reading is bounded at 8 s on the daemon, plus the way to it.
const LOOK_MS = 10_000;

/** What the dialog knows about deleting the container out there. */
export interface RemovalDoorReading {
    /** Where a press deletes it; undefined while nothing found reaches a machine holding it. */
    readonly door: ComputedRef<RemovalDoor | undefined>;
    /** The machines that listed what they hold, by name: the ones "it isn't there" is true of. */
    readonly looked: ComputedRef<readonly string[]>;
    /** The fresh reads are still out, so not finding it yet says nothing. */
    readonly looking: Ref<boolean>;
}

export function useRemovalDoor(target: () => SandboxSummary | undefined, slug: () => string | undefined): RemovalDoorReading {
    const sandbox = useSandbox();
    const { devices, reread } = useDevices({ poll: false });
    const relays = computed<readonly RemovalRelay[]>(() => {
        const active = sandbox.activeSandboxId.value;
        return [
            ...(active === undefined ? [] : [{ sandboxId: active, devices: devices.value }]),
            ...devicesAcross.value.map((box) => ({ sandboxId: box.sandbox.id, devices: box.devices })),
        ];
    });
    const door = computed(() => {
        const removing = target();
        return removing === undefined ? undefined : removalDoor(relays.value, slug(), removing.id);
    });
    const looked = computed(() => machinesLooked(relays.value));

    // Only an owner's own-machine row has a container a press could reach; a hosted one is the platform's to stop.
    const looking = ref(false);
    let asked = 0;
    watch(
        () => {
            const row = target();
            return row !== undefined && row.role === `owner` && row.hosted === null ? row.id : undefined;
        },
        async (id) => {
            asked += 1;
            const mine = asked;
            looking.value = id !== undefined;
            if (id === undefined) {
                return;
            }
            const reads = [reread(), ...devicesAcross.value.map((box) => readDevicesAcross(box.sandbox.id))];
            // A sandbox that never answers keeps what it said last; the dialog stops waiting on it rather than looking forever.
            await within(Promise.allSettled(reads), LOOK_MS, undefined);
            if (mine === asked) {
                looking.value = false;
            }
        },
        { immediate: true },
    );
    return { door, looked, looking };
}
