import { useLoaded } from "@intentic/extension-api";
import { computed } from "vue";
import { rpcQuery } from "../../../client/sandbox/rpcQuery";
import { useSandboxQuery } from "../../../client/sandbox/useSandboxQuery";
import { useRunners } from "../../../models/sandbox/devices/useRunners";

// Counts every machine door into the sandbox besides a person or control token (webhooks, workflow gates, CI hooks,
// paired machines), for the Access tab's "what still has a way in" question. Reads and counts only; each count is
// best-effort, unknown rather than failing the tab.
//
// Every count is a narrowed view (`select`) of a cache entry that is already the procedure's own and that the daemon's
// pushes keep fresh (automations.list, workflows.list, ci.runs, system.devices, and the runners list), so this tab
// shares the reads the boards and the Devices view hold instead of asking the daemon again each time it opens.

export interface AccessInventory {
    // Event automations, each reachable at /automations/{id}/fire with its own token.
    readonly webhooks?: number;
    // Workflows that declare a release gate, each reachable at /workflows/{id}/gate with its own token.
    readonly gates?: number;
    // Repositories wired to a forge, and how many of those had their CI webhook registered by the sandbox.
    readonly ciRepos?: { readonly total: number; readonly hooked: number };
    // Machines enrolled with this sandbox (devices and runners), each holding its own enrollment key.
    readonly paired?: { readonly devices: number; readonly runners: number };
}

export function useAccessInventory() {
    const webhooks = useSandboxQuery({
        ...rpcQuery(`automations.list`),
        select: ({ automations }) => automations.filter((automation) => automation.trigger.kind === `event`).length,
    });
    const gates = useSandboxQuery({
        ...rpcQuery(`workflows.list`),
        select: ({ workflows }) => workflows.filter((workflow) => workflow.gate !== undefined).length,
    });
    const ci = useSandboxQuery({
        ...rpcQuery(`ci.runs`),
        select: ({ repos }) => ({ total: repos.length, hooked: repos.filter((repo) => repo.hookWarning === undefined).length }),
    });
    const devices = useSandboxQuery({ ...rpcQuery(`system.devices`), select: (answer) => answer.devices.length });
    // Not polled from here: the Devices view that polls it, and the daemon's push, keep it fresh.
    const runners = useRunners(false);

    const inventory = computed<AccessInventory>(() => {
        const counted: { -readonly [K in keyof AccessInventory]: AccessInventory[K] } = {};
        if (webhooks.query.data.value !== undefined) {
            counted.webhooks = webhooks.query.data.value;
        }
        if (gates.query.data.value !== undefined) {
            counted.gates = gates.query.data.value;
        }
        if (ci.query.data.value !== undefined) {
            counted.ciRepos = ci.query.data.value;
        }
        if (devices.query.data.value !== undefined && runners.loaded.value) {
            counted.paired = { devices: devices.query.data.value, runners: runners.runners.value.length };
        }
        return counted;
    });
    // A wait while any count is still out (held while the sandbox is not answering included), then every count there is:
    // a read that failed leaves its door unknown, "not readable right now", rather than failing the whole tab.
    const loaded = useLoaded(() => {
        const reading = [webhooks, gates, ci, devices].some(({ loaded: read }) => read.value.state === `waiting`) || runners.isLoading.value;
        return { data: reading ? undefined : inventory.value, error: undefined, fetching: reading, wanted: true };
    });
    return { inventory, loaded };
}
