import type { SheetRows, SheetWorkerCommand, SheetWorkerRequest, SheetWorkerResponse } from "./sheetProtocol";

export interface SheetWorkerPort {
    postMessage(message: SheetWorkerRequest, transfer?: Transferable[]): void;
    addEventListener(type: `message`, listener: (event: MessageEvent<SheetWorkerResponse>) => void): void;
    addEventListener(type: `error`, listener: (event: ErrorEvent) => void): void;
    removeEventListener(type: `message`, listener: (event: MessageEvent<SheetWorkerResponse>) => void): void;
    removeEventListener(type: `error`, listener: (event: ErrorEvent) => void): void;
    terminate(): void;
}

interface Pending {
    readonly resolve: (response: SheetWorkerResponse) => void;
    readonly reject: (error: Error) => void;
}

export const createSheetWorkerClient = (worker: SheetWorkerPort) => {
    const pending = new Map<number, Pending>();
    let requestId = 0;
    let closed = false;

    const onMessage = (event: MessageEvent<SheetWorkerResponse>): void => {
        const waiting = pending.get(event.data.id);
        if (waiting === undefined) {
            return;
        }
        pending.delete(event.data.id);
        if (event.data.type === `error`) {
            waiting.reject(new Error(event.data.message));
            return;
        }
        waiting.resolve(event.data);
    };
    const onError = (event: ErrorEvent): void => {
        const error = event.error instanceof Error ? event.error : new Error(event.message || `Spreadsheet worker failed.`);
        for (const waiting of pending.values()) {
            waiting.reject(error);
        }
        pending.clear();
        closed = true;
        worker.removeEventListener(`message`, onMessage);
        worker.removeEventListener(`error`, onError);
        worker.terminate();
    };
    worker.addEventListener(`message`, onMessage);
    worker.addEventListener(`error`, onError);

    const request = (message: SheetWorkerCommand, transfer?: Transferable[]): Promise<SheetWorkerResponse> => {
        if (closed) {
            return Promise.reject(new Error(`Spreadsheet worker is closed.`));
        }
        const id = ++requestId;
        return new Promise((resolve, reject) => {
            pending.set(id, { resolve, reject });
            const outgoing: SheetWorkerRequest =
                message.type === `load` ? { id, type: message.type, buffer: message.buffer } : { id, type: message.type, name: message.name };
            worker.postMessage(outgoing, transfer);
        });
    };

    return {
        async load(buffer: ArrayBuffer): Promise<readonly string[]> {
            const response = await request({ type: `load`, buffer }, [buffer]);
            if (response.type !== `loaded`) {
                throw new Error(`Spreadsheet worker returned an unexpected response.`);
            }
            return response.names;
        },
        async render(name: string): Promise<SheetRows> {
            const response = await request({ type: `render`, name });
            if (response.type !== `rendered`) {
                throw new Error(`Spreadsheet worker returned an unexpected response.`);
            }
            return response.rows;
        },
        close(): void {
            if (closed) {
                return;
            }
            closed = true;
            const error = new Error(`Spreadsheet worker closed.`);
            for (const waiting of pending.values()) {
                waiting.reject(error);
            }
            pending.clear();
            worker.removeEventListener(`message`, onMessage);
            worker.removeEventListener(`error`, onError);
            worker.terminate();
        },
    };
};
