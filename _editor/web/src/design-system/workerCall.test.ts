// Pins when a worker call is answered by the worker and when by this thread instead, so a caller never waits forever.
import { waitFor } from "@intentic/testing/bun";
import { FakeWorker } from "@intentic/ui/testing";
import { createWorkerCall, WorkerCallError } from "@intentic/ui/worker-call";

const double = (value: number): number => value * 2;

describe(`createWorkerCall`, () => {
    it(`answers with the worker's result and runs nothing locally`, async () => {
        const worker = new FakeWorker<number, number>();
        const local = jest.fn(double);
        const call = createWorkerCall(async () => worker, local);

        const answer = call(21);
        await waitFor(() => expect(worker.sent).toEqual([{ id: 1, args: 21 }]));
        worker.respond({ id: 1, result: 42 });

        await expect(answer).resolves.toBe(42);
        expect(local).not.toHaveBeenCalled();
    });

    it(`falls back to this thread when the function throws in the worker`, async () => {
        const worker = new FakeWorker<number, number>();
        const call = createWorkerCall(async () => worker, double);

        const answer = call(4);
        await waitFor(() => expect(worker.sent).toHaveLength(1));
        worker.respond({ id: 1, error: `boom` });

        await expect(answer).resolves.toBe(8);
    });

    it(`answers every waiting call locally when the worker crashes, then builds a fresh one`, async () => {
        const crashed = new FakeWorker<number, number>();
        const fresh = new FakeWorker<number, number>();
        const workers = [crashed, fresh];
        const call = createWorkerCall(async () => workers.shift(), double);

        const first = call(1);
        const second = call(2);
        await waitFor(() => expect(crashed.sent).toHaveLength(2));
        crashed.crash(`out of memory`);

        await expect(Promise.all([first, second])).resolves.toEqual([2, 4]);
        expect(crashed.terminated).toBe(true);

        const third = call(3);
        await waitFor(() => expect(fresh.sent).toHaveLength(1));
        fresh.respond({ id: fresh.sent[0]!.id, result: 6 });
        await expect(third).resolves.toBe(6);
    });

    it(`runs locally when no worker can be built here`, async () => {
        const call = createWorkerCall<number, number>(async () => undefined, double);

        await expect(call(5)).resolves.toBe(10);
    });

    it(`refuses what the worker could not do when the caller says the page would only fail again`, async () => {
        const worker = new FakeWorker<number, number>();
        const local = jest.fn(double);
        const call = createWorkerCall(async () => worker, local, { final: (error) => error.message.startsWith(`invalid`) });

        const answer = call(4);
        await waitFor(() => expect(worker.sent).toHaveLength(1));
        worker.respond({ id: 1, error: `invalid zip data` });

        await expect(answer).rejects.toEqual(new WorkerCallError(`invalid zip data`));
        expect(local).not.toHaveBeenCalled();
    });

    it(`hands transferred buffers over, and has no page copy left to fall back on when the worker then dies`, async () => {
        const worker = new FakeWorker<ArrayBuffer, number>();
        const local = jest.fn((buffer: ArrayBuffer) => buffer.byteLength);
        const call = createWorkerCall(async () => worker, local, { transfer: (buffer) => [buffer] });
        const buffer = new ArrayBuffer(8);

        const answer = call(buffer);
        await waitFor(() => expect(worker.transferred).toEqual([[buffer]]));
        worker.crash(`out of memory`);

        await expect(answer).rejects.toThrow(`out of memory`);
        expect(local).not.toHaveBeenCalled();
    });

    it(`closing ends the worker and rejects what still waits, without running it on the page; the next call builds anew`, async () => {
        const closed = new FakeWorker<number, number>();
        const fresh = new FakeWorker<number, number>();
        const workers = [closed, fresh];
        const local = jest.fn(double);
        const call = createWorkerCall(async () => workers.shift(), local);

        const waiting = call(1);
        await waitFor(() => expect(closed.sent).toHaveLength(1));
        call.close();

        await expect(waiting).rejects.toThrow(`Worker closed.`);
        await waitFor(() => expect(closed.terminated).toBe(true));
        expect(local).not.toHaveBeenCalled();

        const next = call(3);
        await waitFor(() => expect(fresh.sent).toHaveLength(1));
        fresh.respond({ id: fresh.sent[0]!.id, result: 6 });
        await expect(next).resolves.toBe(6);
    });
});
