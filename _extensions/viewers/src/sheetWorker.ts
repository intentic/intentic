import * as XLSX from "xlsx";
import type { SheetWorkerRequest, SheetWorkerResponse } from "./sheetProtocol";

/* oxlint-disable unicorn/require-post-message-target-origin -- dedicated-worker postMessage has no target origin */

/* One workbook lives with one viewer worker. Parsing happens once; sheets are converted to HTML only when the
 * reader selects them, so opening a many-sheet workbook pays for the first visible sheet rather than all of it. */
let workbook: XLSX.WorkBook | undefined;

self.addEventListener(`message`, (event: MessageEvent<SheetWorkerRequest>) => {
    const { id } = event.data;
    try {
        if (event.data.type === `load`) {
            workbook = XLSX.read(event.data.buffer, { type: `array` });
            self.postMessage({ id, type: `loaded`, names: workbook.SheetNames } satisfies SheetWorkerResponse);
            return;
        }

        const worksheet = workbook?.Sheets[event.data.name];
        if (worksheet === undefined) {
            throw new Error(`Sheet "${event.data.name}" does not exist.`);
        }
        self.postMessage({ id, type: `rendered`, html: XLSX.utils.sheet_to_html(worksheet) } satisfies SheetWorkerResponse);
    } catch (error) {
        self.postMessage({
            id,
            type: `error`,
            message: error instanceof Error ? error.message : `Could not read this spreadsheet.`,
        } satisfies SheetWorkerResponse);
    }
});
