import { type Clients, perform } from "../actions.js";
import type { Operation } from "../core/guard.js";
import type { JsonObject } from "../core/json.js";
import type { OfficeRecords } from "../core/records.js";

// Performs an allowed or approved operation and notes it in the card's records, where the rail view lists it.
export const performNow = async (operation: Operation, clients: Clients, records: OfficeRecords, approvalId?: string): Promise<JsonObject> => {
    const result = await perform(operation, clients, records);
    await records.recordAction({ at: new Date().toISOString(), key: operation.key, approvalId, outcome: operation.summary });
    return result;
};
