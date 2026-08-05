import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Logger, pino } from "pino";
import { expect, test } from "vitest";
import { claimContainerHome } from "./home-owner.js";

const CONTAINER = { workspaceRoot: "/work", historyRoot: "/history" };
const DEV_RUN = { workspaceRoot: "/tmp/sbx/work", historyRoot: "/tmp/sbx/history" };

const setup = async (): Promise<{ home: string; lines: object[]; logger: Logger }> => {
    const home = await mkdtemp(join(tmpdir(), "home-owner-"));
    const lines: object[] = [];
    const logger = pino({ level: "debug" }, { write: (line: string) => void lines.push(JSON.parse(line) as object) });
    return { home, lines, logger };
};

const claimOf = async (home: string): Promise<object> => JSON.parse(await readFile(join(home, ".intentic-daemon.json"), "utf8")) as object;

// A pid that is certainly gone: a process that has already exited. `pid: 0`/a made-up number would test the
// same branch by accident rather than by construction.
const deadPid = (): number => spawnSync(process.execPath, ["-e", ""]).pid;

test("a fresh HOME is claimed quietly, and a restart on the same roots keeps it", async () => {
    const { home, lines, logger } = await setup();

    expect(claimContainerHome(CONTAINER, logger, home)).toBe(true);
    expect(await claimOf(home)).toEqual({ pid: process.pid, ...CONTAINER });

    // The predecessor may still be shutting down when its replacement boots, so ROOTS decide, not the pid —
    // a live claim on this run's own roots is this run's own state and must never lock the restart out.
    await writeFile(join(home, ".intentic-daemon.json"), JSON.stringify({ pid: process.pid, ...CONTAINER }));
    expect(claimContainerHome(CONTAINER, logger, home)).toBe(true);
    expect(lines).toEqual([]);
});

test("a second live daemon on its own roots is refused the container's HOME", async () => {
    const { home, lines, logger } = await setup();
    // The live daemon claimed it first (this test process stands in as the live owner).
    await writeFile(join(home, ".intentic-daemon.json"), JSON.stringify({ pid: process.pid, ...CONTAINER }));

    expect(claimContainerHome(DEV_RUN, logger, home)).toBe(false);

    // Refused means UNTOUCHED: the owner still holds the claim, so its next boot still converges HOME.
    expect(await claimOf(home)).toEqual({ pid: process.pid, ...CONTAINER });
    expect(lines).toHaveLength(1);
    expect(JSON.stringify(lines[0])).toContain("another live daemon owns this container's HOME");
});

test("a claim left by a daemon that is gone is taken over", async () => {
    const { home, logger } = await setup();
    await writeFile(join(home, ".intentic-daemon.json"), JSON.stringify({ pid: deadPid(), ...DEV_RUN }));

    expect(claimContainerHome(CONTAINER, logger, home)).toBe(true);
    expect(await claimOf(home)).toEqual({ pid: process.pid, ...CONTAINER });
});

test("an unreadable claim never blocks a boot", async () => {
    const { home, logger } = await setup();
    await writeFile(join(home, ".intentic-daemon.json"), "{ not json");

    expect(claimContainerHome(CONTAINER, logger, home)).toBe(true);
    expect(await claimOf(home)).toEqual({ pid: process.pid, ...CONTAINER });
});

test("a HOME that cannot hold the claim converges nothing", async () => {
    const { lines, logger } = await setup();

    expect(claimContainerHome(CONTAINER, logger, join(tmpdir(), "home-owner-missing", "nope"))).toBe(false);
    expect(JSON.stringify(lines[0])).toContain("could not claim this container's HOME");
});
