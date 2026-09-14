/* The worker answers with DATA, not markup. */

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
