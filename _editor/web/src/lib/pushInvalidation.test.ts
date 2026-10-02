import { QueryClient, QueryObserver } from "@tanstack/vue-query";
import { invalidatePushedQueries } from "./pushInvalidation";

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

test("push bursts let a slow read land and queue one catch-up", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
    const key = ["slow"];
    client.setQueryData(key, "cached");
    const pending: ((value: string) => void)[] = [];
    const observer = new QueryObserver(client, {
        queryKey: key,
        queryFn: () => new Promise<string>((resolve) => pending.push(resolve)),
    });
    const unsubscribe = observer.subscribe(() => undefined);
    try {
        void invalidatePushedQueries(client, { queryKey: key });
        await tick();
        for (let frame = 0; frame < 5; frame += 1) {
            void invalidatePushedQueries(client, { queryKey: key });
            await tick();
        }
        pending[0]!("first read");
        await tick();
        expect(client.getQueryData<string>(key)).toBe("first read");
        expect(pending).toHaveLength(2);
        pending[1]!("caught up");
        await tick();
        expect(client.getQueryData<string>(key)).toBe("caught up");
        expect(pending).toHaveLength(2);
    } finally {
        unsubscribe();
        client.clear();
    }
});


test("a push joining a mounting read catches up after that snapshot lands", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
    const key = ["mounting", "sandbox"];
    const pending: ((value: string) => void)[] = [];
    const observer = new QueryObserver(client, {
        queryKey: key,
        queryFn: () => new Promise<string>((resolve) => pending.push(resolve)),
    });
    const unsubscribe = observer.subscribe(() => undefined);
    try {
        void invalidatePushedQueries(client, { queryKey: ["mounting"] });
        pending[0]!("before push");
        await tick();
        expect(client.getQueryData<string>(key)).toBe("before push");
        expect(pending).toHaveLength(2);
        pending[1]!("after push");
        await tick();
        expect(client.getQueryData<string>(key)).toBe("after push");
    } finally {
        unsubscribe();
        client.clear();
    }
});

test("overlapping prefixes queue one catch-up for the actual query", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
    const key = ["overlap", "sandbox"];
    client.setQueryData(key, "cached");
    const pending: ((value: string) => void)[] = [];
    const observer = new QueryObserver(client, {
        queryKey: key,
        queryFn: () => new Promise<string>((resolve) => pending.push(resolve)),
    });
    const unsubscribe = observer.subscribe(() => undefined);
    try {
        void invalidatePushedQueries(client);
        await tick();
        void invalidatePushedQueries(client, { queryKey: ["overlap"] });
        void invalidatePushedQueries(client, { queryKey: key, exact: true });
        await tick();
        expect(pending).toHaveLength(1);
        pending[0]!("first");
        await tick();
        expect(client.getQueryData<string>(key)).toBe("first");
        expect(pending).toHaveLength(2);
        pending[1]!("latest");
        await tick();
        expect(client.getQueryData<string>(key)).toBe("latest");
        expect(pending).toHaveLength(2);
    } finally {
        unsubscribe();
        client.clear();
    }
});


test("a slow sibling in a broad invalidation cannot hold back another query's catch-up", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
    const key = ["siblings", "first"];
    const slowKey = ["siblings", "slow"];
    client.setQueryData(key, "cached");
    client.setQueryData(slowKey, "cached");
    const pending: ((value: string) => void)[] = [];
    const first = new QueryObserver(client, {
        queryKey: key,
        queryFn: () => new Promise<string>((resolve) => pending.push(resolve)),
    });
    const slow = new QueryObserver(client, {
        queryKey: slowKey,
        queryFn: () => new Promise<string>(() => undefined),
    });
    const stopFirst = first.subscribe(() => undefined);
    const stopSlow = slow.subscribe(() => undefined);
    try {
        void invalidatePushedQueries(client, { queryKey: ["siblings"] });
        await tick();
        void invalidatePushedQueries(client, { queryKey: key });
        await tick();
        pending[0]!("first");
        await tick();
        expect(client.getQueryData<string>(key)).toBe("first");
        expect(pending).toHaveLength(2);
        pending[1]!("caught up");
        await tick();
        expect(client.getQueryData<string>(key)).toBe("caught up");
        expect(client.getQueryState(slowKey)?.fetchStatus).toBe("fetching");
    } finally {
        stopFirst();
        stopSlow();
        client.clear();
    }
});


test("a push during an inactive prefetch leaves its landed snapshot stale", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
    const key = ["prefetch"];
    const pending: ((value: string) => void)[] = [];
    const queryFn = jest.fn(() => new Promise<string>((resolve) => pending.push(resolve)));
    try {
        const reading = client.fetchQuery({ queryKey: key, queryFn });
        void invalidatePushedQueries(client, { queryKey: key });
        pending[0]!("before push");
        await reading;
        await tick();
        expect(client.getQueryData<string>(key)).toBe("before push");
        expect(client.getQueryState(key)?.isInvalidated).toBe(true);
        expect(queryFn).toHaveBeenCalledTimes(1);
    } finally {
        client.clear();
    }
});
