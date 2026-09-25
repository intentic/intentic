// Pins what a runner's row says about the work this sandbox sends it: the kinds that go there, and its last run.
import type { OffloadRecord } from "@intentic/sandbox-contract";
import { lastRun, sentTo } from "./runnerWork";

const kinds = [
    { id: `bun-test`, pattern: `bun test` },
    { id: `my-build`, pattern: `make` },
];

describe(`a runner's row`, () => {
    test(`names the kinds sent there in words, the check after landing last, and nothing for a runner nothing goes to`, () => {
        const offload = { commands: { "bun-test": `runner-omen`, "my-build": `runner-omen`, vitest: `runner-rog` }, landCheck: `runner-omen` };
        expect(sentTo(`runner-omen`, offload, kinds)).toEqual([`Test runs (bun test)`, `my-build`, `Check after landing`]);
        expect(sentTo(`runner-other`, offload, kinds)).toEqual([]);
        expect(sentTo(`runner-omen`, undefined, kinds)).toEqual([]);
    });

    test(`says how its newest run ended, or that it is still going`, () => {
        const run = (over: Partial<OffloadRecord>): OffloadRecord => ({ runId: `r`, runner: `runner-omen`, name: `omen`, label: `bun-test`, command: `pnpm test`, startedAt: 1, ...over });
        expect(lastRun(`runner-omen`, [])).toBeUndefined();
        expect(lastRun(`runner-omen`, [run({})])).toBe(`Running now: pnpm test`);
        expect(lastRun(`runner-omen`, [run({ endedAt: 2, code: 0 })])).toBe(`Last: pnpm test, passed`);
        expect(lastRun(`runner-omen`, [run({ endedAt: 2, code: 3 })])).toBe(`Last: pnpm test, exited 3`);
    });
});
