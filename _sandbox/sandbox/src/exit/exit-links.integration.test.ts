import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExitConfig, IntenticLine } from "@intentic/sandbox-contract";

// A start that can't prove its country is taken back down, and its error is the only place that says whether that
// worked: a failed stop must not read as done, nor erase the reading of where the exit still comes out.

// HOME decides where the up marker and the observation land; a temp dir, so a run leaves nothing real.
process.env["HOME"] = mkdtempSync(join(tmpdir(), "exit-links-home-"));

const STOP_FAILURE = "could not stop tor (pid 4242): Operation not permitted";

jest.mock("./exit-drivers.js", () => ({
    exitDrivers: {
        tor: {
            missingTool: async () => undefined,
            async *start(): AsyncGenerator<IntenticLine> {
                yield { kind: "log", message: "up" };
            },
            observe: async () => ({ ip: "5.9.1.1", country: "US", countryName: "United States" }),
            stop: async () => {
                throw new Error(STOP_FAILURE);
            },
        },
    },
}));

const { proxyUrl, startExit, stopExit } = await import("./exit-links.js");
const { readObservation } = await import("./exit-state.js");

const entry = { id: "berlin", config: { provider: "tor", autoStart: "off" } as ExitConfig };

const drain = async (lines: AsyncGenerator<IntenticLine>): Promise<void> => {
    for await (const line of lines) {
        void line;
    }
};

test("a wrong-country start whose stop fails says it may still be running, never that it stopped", async () => {
    await expect(drain(startExit(entry, "DE"))).rejects.toThrow(
        `berlin was asked for Germany but came out in United States (5.9.1.1). Stopping it failed too (${STOP_FAILURE}), so it may still be running at ${proxyUrl("berlin")}.`,
    );
    // Still true of an exit that is still up: the card must go on saying where it comes out.
    expect((await readObservation("berlin"))?.seen).toEqual({ ip: "5.9.1.1", country: "US", countryName: "United States" });
});

test("a stop the driver could not carry out rejects instead of reporting the exit down", async () => {
    await expect(stopExit(entry)).rejects.toThrow(STOP_FAILURE);
});
