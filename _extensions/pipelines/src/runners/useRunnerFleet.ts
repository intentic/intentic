import { errorMessage } from "@intentic/base/errors";
import { useQueryClient } from "@tanstack/vue-query";
import { computed, ref } from "vue";
import { host } from "../host";
import { t } from "../i18n.js";
import type { CiFleet, CiRunnerOp } from "./fleetTypes";
import { type FleetDevice, type FleetRead, fleetDevices, shownReads } from "./runnerFleet";

// The self-hosted runners on the owner's connected computers, through the daemon's device routes
// (contracts/device-ci-runners.contract.ts): the device list says which computers can answer, then one read per
// computer, together as one entry so a computer that does not answer is one failed row rather than a failed section.

// A runner picks a job up within seconds, so the section reads faster than the board's runs do. Like the board's own
// reads it is a vue-query interval, which pauses while the tab is hidden and stops once the view unmounts.
const RUNNERS_POLL_MS = 15_000;
// Computers come and go far less often than runners change, and the device list asks every machine for its sandboxes.
const DEVICES_POLL_MS = 60_000;

/** The answer to one press, or its refusal, under the computer it was pressed on. */
export interface RunnerNote {
    readonly tone: `info` | `danger`;
    readonly text: string;
}

export function useRunnerFleet() {
    const api = host();
    const queryClient = useQueryClient();
    // The runner routes floor at maintainer; below it there is nothing to read, so nothing is asked.
    const allowed = computed(() => api.sandbox.tier() === `owner` || api.sandbox.tier() === `maintainer`);

    const devicesRead = api.sandbox.query({
        queryKey: api.sandbox.readKey(`system.devices`),
        queryFn: () => api.sandbox.rpc.system.devices(),
        select: (answer): FleetDevice[] => fleetDevices(answer.devices),
        enabled: allowed,
        refetchInterval: DEVICES_POLL_MS,
    });
    const devices = computed(() => devicesRead.query.data.value ?? []);

    const readOne = (device: FleetDevice): Promise<FleetRead> =>
        api.sandbox.rpc.system.deviceCiFleet({ id: device.id }).then(
            (fleet: CiFleet): FleetRead => ({ device, fleet }),
            (error: Error): FleetRead => ({ device, error: errorMessage(error) }),
        );
    const fleetsKey = computed(() => api.sandbox.key(`pipelines.ci-fleets`, ...devices.value.map((device) => device.id)));
    const fleetsRead = api.sandbox.query({
        queryKey: fleetsKey,
        queryFn: () => Promise.all(devices.value.map(readOne)),
        enabled: computed(() => allowed.value && devices.value.length > 0),
        refetchInterval: RUNNERS_POLL_MS,
    });
    const reads = computed(() => shownReads(fleetsRead.query.data.value ?? []));
    const refresh = (): Promise<void> => queryClient.invalidateQueries({ queryKey: fleetsKey.value });

    // Presses in flight by key, several at once: a registration takes minutes and must not hold the other rows.
    const busy = ref<ReadonlySet<string>>(new Set());
    const notes = ref<Readonly<Record<string, RunnerNote>>>({});
    const setBusy = (key: string, on: boolean): void => {
        const next = new Set(busy.value);
        if (on) {
            next.add(key);
        } else {
            next.delete(key);
        }
        busy.value = next;
    };
    const note = (device: FleetDevice, value: RunnerNote): void => {
        notes.value = { ...notes.value, [device.id]: value };
    };

    // Every press answers in the daemon's (or the machine's) own sentence, said under the computer it was pressed on,
    // and the computer is read again at once so the row shows what the press did.
    const press = async (device: FleetDevice, key: string, call: () => Promise<{ readonly said: string }>): Promise<boolean> => {
        setBusy(key, true);
        try {
            note(device, { tone: `info`, text: (await call()).said });
            return true;
        } catch (failure) {
            note(device, { tone: `danger`, text: errorMessage(failure) });
            return false;
        } finally {
            setBusy(key, false);
            void refresh();
        }
    };

    const op = (device: FleetDevice, name: string, which: CiRunnerOp): Promise<boolean> =>
        press(device, opKey(device, name, which), () => api.sandbox.rpc.system.deviceCiRunnerOp({ id: device.id, name, op: which }));
    const remove = (device: FleetDevice, name: string): Promise<boolean> =>
        press(device, opKey(device, name, `remove`), () => api.sandbox.rpc.system.removeDeviceCiRunner({ id: device.id, name }));
    const register = (device: FleetDevice, input: { readonly repo: string; readonly name: string; readonly labels: string[] }): Promise<boolean> => {
        // Said at once: the machine downloads and configures the runner before it answers, which takes minutes.
        note(device, { tone: `info`, text: t(`runners.add.adding`, { name: input.name }) });
        return press(device, addKey(device), () => api.sandbox.rpc.system.registerDeviceCiRunner({ id: device.id, ...input }));
    };
    const logs = async (device: FleetDevice, name: string): Promise<string> => (await api.sandbox.rpc.system.deviceCiRunnerLogs({ id: device.id, name })).text;

    return {
        reads,
        loaded: fleetsRead.loaded,
        busy,
        notes,
        op,
        remove,
        register,
        logs,
    };
}

/** The key a row's press is busy under. */
const opKey = (device: FleetDevice, name: string, which: CiRunnerOp | `remove`): string => `${device.id}\n${name}\n${which}`;
export const addKey = (device: FleetDevice): string => `${device.id}\nadd`;
