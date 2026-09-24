// Pins when a worker call is answered by the worker and when by this thread instead, so a caller never waits forever.
import { waitFor } from "@intentic/testing/bun";
import { FakeWorker } from "../testing/fakeWorker";
import { createWorkerCall } from "./workerCall";

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
});
