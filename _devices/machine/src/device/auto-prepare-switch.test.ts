import { advanceTimersByTimeAsync } from "@intentic/testing/bun";

/* The owner's switch over auto-prepare is re-read every round, from a file that can fail to read. A round that cannot
   read it may be the round the switch is off, so it prepares nothing rather than guessing the switch is on. */

const reached: string[] = [];
jest.mock("../environments/machine.js", () => ({
    readMachineConfig: () => Promise.reject(new SyntaxError("machine.json: Unexpected token")),
}));
jest.mock("./tools/sandboxes.js", () => ({
    fleet: () => {
        reached.push("fleet");
        return Promise.resolve([]);
    },
    icInFlight: new Set<string>(),
    runIc: () => {
        reached.push("ic");
        return Promise.resolve({ code: 0, output: "" });
    },
}));
const { startAutoPrepare } = await import("./auto-prepare.js");

// Past the first round's latest start: five minutes after start, plus up to thirty of jitter.
const FIRST_ROUND_LATEST_MS = 36 * 60_000;

afterEach(() => jest.useRealTimers());

test("a machine config that does not read skips the round instead of preparing as if the switch were on", async () => {
    jest.useFakeTimers();
    const lines: string[] = [];
    const prepare = startAutoPrepare((line) => lines.push(line));
    await advanceTimersByTimeAsync(FIRST_ROUND_LATEST_MS);
    prepare.stop();

    expect(reached).toEqual([]);
    expect(lines).toEqual(["auto-prepare: skipped this round — machine.json: Unexpected token"]);
});
