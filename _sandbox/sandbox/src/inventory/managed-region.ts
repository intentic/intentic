import type { InventoryEntry } from "@intentic/sandbox-contract";
import { readManagedRegion, writeManagedRegion } from "@intentic/scaffold";
import type { ConfigStore } from "./config-store.js";

// Upserts (by name) or removes one i.have.* / i.want.service entry in the managed region, commits, answers the region.
export const upsertManagedEntry = async (config: ConfigStore, entry: InventoryEntry, message: string): Promise<InventoryEntry[]> => {
    const content = await config.read();
    const next = [...readManagedRegion(content).filter((existing) => existing.name !== entry.name), entry];
    await config.write(writeManagedRegion(content, next), message);
    return next;
};

export const removeManagedEntry = async (config: ConfigStore, name: string, message: string): Promise<InventoryEntry[]> => {
    const content = await config.read();
    const entries = readManagedRegion(content);
    const next = entries.filter((entry) => entry.name !== name);
    if (next.length !== entries.length) {
        await config.write(writeManagedRegion(content, next), message);
    }
    return next;
};

// Whether an entry of that name is declared, the "is it active" signal for a service/integration capability.
export const hasManagedEntry = async (config: ConfigStore, name: string): Promise<boolean> =>
    readManagedRegion(await config.read()).some((entry) => entry.name === name);
