import { createWorkerCall } from "../../../../lib/workerCall";
import { MAX_ROWS, type Sheet, type SheetDiff, tableDiff } from "./tableDiff";

export interface TableDiffArgs {
    readonly before: readonly Sheet[];
    readonly after: readonly Sheet[];
}

// Worst-case cell comparisons a diff may run on the render thread: about 2 ms on a desktop, under a frame on a phone.
export const INLINE_CELL_PAIRS = 1_000_000;

const widest = (sheet: Sheet): number => sheet.rows.reduce((most, row) => Math.max(most, row.length), 0);

/** Rows times rows times width over the sheets both sides hold: what pairing costs when every row changed. */
export const worstCaseCellPairs = ({ before, after }: TableDiffArgs): number => {
    const afterByName = new Map(after.map((sheet) => [sheet.name, sheet]));
    let pairs = 0;
    for (const sheet of before) {
        const counterpart = afterByName.get(sheet.name);
        if (counterpart !== undefined) {
            pairs += Math.min(sheet.rows.length, MAX_ROWS) * Math.min(counterpart.rows.length, MAX_ROWS) * Math.max(widest(sheet), widest(counterpart));
        }
    }
    return pairs;
};

const requestTableDiff = createWorkerCall<TableDiffArgs, SheetDiff[]>(
    async () => {
        if (typeof Worker === `undefined`) {
            return undefined;
        }
        const { default: TableDiffWorker } = await import(`./tableDiffWorker?worker`);
        return new TableDiffWorker();
    },
    ({ before, after }) => tableDiff(before, after),
);

/** The diff now when even its worst case is cheap, so the first frame draws it; otherwise the worker's answer. */
export const diffTables = (args: TableDiffArgs): SheetDiff[] | Promise<SheetDiff[]> =>
    worstCaseCellPairs(args) <= INLINE_CELL_PAIRS ? tableDiff(args.before, args.after) : requestTableDiff(args);
