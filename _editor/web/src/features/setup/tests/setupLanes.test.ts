import { readOffer } from "../setupLanes";

describe(`one offer read`, () => {
    test(`records what the platform answered`, async () => {
        expect(await readOffer(async () => ({ enabled: true }), { enabled: false })).toEqual({ kind: `answered`, value: { enabled: true } });
    });

    // A platform without the route has answered: the feature is off here, and saying so needs no retry.
    test(`takes a missing route as the answer that the feature is off`, async () => {
        const off = Object.assign(new Error(`not found`), { code: `NOT_FOUND` });
        expect(await readOffer(() => Promise.reject(off), { enabled: false })).toEqual({ kind: `answered`, value: { enabled: false } });
    });

    test(`records a lost read as no answer at all, even one that throws before it is asked`, async () => {
        expect(await readOffer(() => Promise.reject(new Error(`timeout`)), { enabled: false })).toEqual({ kind: `unreachable` });
        const missing = (): Promise<{ enabled: boolean }> => {
            throw new TypeError(`hostedOffer is not a function`);
        };
        expect(await readOffer(missing, { enabled: false })).toEqual({ kind: `unreachable` });
    });

    test(`reads NOT_FOUND by code or by status, and nothing else, as the feature being off`, async () => {
        const answers = await Promise.all(
            [{ code: `NOT_FOUND` }, { status: 404 }, { code: `FORBIDDEN`, status: 403 }, `404`, undefined].map((err) =>
                readOffer(async (): Promise<boolean> => {
                    throw err;
                }, false),
            ),
        );
        expect(answers.map((read) => read.kind)).toEqual([`answered`, `answered`, `unreachable`, `unreachable`, `unreachable`]);
    });
});
