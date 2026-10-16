import type { SandboxSummary } from "@intentic/api-contract";
import { computed, type ComputedRef, type Ref, watch } from "vue";
import { machinesLooked, type MachineDoor, sandboxDoor } from "../live/sandboxDoors";
import { useDeviceRelays } from "../live/useDeviceRelays";

// THE REMOVE DIALOG'S QUESTION: can the container out there be deleted with a press, and through which sandbox. Asked
// fresh each time the dialog opens, of the sandbox open and of every other one the owner has, since the switcher reads
// its device list once per page and a sandbox made on a machine since then would otherwise be a command to type.

/** What the dialog knows about deleting the container out there. */
export interface RemovalDoorReading {
    /** Where a press deletes it; undefined while nothing found reaches a machine holding it. */
    readonly door: ComputedRef<MachineDoor | undefined>;
    /** The machines that listed what they hold, by name: the ones "it isn't there" is true of. */
    readonly looked: ComputedRef<readonly string[]>;
    /** The fresh reads are still out, so not finding it yet says nothing. */
    readonly looking: Ref<boolean>;
}

export function useRemovalDoor(target: () => SandboxSummary | undefined, slug: () => string | undefined): RemovalDoorReading {
    const { relays, looking, look } = useDeviceRelays();
    const door = computed(() => {
        const removing = target();
        return removing === undefined ? undefined : sandboxDoor(relays.value, slug(), removing.id);
    });
    const looked = computed(() => machinesLooked(relays.value));
    // Only an owner's own-machine row has a container a press could reach; a hosted one is the platform's to stop.
    watch(
        () => {
            const row = target();
            return row !== undefined && row.role === `owner` && row.hosted === null ? row.id : undefined;
        },
        (id) => {
            if (id === undefined) {
                looking.value = false;
                return;
            }
            void look();
        },
        { immediate: true },
    );
    return { door, looked, looking };
}
