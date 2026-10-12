// An optimistic edit is on the cached entry before the call returns, stays when the write lands, and is taken back to
// exactly what was there when the write fails.
import { QueryClient } from "@tanstack/vue-query";
import { changedFields, optimisticUpdate, restoreFields, restoreRows } from "./optimistic";

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

// A push lands on the same entry while the write is out. Restoring the whole snapshot would wipe it; a per-row undo
// takes back only the row this edit touched.
interface Run {
    readonly id: string;
    readonly state: string;
}
const runId = (run: Run): string => run.id;

test("a per-row undo takes back only its own row and keeps what a push changed meanwhile", async () => {
    const client = new QueryClient();
    client.setQueryData<Run[]>(KEY, [
        { id: `a`, state: `ended` },
        { id: `b`, state: `running` },
    ]);
    const answer = Promise.withResolvers<void>();
    const failing = optimisticUpdate<Run[], void>(
        KEY,
        (runs) => runs.map((run) => (run.id === `a` ? { ...run, state: `archived` } : run)),
        () => answer.promise,
        { client, undo: restoreRows(runId, [`a`]) },
    );
    // The push: `b` finished and a new run `c` started while the archive of `a` was out.
    client.setQueryData<Run[]>(KEY, (runs = []) => [...runs.map((run) => (run.id === `b` ? { ...run, state: `ended` } : run)), { id: `c`, state: `running` }]);
    answer.reject(new Error(`refused`));

    await expect(failing).rejects.toThrow(`refused`);
    expect(client.getQueryData<Run[]>(KEY)).toEqual([
        { id: `a`, state: `ended` },
        { id: `b`, state: `ended` },
        { id: `c`, state: `running` },
    ]);
});

test("a removed row comes back where it stood, and an added one goes away again", () => {
    const before: Run[] = [
        { id: `a`, state: `x` },
        { id: `b`, state: `x` },
        { id: `c`, state: `x` },
    ];
    const afterRemove = before.filter((run) => run.id !== `b`);
    expect(restoreRows(runId, [`b`])(afterRemove, before).map(runId)).toEqual([`a`, `b`, `c`]);
    expect(restoreRows(runId, [`n`])([...before, { id: `n`, state: `new` }], before).map(runId)).toEqual([`a`, `b`, `c`]);
});

test("a per-field undo puts back the fields a write changed and keeps the rest as they now are", () => {
    const before = { tone: `quiet`, depth: 1, theme: `dark` };
    const sent = { ...before, tone: `loud` };
    expect(changedFields(before, sent)).toEqual([`tone`]);
    // `depth` moved under the write (another write, a push); only `tone` is this write's to take back.
    expect(restoreFields<typeof before>(changedFields(before, sent))({ ...sent, depth: 2 }, before)).toEqual({ tone: `quiet`, depth: 2, theme: `dark` });
});
