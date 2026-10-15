import type { OfficeRecords } from "../core/records.js";
import type { CaseRow, SavedFile, TaskRow } from "../core/snapshot.js";
import type { EzdClient } from "./integrator.js";

// What the EZD RP commands keep: the open cases and the position's tasks for the view, and downloaded documents.

export const syncCasesAndTasks = async (client: EzdClient, records: OfficeRecords, limit = 500): Promise<{ readonly cases: readonly CaseRow[]; readonly tasks: readonly TaskRow[] }> => {
    const cases = await client.cases({ status: "open" }, limit);
    const tasks = await client.tasks(limit);
    await records.update((current) => ({ ...current, syncedAt: new Date().toISOString(), cases, tasks }));
    return { cases, tasks };
};

export const saveDocument = async (client: EzdClient, records: OfficeRecords, documentId: string): Promise<SavedFile> => {
    const document = await client.download(documentId, `${documentId}.bin`);
    return records.save(["documents", documentId], document.name, document.bytes);
};
