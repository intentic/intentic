import { beforeAll, jest } from "bun:test";

// Loaded once per test file through each package's bunfig.toml: the suite budget the projects split used to carry.

// The kind is in the file name, as UNIT_SUITE/INTEGRATION_SUITE keyed it: `*.integration.test.ts` and
// `*.e2e.test.ts` reach for the machine, everything else is a hang detector.
const INTEGRATION_NAME = /\.(integration|e2e)\.test\.[cm]?[jt]sx?$/;

// Purely a hang detector: nothing in a unit suite waits on anything, so 20s bounds a hang, not real latency.
export const UNIT_TIMEOUT_MS = 20_000;

// Real work on a shared machine: 120s bounds a hang well clear of latency, room for two 30s waitFor SETTLES.
export const INTEGRATION_TIMEOUT_MS = 120_000;

export const budgetFor = (file: string): number => (INTEGRATION_NAME.test(file) ? INTEGRATION_TIMEOUT_MS : UNIT_TIMEOUT_MS);

beforeAll(() => {
    jest.setTimeout(budgetFor(Bun.main));
});
