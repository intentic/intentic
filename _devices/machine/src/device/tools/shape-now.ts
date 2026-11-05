import type { DeviceSandbox, SandboxShapeFields } from "@intentic/sandbox-contract/schemas/devices";

// Whether `fields`, applied now, change a running sandbox's swap and nothing else (2026-11-05): what `ic sandbox shape`
// then writes into the running sandbox instead of restarting it, so the answer says no restart happened. The same
// arithmetic as ic's (its sandbox/desired.rs `set`): the fields laid over the shape saved for the next restart, else over
// what runs, compared with what runs. False for a report without the swap (an ic older than it), which ic's own older
// self would have restarted for. Pure.
export const swapOnlyNow = (box: DeviceSandbox, fields: SandboxShapeFields): boolean => {
    const running = box.resources?.shape;
    if (!box.running || running?.swapGib === undefined) {
        return false;
    }
    const base = box.resources?.desired ?? running;
    const target = { ...base, ...Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) };
    const same = (["memoryGib", "cpus", "privileged", "gpu"] as const).every((field) => target[field] === running[field]);
    return same && (target.swapGib ?? null) !== (running.swapGib ?? null);
};
