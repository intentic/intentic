import { createWorkerCall } from "../../../../lib/workerCall";
import { type Sheet, type SheetDiff, tableDiff } from "./tableDiff";

export interface TableDiffArgs {
    readonly before: readonly Sheet[];
    readonly after: readonly Sheet[];
}

// Off the render thread: a few thousand rows with an added column diff for over a second.
export const requestTableDiff = createWorkerCall<TableDiffArgs, SheetDiff[]>(
    async () => {
        if (typeof Worker === `undefined`) {
            return undefined;
        }
        const { default: TableDiffWorker } = await import(`./tableDiffWorker?worker`);
        return new TableDiffWorker();
    },
    ({ before, after }) => tableDiff(before, after),
);
