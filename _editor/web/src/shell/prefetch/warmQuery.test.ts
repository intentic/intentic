import { queryClient } from "../../lib/queryPersistence";
import { SandboxHttpError, wordsOf } from "../../client/sandbox/sandboxHttpError";
import { heldInCache, warmQuery } from "./warmQuery";

/* THE ONE PROPERTY EVERY WISH IN THE APP RESTS ON: reading a wish fills the entry that wish says it is satisfied by. */

const KEY = [`test`, `warm`];

describe(`a warm wish`, () => {
    beforeEach(() => {
        queryClient.clear();
    });

    it(`lands its answer in the very entry the screen reads, so the click finds it sitting there`, async () => {
        const wish = warmQuery(`w`, `rail`, { queryKey: KEY, queryFn: () => Promise.resolve({ chores: 3 }) });

        expect(wish.have()).toBe(false);
        await wish.read();

        expect(wish.have()).toBe(true);
        expect<unknown>(queryClient.getQueryData(KEY)).toEqual({ chores: 3 });
    });

    // The loader must neither pause for a refusal (three in a row cooled it off for half a minute) nor pick the wish
    // again on its next beat: the person's access answered it, and asking again would only be refused again.
    it(`counts a read the person's access refuses as answered, not as a failure to pause for`, async () => {
        const refused = new SandboxHttpError(403, `maintainer access required`, wordsOf({ error: `maintainer access required`, floor: `maintainer`, reason: `floor` }));
        const wish = warmQuery(`w`, `rail`, { queryKey: KEY, queryFn: () => Promise.reject(refused) });

        await wish.read();

        expect(wish.have()).toBe(true);
        expect(heldInCache(KEY)).toBe(true);
    });

    it(`still fails, and stays wanted, for any other failure`, async () => {
        const wish = warmQuery(`w`, `rail`, { queryKey: KEY, queryFn: () => Promise.reject(new Error(`The sandbox is restarting.`)) });

        await expect(wish.read()).rejects.toThrow(`The sandbox is restarting.`);
        expect(wish.have()).toBe(false);
    });

    it(`joins a read already in flight instead of opening a second one beside it`, async () => {
        const queryFn = jest.fn(() => Promise.resolve(`body`));
        const wish = warmQuery(`w`, `rail`, { queryKey: KEY, queryFn });

        // The loader's read and a click landing on the same key mid-flight.
        await Promise.all([wish.read(), queryClient.fetchQuery({ queryKey: KEY, queryFn })]);

        expect(queryFn).toHaveBeenCalledTimes(1);
    });

    it(`hands the query its cache key, so a tree read can compare the answer with the entry it will replace`, async () => {
        const wish = warmQuery(`w`, `rail`, { queryKey: KEY, queryFn: async ({ queryKey }) => ({ readFor: queryKey }) });

        await wish.read();

        expect<unknown>(queryClient.getQueryData(KEY)).toEqual({ readFor: KEY });
    });

    it(`goes cold again the moment its answer is invalidated`, async () => {
        const wish = warmQuery(`w`, `rail`, { queryKey: KEY, queryFn: () => Promise.resolve(`body`) });
        await wish.read();

        await queryClient.invalidateQueries({ queryKey: KEY });

        // Present but stale is NOT in hand: the click would pay the refetch, which is the cost this removes.
        expect<unknown>(queryClient.getQueryData(KEY)).toBe(`body`);
        expect(wish.have()).toBe(false);
    });

    it(`asks once and gives up, rather than multiplying its own requests against a daemon having a moment`, async () => {
        const queryFn = jest.fn(() => Promise.reject(new Error(`daemon said no`)));
        const wish = warmQuery(`w`, `rail`, { queryKey: KEY, queryFn });

        await expect(wish.read()).rejects.toThrow(`daemon said no`);

        expect(queryFn).toHaveBeenCalledTimes(1);
        // Nothing cached, so the click that follows asks again for real and shows the user what went wrong.
        expect(wish.have()).toBe(false);
    });

    it(`carries its surface's own caching terms rather than a second opinion`, async () => {
        const queryFn = jest.fn(() => Promise.resolve(`body`));
        const wish = warmQuery(`w`, `now`, { queryKey: KEY, queryFn, staleTime: Infinity });

        await wish.read();
        // Warm, and immutable until something invalidates it: a second warm costs no round trip.
        await wish.read();

        expect(queryFn).toHaveBeenCalledTimes(1);
    });
});

describe(`heldInCache`, () => {
    beforeEach(() => {
        queryClient.clear();
    });

    it(`is false for a key nothing has ever read`, () => {
        expect(heldInCache([`never`, `asked`])).toBe(false);
    });
});
