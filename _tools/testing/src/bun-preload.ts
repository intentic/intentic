import { beforeAll, jest } from "bun:test";
import { SUITE_TIMEOUTS, suiteKindOf } from "../../constants/src/test-suites.mjs";
import { guardModuleMocks } from "./module-mocks.js";

// The run's budget for a file started with plain `bun test` rather than `suites`.
beforeAll(() => {
    jest.setTimeout(SUITE_TIMEOUTS[suiteKindOf(Bun.main)]);
});

// Every module mock in every suite names a real module and stands in for all of it.
guardModuleMocks();
