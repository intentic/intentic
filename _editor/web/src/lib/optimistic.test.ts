// An optimistic edit is on the cached entry before the call returns, stays when the write lands, and is taken back to
// exactly what was there when the write fails.
import { QueryClient } from "@tanstack/vue-query";
import { optimisticUpdate } from "./optimistic";

const KEY = [`rows`];
const without = (row: string) => (rows: string[]): string[] => rows.filter((each) => each !== row);

const clientWith = (rows: string[] | undefined): QueryClient => {
    const client = new QueryClient();
    if (rows !== undefined) {
        client.setQueryData(KEY, rows);
    }
    return client;
};

test("the edit is on the entry inside the call, before anything is awaited", () => {
    const client = clientWith([`a`, `b`]);
    void optimisticUpdate(KEY, without(`a`), () => new Promise(() => undefined), { client });
    expect(client.getQueryData<string[]>(KEY)).toEqual([`b`]);
});

test("a write that lands keeps the edit and hands back its answer", async () => {
    const client = clientWith([`a`, `b`]);
    await expect(optimisticUpdate(KEY, without(`a`), async () => `gone`, { client })).resolves.toBe(`gone`);
    expect(client.getQueryData<string[]>(KEY)).toEqual([`b`]);
});

test("a failed write restores the list exactly, runs the rollback hook first, and still fails", async () => {
    const client = clientWith([`a`, `b`]);
    const seen: unknown[] = [];
    const failing = optimisticUpdate(
        KEY,
        without(`a`),
        async () => {
            throw new Error(`refused`);
        },
        { client, onRollback: () => seen.push(client.getQueryData<string[]>(KEY)) },
    );

    await expect(failing).rejects.toThrow(`refused`);
    expect({ seen, after: client.getQueryData<string[]>(KEY) }).toEqual({ seen: [[`b`]], after: [`a`, `b`] });
});

test("an entry nobody has read is left alone, and a failure leaves it unread", async () => {
    const client = clientWith(undefined);
    const change = jest.fn(without(`a`));
    await expect(
        optimisticUpdate(
            KEY,
            change,
            async () => {
                throw new Error(`refused`);
            },
            { client },
        ),
    ).rejects.toThrow(`refused`);
    expect({ changed: change.mock.calls.length, data: client.getQueryData<string[]>(KEY) }).toEqual({ changed: 0, data: undefined });
});

test("settling re-reads the entry whether the write landed or not", async () => {
    const client = clientWith([`a`, `b`]);
    const invalidate = jest.spyOn(client, `invalidateQueries`);

    await optimisticUpdate(KEY, without(`a`), async () => undefined, { client, settle: true });
    const refused = async (): Promise<never> => {
        throw new Error(`refused`);
    };
    await optimisticUpdate(KEY, without(`b`), refused, { client, settle: true }).catch(() => undefined);

    expect(invalidate.mock.calls).toEqual([[{ queryKey: KEY }], [{ queryKey: KEY }]]);
});
