import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearStandby, hostWords, readStandby, readTakeoverNow, standbyAtBoot, standbyNotice, standbyTurn, writeStandby } from "./standby.js";

// Which copy of a sandbox runs it (standby.ts): the two files on /history/.ic and what an announce's answer asks.

const historyRoot = (): string => {
    const root = mkdtempSync(join(tmpdir(), "standby-"));
    mkdirSync(join(root, ".ic"));
    return root;
};
const activeHost = { host: "z440", os: "linux", manager: "compose" as const, since: "2026-11-11T12:00:00.000Z" };

describe("standbyTurn", () => {
    it("enters standby only on an explicit no, and leaves it only on an explicit yes", () => {
        expect(standbyTurn(false, false)).toBe("enter");
        expect(standbyTurn(true, true)).toBe("leave");
        expect(standbyTurn(true, false)).toBeUndefined();
        expect(standbyTurn(false, true)).toBeUndefined();
        // An older platform, or a copy it cannot place, says nothing: nothing changes either way.
        expect(standbyTurn(undefined, false)).toBeUndefined();
        expect(standbyTurn(undefined, true)).toBeUndefined();
    });
});

describe("the standby record", () => {
    it("is written, read back and cleared, and a boot holds to it", async () => {
        const root = historyRoot();
        expect(await standbyAtBoot(root)).toBeUndefined();
        await writeStandby(root, { v: 1, since: 5, activeHost, activeEpoch: 2 });
        expect(await readStandby(root)).toEqual({ v: 1, since: 5, activeHost, activeEpoch: 2 });
        expect(await standbyAtBoot(root)).toEqual({ v: 1, since: 5, activeHost, activeEpoch: 2 });
        await clearStandby(root);
        expect(await readStandby(root)).toBeUndefined();
    });

    // `ic sandbox claim` left a takeover the daemon has not announced yet: this copy is the one asked to run.
    it("is overridden at boot by a takeover waiting to be announced", async () => {
        const root = historyRoot();
        await writeStandby(root, { v: 1, since: 5 });
        writeFileSync(join(root, ".ic/takeover.json"), JSON.stringify({ v: 1, at: 9, by: "claim" }));
        expect(await standbyAtBoot(root)).toBeUndefined();
    });

    it("reads a malformed file as none", async () => {
        const root = historyRoot();
        writeFileSync(join(root, ".ic/standby.json"), "{half");
        writeFileSync(join(root, ".ic/takeover.json"), JSON.stringify({ v: 2 }));
        expect(await readStandby(root)).toBeUndefined();
        expect(readTakeoverNow(root)).toBeUndefined();
        expect(readTakeoverNow("")).toBeUndefined();
    });
});

describe("standbyNotice", () => {
    it("names the machine and side that run the sandbox", () => {
        expect(standbyNotice(activeHost)).toBe("This copy is on standby: z440 (linux) runs this sandbox");
        expect(hostWords(undefined)).toBe("another machine");
    });
});
