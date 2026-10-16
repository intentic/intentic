import { within } from "@intentic/base/async";
import { computed, type ComputedRef, onScopeDispose, type Ref, ref } from "vue";
import { useSandbox } from "../../../client/sandbox/useSandbox";
import { useDevices } from "../../../models/sandbox/devices/useDevices";
import { devicesAcross, readDevicesAcross, subscribeDevicesAcross } from "./devicesAcross";
import type { DeviceRelay } from "./sandboxDoors";

// THE OWNER'S SANDBOXES AS WAYS TO A MACHINE: the open one and every other one, each with the devices it reaches, for a
// screen deciding between a button and a command (sandboxDoors.ts). The open sandbox's list is read once per page and
// the others' on a slow poll, so a screen about to answer that question asks them all again first (`look`), and says
// "looking" rather than printing a command for a machine it merely has not heard about yet.

// Longest a screen says "looking": a machine's reading is bounded at 8 s on the daemon, plus the way to it.
const LOOK_MS = 10_000;

export interface DeviceRelays {
    readonly relays: ComputedRef<readonly DeviceRelay[]>;
    /** A fresh read is out, so not finding a machine yet says nothing. */
    readonly looking: Ref<boolean>;
    /** Reads every relay's devices again, settling once all answered or the wait ran out; a newer look supersedes it. */
    readonly look: () => Promise<void>;
}

export interface DeviceRelaysOptions {
    /** Leave the open sandbox out: it is the one not answering, so it can carry nothing (the recovery panel). */
    readonly withoutActive?: boolean;
    /** Keep the other sandboxes' lists polled for as long as this scope lives, for a screen that stays open. */
    readonly follow?: boolean;
}

export function useDeviceRelays(options: DeviceRelaysOptions = {}): DeviceRelays {
    const sandbox = useSandbox();
    // Not even read for a sandbox that is down: its query would only fail, and say so.
    const own = options.withoutActive === true ? undefined : useDevices({ poll: false });
    // The open sandbox carries a press only while it answers: one being set up, or one down, has no daemon to relay it.
    const ownAnswers = (): boolean => own !== undefined && sandbox.reachable.value;
    const relays = computed<readonly DeviceRelay[]>(() => {
        const active = sandbox.activeSandboxId.value;
        return [
            ...(own === undefined || active === undefined || !ownAnswers() ? [] : [{ sandboxId: active, devices: own.devices.value }]),
            ...devicesAcross.value.map((box) => ({ sandboxId: box.sandbox.id, devices: box.devices })),
        ];
    });
    if (options.follow === true) {
        onScopeDispose(subscribeDevicesAcross());
    }
    const looking = ref(false);
    let asked = 0;
    const look = async (): Promise<void> => {
        asked += 1;
        const mine = asked;
        looking.value = true;
        // A forced read skips the query's own gate, so one is asked of the open sandbox only while it answers.
        const reads = [...(own !== undefined && ownAnswers() ? [own.reread()] : []), ...devicesAcross.value.map((box) => readDevicesAcross(box.sandbox.id))];
        // A sandbox that never answers keeps what it said last; the screen stops waiting on it rather than looking forever.
        await within(Promise.allSettled(reads), LOOK_MS, undefined);
        if (mine === asked) {
            looking.value = false;
        }
    };
    return { relays, looking, look };
}
