import { t } from "@intentic/ui/i18n";
import { computed, ref, type Ref, watch } from "vue";
import { track } from "../../../app/analytics";
import { manageDeviceSandbox } from "../../../models/sandbox/devices/useDevices";
import { useOperation } from "../../../workbench/operations/operations";
import { type MachineDoor, setupDoors } from "../../sandbox/live/sandboxDoors";
import { useDeviceRelays } from "../../sandbox/live/useDeviceRelays";

// WHERE THE READER'S OWN-COMPUTER SETUP RUNS: this computer's own way (the app's button, the installer, the command), or
// a computer of the owner's that is already connected, set up with a press instead of the command. Any of the owner's
// sandboxes that reaches an online machine able to make a sandbox can run the same `ic sandbox connect` the command runs,
// with this row's code: the `create` op `sandboxes create --on` already uses.
//
// Picking where is a choice, never an act (2026-10-21). Each machine was its own gold button beside "Set it up now", so
// the page had two primaries and no way to tell which it meant, and a misclick on one started a sandbox on that machine
// with nothing to call it off: the machine's flow takes no stop. Now one row picks where and the card shows the one
// button that sets it up there, so a stray click only moves the pick.

/** The reader's own computer's way, as a pick beside the connected machines' keys. */
export const HERE = `here`;

export interface SetupOnMachineHost {
    // Whether a press on a machine could do what the command would: the platform's address, no checkout image, a code
    // minted, no project. While it could not, no sandbox's devices are even read.
    readonly offered: () => boolean;
    // The row being set up, which keys the run in the ledger.
    readonly created: Readonly<Ref<{ readonly id: string } | null>>;
    // The minted code and the hostname it names; the slug is that hostname's first label.
    readonly setup: Readonly<Ref<{ readonly code: string; readonly hostname: string } | null>>;
    // A phone has no computer of its own to set up: a connected machine is its one-press way, so it is picked first.
    readonly mobile: Readonly<Ref<boolean>>;
}

export const useSetupOnMachine = ({ offered, created, setup, mobile }: SetupOnMachineHost) => {
    // Every sandbox of the owner's, read fresh once a press is on offer and kept read while it stays so.
    const { relays, look } = useDeviceRelays({ follow: offered });
    watch(
        offered,
        (on) => {
            if (on) {
                void look();
            }
        },
        { immediate: true },
    );
    const doors = computed<readonly MachineDoor[]>(() => (offered() ? setupDoors(relays.value) : []));

    const run = useOperation<string>(() => `setup/${created.value?.id ?? ``}/on-machine`);
    // The machine the running press was sent to: held while it runs, since the reading it was picked from moves under it
    // (the flow drops that machine's cached reading), and the run's own log must not vanish with a re-read.
    const pressed = ref<MachineDoor>();

    const picked = ref<string>();
    // The pick, while it still names something on offer; else the default: a phone's first machine, this computer's way
    // everywhere else.
    const target = computed<string>({
        get: () => {
            if (run.busy.value && pressed.value !== undefined) {
                return pressed.value.machineKey;
            }
            const pick = picked.value;
            if (pick === HERE || doors.value.some((door) => door.machineKey === pick)) {
                return pick ?? HERE;
            }
            return mobile.value ? (doors.value[0]?.machineKey ?? HERE) : HERE;
        },
        set: (next) => {
            if (next !== picked.value) {
                track(`setup_target_picked`, { target: next === HERE ? `here` : `machine`, machines: doors.value.length });
            }
            picked.value = next;
        },
    });
    /** The connected machine picked, or undefined while this computer's own way is. */
    const door = computed<MachineDoor | undefined>(() =>
        run.busy.value && pressed.value !== undefined ? pressed.value : doors.value.find((each) => each.machineKey === target.value),
    );

    const setUpOn = async (): Promise<void> => {
        const on = door.value;
        const minted = setup.value;
        if (run.busy.value || on === undefined || created.value === null || minted === null) {
            return;
        }
        pressed.value = on;
        const slug = minted.hostname.split(`.`)[0] ?? ``;
        track(`setup_on_machine_started`, { machines: doors.value.length });
        await run.run({
            what: t(`setup.setupOnMachine.settingUpOn`, { machine: on.machineLabel }),
            failed: t(`setup.setupOnMachine.couldntOn`, { machine: on.machineLabel }),
            task: async (report) =>
                await manageDeviceSandbox(on.hostId, slug, `create`, { setupCode: minted.code, at: on.relay, onLine: report.line }),
        });
    };

    // The "Runs on" row: this computer's own way beside each machine that could take it. A phone has none of its own, so
    // its way is the link it mails to a computer.
    const options = computed(() => [
        mobile.value
            ? { value: HERE, label: t(`setup.setupOnMachine.byEmail`), icon: `envelope` as const }
            : { value: HERE, label: t(`setup.setupOnMachine.thisComputer`), icon: `desktop` as const },
        ...doors.value.map((each) => ({ value: each.machineKey, label: each.machineLabel, icon: `server` as const })),
    ]);
    /** This computer's own way is on the card, rather than a connected machine's button. */
    const here = computed(() => door.value === undefined);

    return { doors, target, door, here, options, run, setUpOn };
};

export type SetupOnMachineApi = ReturnType<typeof useSetupOnMachine>;
