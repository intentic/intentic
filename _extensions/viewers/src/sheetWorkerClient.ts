import { createWorkerCall, type WorkerFactory } from "@intentic/extension-ui/worker";
import type { SheetRows, SheetWorkerAnswer, SheetWorkerCommand } from "./sheetProtocol";

// One workbook per worker: `load` hands the bytes over and the worker keeps what it parsed, so the page holds no copy
// to fall back on and every failure rejects with the worker's own words.
export const createSheetWorkerClient = (workerFactory: WorkerFactory<SheetWorkerCommand, SheetWorkerAnswer>) => {
    const call = createWorkerCall<SheetWorkerCommand, SheetWorkerAnswer>(
        workerFactory,
        () => {
            throw new Error(`Spreadsheet worker failed.`);
        },
        { transfer: (command) => (command.type === `load` ? [command.buffer] : []), final: () => true },
    );
    return {
        async load(buffer: ArrayBuffer): Promise<readonly string[]> {
            const answer = await call({ type: `load`, buffer });
            if (answer.type !== `loaded`) {
                throw new Error(`Spreadsheet worker returned an unexpected response.`);
            }
            return answer.names;
        },
        async render(name: string): Promise<SheetRows> {
            const answer = await call({ type: `render`, name });
            if (answer.type !== `rendered`) {
                throw new Error(`Spreadsheet worker returned an unexpected response.`);
            }
            return answer.rows;
        },
        close: call.close,
    };
};
