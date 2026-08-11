import { describe, expect, it } from "vitest";
import type { SheetWorkerRequest, SheetWorkerResponse } from "./sheetProtocol";
import { createSheetWorkerClient, type SheetWorkerPort } from "./sheetWorkerClient";

class FakeWorker implements SheetWorkerPort {
    readonly sent: { message: SheetWorkerRequest; transfer?: Transferable[] }[] = [];
    terminated = false;
    private message?: (event: MessageEvent<SheetWorkerResponse>) => void;
    private error?: (event: ErrorEvent) => void;

    postMessage(message: SheetWorkerRequest, transfer?: Transferable[]): void {
        this.sent.push({ message, transfer });
    }

    addEventListener(type: `message`, listener: (event: MessageEvent<SheetWorkerResponse>) => void): void;
    addEventListener(type: `error`, listener: (event: ErrorEvent) => void): void;
    addEventListener(
        type: `message` | `error`,
        listener: ((event: MessageEvent<SheetWorkerResponse>) => void) | ((event: ErrorEvent) => void),
    ): void {
        if (type === `message`) {
            this.message = listener as (event: MessageEvent<SheetWorkerResponse>) => void;
            return;
        }
        this.error = listener as (event: ErrorEvent) => void;
    }

    removeEventListener(type: `message`, listener: (event: MessageEvent<SheetWorkerResponse>) => void): void;
    removeEventListener(type: `error`, listener: (event: ErrorEvent) => void): void;
    removeEventListener(type: `message` | `error`, listener: unknown): void {
        if (type === `message` && this.message === listener) {
            this.message = undefined;
        }
        if (type === `error` && this.error === listener) {
            this.error = undefined;
        }
    }

    terminate(): void {
        this.terminated = true;
    }

    respond(response: SheetWorkerResponse): void {
        this.message?.({ data: response } as MessageEvent<SheetWorkerResponse>);
    }
}

describe(`spreadsheet worker client`, () => {
    it(`transfers the workbook and correlates sheet responses by request id`, async () => {
        const worker = new FakeWorker();
        const client = createSheetWorkerClient(worker);
        const buffer = new ArrayBuffer(8);

        const loading = client.load(buffer);
        expect(worker.sent[0]?.transfer).toEqual([buffer]);
        worker.respond({ id: worker.sent[0]!.message.id, type: `loaded`, names: [`Summary`, `Data`] });
        await expect(loading).resolves.toEqual([`Summary`, `Data`]);

        // Answered out of order on purpose: the client correlates by request id, not by arrival.
        const summary = client.render(`Summary`);
        const data = client.render(`Data`);
        worker.respond({ id: worker.sent[2]!.message.id, type: `rendered`, rows: [[`data`, 2]] });
        worker.respond({ id: worker.sent[1]!.message.id, type: `rendered`, rows: [[`summary`, 1]] });
        await expect(summary).resolves.toEqual([[`summary`, 1]]);
        await expect(data).resolves.toEqual([[`data`, 2]]);

        client.close();
        expect(worker.terminated).toBe(true);
    });
});
