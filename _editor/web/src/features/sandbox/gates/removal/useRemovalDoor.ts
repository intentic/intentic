import type { SandboxSummary } from "@intentic/api-contract";
import { t } from "@intentic/ui/i18n";
import { computed, type ComputedRef, type Ref, ref, watch } from "vue";
import { localFace } from "../../../../app/environments/local";
import { type LocalMachineHost, localHost } from "../../../../app/environments/localHost";
import { machinesLooked, type MachineDoor, sandboxDoor } from "../../live/sandboxDoors";
import { useDeviceRelays } from "../../live/useDeviceRelays";

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

// Only an owner's own-machine row has a container a press could reach; a hosted one is the platform's to stop.
const ownMachineRow = (row: SandboxSummary | undefined): string | undefined =>
    row !== undefined && row.role === `owner` && row.hosted === null ? row.id : undefined;

// FROM A LOCAL WINDOW, the one machine its page can reach is the one it runs on, through the app: the daemons that relay a
// press from the workspace refuse this page's origin. So the door is this computer, when its engine holds the sandbox,
// and none otherwise (the dialog then prints the command for the machine that does).
function thisComputerDoor(
    machine: LocalMachineHost | undefined,
    target: () => SandboxSummary | undefined,
    slug: () => string | undefined,
): RemovalDoorReading {
    const label = t(`sandbox.sandboxSwitcher.thisComputer`);
    const holds = ref<boolean | undefined>(undefined);
    const looking = ref(false);
    let asked = 0;
    watch(
        () => [ownMachineRow(target()), slug()] as const,
        async ([id, name]) => {
            asked += 1;
            const mine = asked;
            holds.value = undefined;
            if (machine === undefined || id === undefined || name === undefined) {
                looking.value = false;
                return;
            }
            looking.value = true;
            let found: boolean | undefined;
            try {
                found = await machine.holds(name);
            } catch (error) {
                console.warn(`[local] this computer's sandboxes could not be read:`, error);
            }
            if (mine === asked) {
                holds.value = found;
                looking.value = false;
            }
        },
        { immediate: true },
    );
    const door = computed<MachineDoor | undefined>(() =>
        machine === undefined || holds.value !== true
            ? undefined
            : {
                  relay: THIS_COMPUTER,
                  hostId: THIS_COMPUTER,
                  machineKey: THIS_COMPUTER,
                  machineLabel: label,
                  severs: false,
                  carry: (name) => machine.remove(name),
              },
    );
    return { door, looked: computed(() => (holds.value === false ? [label] : [])), looking };
}

const THIS_COMPUTER = `this-computer`;

export function useRemovalDoor(target: () => SandboxSummary | undefined, slug: () => string | undefined): RemovalDoorReading {
    if (localFace() !== undefined) {
        return thisComputerDoor(localHost().machine, target, slug);
    }
    const { relays, looking, look } = useDeviceRelays();
    const door = computed(() => {
        const removing = target();
        return removing === undefined ? undefined : sandboxDoor(relays.value, slug(), removing.id);
    });
    const looked = computed(() => machinesLooked(relays.value));
    watch(
        () => ownMachineRow(target()),
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
