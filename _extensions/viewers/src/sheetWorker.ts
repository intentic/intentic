import readXlsxFile from "read-excel-file/web-worker";
import { isOdfSpreadsheet, readOdsBook } from "./odf/sheet";
import { toRows } from "./sheetCells";
import type { SheetRows, SheetWorkerRequest, SheetWorkerResponse } from "./sheetProtocol";

/* oxlint-disable unicorn/require-post-message-target-origin -- dedicated-worker postMessage has no target origin */

/* One workbook lives with one viewer worker, parsed once on `load` and served from memory after that. */
const sheets = new Map<string, SheetRows>();

// Which spreadsheet this is comes from the bytes, not from the file's name: a mislabelled .xlsx that is really an
// .ods still opens, and the sniff costs 30 bytes.
const parse = async (buffer: ArrayBuffer): Promise<readonly { readonly name: string; readonly data: readonly (readonly unknown[])[] }[]> => {
    const bytes = new Uint8Array(buffer);
    if (isOdfSpreadsheet(bytes)) {
        return readOdsBook(bytes);
    }
    return (await readXlsxFile(buffer)).map(({ sheet, data }) => ({ name: sheet, data }));
};

const load = async (buffer: ArrayBuffer): Promise<string[]> => {
    const parsed = await parse(buffer);
    sheets.clear();
    for (const { name, data } of parsed) {
        sheets.set(name, toRows(data));
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
        // Parsing is async now, so a throw here lands in a rejected promise rather than the catch below, the
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
