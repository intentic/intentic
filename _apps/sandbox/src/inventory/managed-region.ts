import type { InventoryEntry } from "@intentic/sandbox-contract";
import { readManagedRegion, writeManagedRegion } from "@intentic/scaffold";
import type { ConfigStore } from "./config-store.js";

// Upsert (by name) / remove one i.have.* / i.want.service entry in deploy.config.ts's managed region and commit.
// Shared by the service + integration capability handlers so the write+commit logic lives in one place.
export const upsertManagedEntry = async (config: ConfigStore, entry: InventoryEntry, message: string): Promise<void> => {
    const content = await config.read();
    const next = [...readManagedRegion(content).filter((existing) => existing.name !== entry.name), entry];
    await config.write(writeManagedRegion(content, next), message);
};

export const removeManagedEntry = async (config: ConfigStore, name: string, message: string): Promise<void> => {
    const content = await config.read();
    const entries = readManagedRegion(content);
    const next = entries.filter((entry) => entry.name !== name);
    if (next.length !== entries.length) {
        await config.write(writeManagedRegion(content, next), message);
    }
};

// Whether an entry of that name is declared — the "is it active" signal for a service/integration capability.
export const hasManagedEntry = async (config: ConfigStore, name: string): Promise<boolean> =>
    readManagedRegion(await config.read()).some((entry) => entry.name === name);
