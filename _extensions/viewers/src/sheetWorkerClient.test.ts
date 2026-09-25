import type { SheetWorkerAnswer, SheetWorkerCommand } from "./sheetProtocol";
import { createSheetWorkerClient } from "./sheetWorkerClient";
import { fakeWorkerPort } from "./testing";

// A worker holding one workbook of two sheets, answering the way sheetWorker.ts does.
const workbook = () =>
    fakeWorkerPort<SheetWorkerCommand, SheetWorkerAnswer>(({ id, args }) => {
        if (args.type === `load`) {
            return { id, result: { type: `loaded`, names: [`Summary`, `Data`] } };
        }
        return args.name === `Summary` ? { id, result: { type: `rendered`, rows: [[`summary`, 1]] } } : { id, error: `Sheet "${args.name}" does not exist.` };
    });

describe(`spreadsheet worker client`, () => {
    it(`hands the workbook over rather than copying it, and reads sheets back from the worker that parsed it`, async () => {
        const worker = workbook();
        const client = createSheetWorkerClient(async () => worker);
        const buffer = new ArrayBuffer(8);

        await expect(client.load(buffer)).resolves.toEqual([`Summary`, `Data`]);
        expect(worker.transferred[0]).toEqual([buffer]);
        await expect(client.render(`Summary`)).resolves.toEqual([[`summary`, 1]]);
    });

    it(`says what the worker could not do in its own words, with no second try on the page`, async () => {
        const client = createSheetWorkerClient(async () => workbook());
        await expect(client.render(`Missing`)).rejects.toThrow(`Sheet "Missing" does not exist.`);
    });

    it(`ends the worker when closed`, async () => {
        const worker = workbook();
        const client = createSheetWorkerClient(async () => worker);
        await client.load(new ArrayBuffer(8));
        client.close();
        await Promise.resolve();
        expect(worker.terminated).toBe(true);
    });
});
