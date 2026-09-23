import { beforeAll, jest } from "bun:test";
import { SUITE_TIMEOUTS, suiteKindOf } from "../../constants/src/test-suites.mjs";

// The run's budget for a file started with plain `bun test` rather than `suites`.
beforeAll(() => {
    jest.setTimeout(SUITE_TIMEOUTS[suiteKindOf(Bun.main)]);
});
