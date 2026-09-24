import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger } from "pino";
import { startBootProfile } from "./boot-profile.js";

// Only what the profile reports: a warn naming the kept file.
const recorder = (): { readonly logger: Logger; readonly warned: Record<string, unknown>[] } => {
    const warned: Record<string, unknown>[] = [];
    const logger = { warn: (fields: Record<string, unknown>) => warned.push(fields) } as unknown as Logger;
    return { logger, warned };
};

const until = async (done: () => boolean, ms = 5_000): Promise<void> => {
    const deadline = Date.now() + ms;
    while (!done()) {
        if (Date.now() > deadline) {
            throw new Error("timed out");
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
};

// Named so the profile can be searched for it: the function a stall is blamed on.
const stallTheLoop = (ms: number): void => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        // Burning the loop on purpose.
    }
};

describe(`the boot profile`, () => {
    it(`keeps a stall's profile, with the function that held the loop in it`, async () => {
        const dir = mkdtempSync(join(tmpdir(), "boot-profile-"));
        const { logger, warned } = recorder();
        startBootProfile(logger, dir, { windowMs: 600, stallMs: 150 });
        await new Promise((resolve) => setTimeout(resolve, 50));
        stallTheLoop(300);
        await until(() => warned.length > 0);
        const [file] = readdirSync(dir);
        expect(file).toMatch(/^boot-.*\.cpuprofile$/);
        expect(warned[0]).toMatchObject({ file: join(dir, file!) });
        const profile = JSON.parse(readFileSync(join(dir, file!), "utf8")) as { nodes: { callFrame: { functionName: string } }[] };
        expect(profile.nodes.some((node) => node.callFrame.functionName === "stallTheLoop")).toBe(true);
    });

    it(`keeps nothing from a boot the loop never stalled in`, async () => {
        const dir = mkdtempSync(join(tmpdir(), "boot-profile-"));
        const { logger } = recorder();
        startBootProfile(logger, dir, { windowMs: 200, stallMs: 5_000 });
        await new Promise((resolve) => setTimeout(resolve, 600));
        expect(readdirSync(dir)).toEqual([]);
    });

    it(`holds the newest three and removes older ones`, async () => {
        const dir = mkdtempSync(join(tmpdir(), "boot-profile-"));
        for (const day of ["01", "02", "03"]) {
            writeFileSync(join(dir, `boot-2026-01-${day}T00-00-00.000Z.cpuprofile`), "{}");
        }
        writeFileSync(join(dir, "daemon.log"), "");
        const { logger, warned } = recorder();
        startBootProfile(logger, dir, { windowMs: 300, stallMs: 50 });
        await new Promise((resolve) => setTimeout(resolve, 30));
        stallTheLoop(120);
        await until(() => warned.length > 0);
        const kept = readdirSync(dir).toSorted();
        expect(kept).toHaveLength(4);
        expect(kept).toContain("daemon.log");
        expect(kept).not.toContain("boot-2026-01-01T00-00-00.000Z.cpuprofile");
    });
});
