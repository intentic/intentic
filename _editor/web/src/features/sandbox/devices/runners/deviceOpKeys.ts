import type { DeviceSandboxGroup } from "@intentic/ui";
import { operationAt } from "../../../../workbench/operations/operations";

// Where a machine's runs are kept in the operations ledger (deviceOps.ts), named once so the page can read a row's run
// without holding the whole machine's ops: a container verb sits under its row, inside the machine's scope.
export const opsScope = (machineKey: string): string => `devices/${machineKey}/ops`;
export const ROW = (group: DeviceSandboxGroup): string => `row/${group.sandboxId}`;

/** When the verb running on a row began, read off the ledger: what the "so far" above the row's log counts from. */
export const verbStartedAt = (machineKey: string, group: DeviceSandboxGroup): number | undefined => {
    const run = operationAt(`${opsScope(machineKey)}/${ROW(group)}`);
    return run?.state === `running` ? run.startedAt : undefined;
};
