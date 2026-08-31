import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HISTORY_ROOT, WORKSPACE_ROOT } from "@intentic/constants";
import { type Logger, pino } from "pino";
import { expect, test } from "vitest";
import { AGENT_SESSION_ENV, claimContainer } from "./container-owner.js";
import { processIdentity, type ProcessIdentity } from "./proc-stat.js";

const CONTAINER = { workspaceRoot: WORKSPACE_ROOT, historyRoot: HISTORY_ROOT };
const DEV_RUN = { workspaceRoot: "/tmp/sbx/work", historyRoot: "/tmp/sbx/history" };

const setup = async (): Promise<{ home: string; lines: object[]; logger: Logger }> => {
    const home = await mkdtemp(join(tmpdir(), "container-owner-"));
    const lines: object[] = [];
    const logger = pino({ level: "debug" }, { write: (line: string) => void lines.push(JSON.parse(line) as object) });
    return { home, lines, logger };
};

const claimFile = (home: string): string => join(home, ".intentic-daemon.json");
const claimOf = async (home: string): Promise<object> => JSON.parse(await readFile(claimFile(home), "utf8")) as object;
const self = (): ProcessIdentity => {
    const identity = processIdentity();
    if (identity === undefined) {
        throw new Error("procfs did not identify the test process");
    }
    return identity;
};
// This test process stands in as the live owner wherever a claim has to be one nobody may take.
const heldBy = async (home: string, roots: object): Promise<void> => writeFile(claimFile(home), JSON.stringify({ ...self(), ...roots }));

// A pid that is certainly gone: a process that has already exited. `pid: 0`/a made-up number would test the
// same branch by accident rather than by construction.
const deadPid = (): number => spawnSync(process.execPath, ["-e", ""]).pid;

test("a fresh container is claimed quietly, whole", async () => {
    const { home, lines, logger } = await setup();

    expect(await claimContainer(CONTAINER, logger, { home, env: {} })).toEqual({ container: true, roots: true });
    expect(await claimOf(home)).toEqual({ ...self(), ...CONTAINER });
    expect(lines).toEqual([]);
});

test("a live daemon on other roots keeps the container: the guest still owns the roots it was given", async () => {
    const { home, lines, logger } = await setup();
    await heldBy(home, CONTAINER);

    expect(await claimContainer(DEV_RUN, logger, { home, env: {}, graceMs: 0 })).toEqual({ container: false, roots: true });

    // Refused means UNTOUCHED: the owner still holds the claim, so its next boot still converges HOME.
    expect(await claimOf(home)).toEqual({ ...self(), ...CONTAINER });
    expect(lines[0]).toMatchObject({ level: 40 });
    expect(lines[0]).not.toHaveProperty("agentSession");
});

test("a live daemon on THESE roots keeps both: nothing of its state is this run's to converge", async () => {
    const { home, logger } = await setup();
    await heldBy(home, CONTAINER);

    expect(await claimContainer(CONTAINER, logger, { home, env: {}, graceMs: 0 })).toEqual({ container: false, roots: false });
});

test("a predecessor still shutting down is waited out rather than taken for a co-tenant", async () => {
    const { home, logger } = await setup();
    await heldBy(home, CONTAINER);
    // What a restart looks like from here: the claim goes when the previous process finally exits.
    setTimeout(() => void rm(claimFile(home)).catch(() => undefined), 150);

    expect(await claimContainer(CONTAINER, logger, { home, env: {}, graceMs: 5_000 })).toEqual({ container: true, roots: true });
    expect(await claimOf(home)).toEqual({ ...self(), ...CONTAINER });
});

test("a daemon started from inside an agent session is a guest even with nobody to collide with", async () => {
    const { home, lines, logger } = await setup();

    const role = await claimContainer(DEV_RUN, logger, { home, env: { [AGENT_SESSION_ENV]: "a1d1e787" } });

    // A run of the code, not a replacement sandbox: it owns its own roots and claims nothing container-wide:
    // and takes no claim, so the real daemon's next boot still finds the container free.
    expect(role).toEqual({ container: false, roots: true });
    await expect(claimOf(home)).rejects.toThrow();
    expect(lines[0]).toMatchObject({ agentSession: "a1d1e787" });
    expect(lines[0]).not.toHaveProperty("diedPid");
});

test("a claim left by a daemon that is gone is taken over", async () => {
    const { home, logger } = await setup();
    await writeFile(claimFile(home), JSON.stringify({ pid: deadPid(), startTimeTicks: 1, ...DEV_RUN }));

    expect(await claimContainer(CONTAINER, logger, { home, env: {} })).toEqual({ container: true, roots: true });
    expect(await claimOf(home)).toEqual({ ...self(), ...CONTAINER });
});

test("a recycled pid does not turn a dead daemon's claim into the new daemon's guest lock", async () => {
    const { home, logger } = await setup();
    const identity = self();
    await writeFile(claimFile(home), JSON.stringify({ ...identity, startTimeTicks: identity.startTimeTicks - 1, ...CONTAINER }));

    expect(await claimContainer(CONTAINER, logger, { home, env: {} })).toEqual({ container: true, roots: true });
    expect(await claimOf(home)).toEqual({ ...identity, ...CONTAINER });
});

test("an unreadable claim never blocks a boot", async () => {
    const { home, logger } = await setup();
    await writeFile(claimFile(home), "{ not json");

    expect(await claimContainer(CONTAINER, logger, { home, env: {} })).toEqual({ container: true, roots: true });
    expect(await claimOf(home)).toEqual({ ...self(), ...CONTAINER });
});

test("a HOME that cannot hold the claim converges nothing container-wide", async () => {
    const { lines, logger } = await setup();

    const role = await claimContainer(CONTAINER, logger, { home: join(tmpdir(), "container-owner-missing", "nope"), env: {} });

    expect(role).toEqual({ container: false, roots: true });
    expect(lines[0]).toMatchObject({ level: 40 });
    expect(lines[0]).not.toHaveProperty("agentSession");
});
