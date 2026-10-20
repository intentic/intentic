import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { ActivityStore } from "../../../activity/activity-store.js";
import { defineDocument } from "../../../store/evolution/documents.js";
import { openDirectory } from "../../../store/open-document.js";
import { STATUS_FILE } from "./job-files.js";
import { jobRunnerPids } from "./job-processes.js";
import { renameRunFile, writeRunFile } from "./run-files.js";

const KeptJobSchema = z.object({
    id: z.string().uuid(),
    conversationId: z.string(),
    label: z.string(),
    dir: z.string(),
    session: z.string(),
});
type KeptJob = z.infer<typeof KeptJobSchema>;

// A kept command cannot safely be replayed after a container loss. Keep enough outside /tmp to name its loss instead.
export const keptJobRecordsDocument = defineDocument({
    root: "history",
    path: "kept-jobs/",
    // Receipts name kept commands lost with container-local capture storage; never replay arbitrary commands.
    portability: "derived",
    directory: true,
    schema: KeptJobSchema,
});
const recordsDir = (historyRoot: string): string => join(historyRoot, keptJobRecordsDocument.path);

// `keep` is synchronous; its durable receipt is written before the tool acknowledges the decision.
export const rememberKeptJob = (historyRoot: string | undefined, job: KeptJob): void => {
    if (historyRoot === undefined) {
        return;
    }
    const dir = recordsDir(historyRoot);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = `${job.id}.json`;
    writeRunFile(dir, `${file}.tmp`, JSON.stringify(KeptJobSchema.parse(job)));
    renameRunFile(dir, `${file}.tmp`, file);
};

export const forgetKeptJob = (historyRoot: string | undefined, id: string): void => {
    if (historyRoot === undefined) {
        return;
    }
    try {
        rmSync(join(recordsDir(historyRoot), `${id}.json`), { force: true });
    } catch {
        // allow(silent-catch): a receipt left behind only costs one boot check, which retires it once its job has a status.
    }
};

/** Every kept command's receipt, read before the gate opens; throws for one that cannot be read, so none is retired blind. */
export const keptJobReceipts = async (historyRoot: string): Promise<readonly KeptJob[]> => {
    const { entries, invalid } = await openDirectory(keptJobRecordsDocument, recordsDir(historyRoot)).list();
    if (invalid.length > 0) {
        throw new Error(`kept job receipts could not be read: ${invalid.join(", ")}`);
    }
    return entries;
};

/** Boot recovery reports each lost kept command in Activity before retiring its receipt. */
export const reportLostKeptJobs = async (historyRoot: string, left: readonly KeptJob[], activity: Pick<ActivityStore, "append">, procRoot = "/proc"): Promise<void> => {
    const store = openDirectory(keptJobRecordsDocument, recordsDir(historyRoot));
    const alive = await jobRunnerPids(left.map((job) => job.dir), procRoot);
    for (const job of left) {
        if (alive.has(job.dir)) {
            continue;
        }
        // A normal recorded exit is not a restart loss. Missing capture storage is, even though no status survived.
        if (!existsSync(join(job.dir, STATUS_FILE))) {
            await activity.append({
                direction: "system",
                type: "job.lost",
                conversationId: job.conversationId,
                content: `Kept job "${job.label}" did not survive the sandbox restart. Start it again if it is still needed.`,
            });
        }
        await store.remove(job.id);
    }
};
