import { QueryClient, QueryObserver } from "@tanstack/vue-query";
import { CLAIM_BEAT_MS, createSiblingQueries, type SiblingNote, type SiblingQueries } from "./siblingQueries";

// Two editor windows on one origin: their own caches, one channel between them, delivered a task later as a
// BroadcastChannel delivers.
const bus = (holdWants = false) => {
    const sent: SiblingNote[] = [];
    const held: SiblingNote[] = [];
    const listeners: ((note: SiblingNote) => void)[] = [];
    const deliver = (note: SiblingNote): void => {
        for (const listener of listeners) {
            listener(note);
        }
    };
    const window = (id: string, sandbox: () => string | undefined = () => `sbx`): Window => {
        const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
        const sibling = createSiblingQueries({
            client,
            id,
            sandbox,
            visible: () => true,
            channel: {
                post: (note) => {
                    sent.push(structuredClone(note));
                    const copy = structuredClone(note);
                    if (holdWants && copy.kind === `want`) {
                        held.push(copy);
                    } else {
                        setTimeout(() => deliver(copy), 0);
                    }
                },
                listen: (heard) => listeners.push(heard),
            },
        });
        return { client, sibling };
    };
    return { sent, window, deliverWants: () => held.splice(0).forEach(deliver) };
};

interface Window {
    readonly client: QueryClient;
    readonly sibling: SiblingQueries;
}

// Past a window's listening beat after it says it is fetching, and every note that follows delivered.
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, CLAIM_BEAT_MS * 2));

// A view drawing `key` in this window, so the window counts as showing it.
const show = (window: Window, key: readonly unknown[]): (() => void) =>
    new QueryObserver(window.client, { queryKey: key, queryFn: () => Promise.resolve(`own`), enabled: false }).subscribe(() => undefined);

const deferred = <T>() => {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((done, fail) => {
        resolve = done;
        reject = fail;
    });
    return { promise, resolve, reject };
};

test("a read another window is already fetching is that window's answer, not a second call", async () => {
    const { window } = bus();
    const main = window(`main`);
    const chat = window(`chat`);
    await settle();
    const hide = show(chat, [`agents`]);
    const call = deferred<string>();
    const first = main.sibling.fetchShared([`agents`], () => call.promise);
    await settle();
    let asked = 0;
    const second = chat.sibling.fetchShared([`agents`], () => {
        asked += 1;
        return Promise.resolve(`chat's own`);
    });
    call.resolve(`roster`);
    expect(await first).toBe(`roster`);
    expect(await second).toBe(`roster`);
    expect(asked).toBe(0);
    hide();
});

test("a want delivered after the fetch ends still receives that fetch's answer", async () => {
    const { window, deliverWants } = bus(true);
    const main = window(`main`);
    const chat = window(`chat`);
    await settle();
    const hide = show(chat, [`agents`]);
    const call = deferred<string>();
    const first = main.sibling.fetchShared([`agents`], () => call.promise);
    await settle();
    let asked = 0;
    const second = chat.sibling.fetchShared([`agents`], () => {
        asked += 1;
        return Promise.resolve(`chat's own`);
    });
    call.resolve(`roster`);
    expect(await first).toBe(`roster`);
    deliverWants();
    expect(await second).toBe(`roster`);
    expect(asked).toBe(0);
    hide();
});

test("a want delivered after the fetch fails lets the waiting window fetch for itself", async () => {
    const { window, deliverWants } = bus(true);
    const main = window(`main`);
    const chat = window(`chat`);
    await settle();
    const call = deferred<string>();
    const first = main.sibling.fetchShared([`agents`], () => call.promise);
    await settle();
    const second = chat.sibling.fetchShared([`agents`], () => Promise.resolve(`chat's own`));
    call.reject(new Error(`daemon down`));
    await expect(first).rejects.toThrow(`daemon down`);
    deliverWants();
    expect(await second).toBe(`chat's own`);
});

test("an answer lands in a window showing the read, with the moment it was read", async () => {
    const { window } = bus();
    const main = window(`main`);
    const chat = window(`chat`);
    await settle();
    const hide = show(chat, [`ci`]);
    const call = deferred<string>();
    const fetched = main.sibling.fetchShared([`ci`], () => call.promise);
    await settle();
    call.resolve(`runs`);
    await fetched;
    await settle();
    expect(chat.client.getQueryData([`ci`])).toBe(`runs`);
    expect(chat.client.getQueryState([`ci`])?.dataUpdatedAt).toBeGreaterThan(0);
    hide();
});

test("nothing is sent to a window that is not showing the read", async () => {
    const { sent, window } = bus();
    const main = window(`main`);
    window(`chat`);
    await settle();
    await main.sibling.fetchShared([`chores`], () => Promise.resolve(`report`));
    await settle();
    expect(sent.filter((note) => note.kind === `answer`)).toHaveLength(0);
});

test("a joined fetch that fails sends the waiting window to the daemon itself", async () => {
    const { window } = bus();
    const main = window(`main`);
    const chat = window(`chat`);
    await settle();
    const call = deferred<string>();
    const first = main.sibling.fetchShared([`devices`], () => call.promise);
    await settle();
    const second = chat.sibling.fetchShared([`devices`], () => Promise.resolve(`chat's own`));
    await settle();
    call.reject(new Error(`daemon down`));
    await expect(first).rejects.toThrow(`daemon down`);
    expect(await second).toBe(`chat's own`);
});

test("a read is never joined across a change this window made since it started", async () => {
    const { window } = bus();
    const main = window(`main`);
    const chat = window(`chat`);
    await settle();
    const call = deferred<string>();
    const first = main.sibling.fetchShared([`changes`], () => call.promise);
    await settle();
    await chat.client.getMutationCache().build(chat.client, { mutationFn: () => Promise.resolve(`landed`) }).execute(undefined);
    expect(await chat.sibling.fetchShared([`changes`], () => Promise.resolve(`after the land`))).toBe(`after the land`);
    call.resolve(`before the land`);
    await first;
});

test("a read on another sandbox is never joined", async () => {
    const { window } = bus();
    const main = window(`main`, () => `one`);
    const chat = window(`chat`, () => `two`);
    await settle();
    const call = deferred<string>();
    const first = main.sibling.fetchShared([`panels`], () => call.promise);
    await settle();
    expect(await chat.sibling.fetchShared([`panels`], () => Promise.resolve(`two's panels`))).toBe(`two's panels`);
    call.resolve(`one's panels`);
    await first;
});

test("a window that leaves mid-fetch sends the windows waiting on it to the daemon", async () => {
    const { window } = bus();
    const main = window(`main`);
    const chat = window(`chat`);
    await settle();
    void main.sibling.fetchShared([`transcript`], () => new Promise<string>(() => undefined));
    await settle();
    const waiting = chat.sibling.fetchShared([`transcript`], () => Promise.resolve(`chat's own`));
    await settle();
    main.sibling.leave();
    expect(await waiting).toBe(`chat's own`);
    expect(chat.sibling.siblings()).toBe(0);
});

test("two windows polling the same read call the daemon about as often as one", async () => {
    const { window } = bus();
    const main = window(`main`);
    const chat = window(`chat`);
    await settle();
    let calls = 0;
    const poll = (side: Window): (() => void) =>
        new QueryObserver(side.client, {
            queryKey: [`usage`],
            queryFn: (context) =>
                side.sibling.fetchShared(context.queryKey, async () => {
                    calls += 1;
                    await new Promise((resolve) => setTimeout(resolve, 5));
                    return calls;
                }),
            refetchInterval: 40,
            refetchIntervalInBackground: true,
            staleTime: 0,
        }).subscribe(() => undefined);
    const stops = [poll(main), poll(chat)];
    await new Promise((resolve) => setTimeout(resolve, 420));
    for (const stop of stops) {
        stop();
    }
    // One window alone makes ~11 calls in this time (its first read and ~10 intervals); two unshared made twice that.
    expect(calls).toBeLessThanOrEqual(14);
    expect(calls).toBeGreaterThan(4);
});
