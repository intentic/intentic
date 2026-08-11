import readXlsxFile from "read-excel-file/web-worker";
import { toRows } from "./sheetCells";
import type { SheetRows, SheetWorkerRequest, SheetWorkerResponse } from "./sheetProtocol";

/* oxlint-disable unicorn/require-post-message-target-origin -- dedicated-worker postMessage has no target origin */

/* One workbook lives with one viewer worker, parsed once on `load` and served from memory after that.
 *
 * The reader is a PREVIEW, so it wants values rather than a spreadsheet engine: this reads the cells and the
 * sheet names, and deliberately does not carry formulas, merges or cell formatting across. What it buys for
 * that is the absence of an HTML-generation step — see sheetProtocol.ts for why a table built from values
 * beats a sanitised table built from markup the file chose. */
const sheets = new Map<string, SheetRows>();

const load = async (buffer: ArrayBuffer): Promise<string[]> => {
    const parsed = await readXlsxFile(buffer);
    sheets.clear();
    for (const { sheet, data } of parsed) {
        sheets.set(sheet, toRows(data));
    }
    return [...sheets.keys()];
};

self.addEventListener(`message`, (event: MessageEvent<SheetWorkerRequest>) => {
    const request = event.data;
    const { id } = request;
    const fail = (error: unknown): void => {
        self.postMessage({
            id,
            type: `error`,
            message: error instanceof Error ? error.message : `Could not read this spreadsheet.`,
        } satisfies SheetWorkerResponse);
    };

    if (request.type === `load`) {
        // Parsing is async now, so a throw here lands in a rejected promise rather than the catch below — the
        // handler stays sync and every failure funnels through `fail`.
        load(request.buffer)
            .then((names) => self.postMessage({ id, type: `loaded`, names } satisfies SheetWorkerResponse))
            .catch(fail);
        return;
    }

    const rows = sheets.get(request.name);
    if (rows === undefined) {
        fail(new Error(`Sheet "${request.name}" does not exist.`));
        return;
    }
    self.postMessage({ id, type: `rendered`, rows } satisfies SheetWorkerResponse);
});
