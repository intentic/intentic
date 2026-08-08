export type SheetWorkerCommand = { readonly type: `load`; readonly buffer: ArrayBuffer } | { readonly type: `render`; readonly name: string };

export type SheetWorkerRequest = SheetWorkerCommand & { readonly id: number };

export type SheetWorkerResponse =
    | { readonly id: number; readonly type: `loaded`; readonly names: string[] }
    | { readonly id: number; readonly type: `rendered`; readonly html: string }
    | { readonly id: number; readonly type: `error`; readonly message: string };
