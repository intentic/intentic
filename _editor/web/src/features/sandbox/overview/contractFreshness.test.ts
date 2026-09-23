import { SANDBOX_ROUTE_SHAPES } from "@intentic/sandbox-contract";
import { stubGlobal, unstubAllGlobals, mocked } from "@intentic/testing/bun";
import { contractUncompiled, readContractFreshness, resetContractFreshness, uncompiledRoutes } from "./contractFreshness";

// The dev server hands over the contract as the sandbox loads it — compiled — and this app is the source side by
// construction, so the diff here is the same one the sandbox's drift check runs, with the cause attached.

// Answers the freshness endpoint with a given compiled shape map, or a status for the failure cases.
const serve = (body: unknown, ok = true): void => {
    stubGlobal(
        `fetch`,
        jest.fn(() => Promise.resolve({ ok, json: () => Promise.resolve(body) } as Response)),
    );
};

const someRoute = Object.keys(SANDBOX_ROUTE_SHAPES)[0]!;

beforeEach(() => resetContractFreshness());

afterEach(() => unstubAllGlobals());

it(`reports nothing uncompiled while the compiled contract matches this app's`, async () => {
    serve({ compiled: { ...SANDBOX_ROUTE_SHAPES } });
    await readContractFreshness();
    expect(uncompiledRoutes.value).toEqual([]);
    expect(contractUncompiled.value).toBe(false);
});

it(`names a route the compiled contract shapes differently`, async () => {
    serve({ compiled: { ...SANDBOX_ROUTE_SHAPES, [someRoute]: `stale` } });
    await readContractFreshness();
    expect(uncompiledRoutes.value).toEqual([someRoute]);
    expect(contractUncompiled.value).toBe(true);
});

it(`counts a route the compiled contract does not have yet`, async () => {
    const { [someRoute]: _dropped, ...withoutIt } = SANDBOX_ROUTE_SHAPES;
    serve({ compiled: withoutIt });
    await readContractFreshness();
    expect(uncompiledRoutes.value).toEqual([someRoute]);
});

it(`leaves the question open when the dev server cannot answer`, async () => {
    serve({}, false);
    await readContractFreshness();
    // Not "compiled and fine": a production build serves no such route, and silence must not read as an all-clear.
    expect(uncompiledRoutes.value).toEqual([]);
    expect(contractUncompiled.value).toBe(false);
});

it(`leaves the question open when the fetch itself fails`, async () => {
    stubGlobal(
        `fetch`,
        jest.fn(() => Promise.reject(new Error(`offline`))),
    );
    await readContractFreshness();
    expect(contractUncompiled.value).toBe(false);
});

it(`asks once per page, however many disagreements arrive`, async () => {
    serve({ compiled: { ...SANDBOX_ROUTE_SHAPES } });
    await readContractFreshness();
    await readContractFreshness();
    await readContractFreshness();
    expect(mocked(fetch)).toHaveBeenCalledTimes(1);
});
