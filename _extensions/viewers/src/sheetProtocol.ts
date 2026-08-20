/* The worker answers with DATA, not markup.
 *
 * It used to answer with an HTML table, which meant a workbook, a file the reader may have been sent by
 * anyone, decided what markup the app injected, and the only thing standing between the two was a sanitiser
 * call on the main thread. Rows of values cannot carry an event handler or a script tag, so the viewer renders
 * them with an ordinary template and the injection path is gone rather than filtered. */

// A cell as the reader sees it. Dates are formatted in the worker, off the main thread, so the only
// distinction that survives to the template is the one it renders differently: numbers align right.
export type SheetCell = string | number | boolean | null;

export type SheetRows = readonly (readonly SheetCell[])[];

export type SheetWorkerCommand = { readonly type: `load`; readonly buffer: ArrayBuffer } | { readonly type: `render`; readonly name: string };

export type SheetWorkerRequest = SheetWorkerCommand & { readonly id: number };

export type SheetWorkerResponse =
    | { readonly id: number; readonly type: `loaded`; readonly names: string[] }
    | { readonly id: number; readonly type: `rendered`; readonly rows: SheetRows }
    | { readonly id: number; readonly type: `error`; readonly message: string };
