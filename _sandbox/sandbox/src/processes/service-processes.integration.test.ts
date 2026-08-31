import { mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unstubbed } from "@intentic/testing";
import type { Logger } from "pino";
import { afterEach, expect, test } from "vitest";
import { createServiceProcesses, type ServiceProcesses, serviceSession } from "./service-processes.js";

/* The supervisor against REAL processes, because everything it exists for — exits observed rather than
 * polled, groups killed as units, respawns that actually respawn — is exactly what a mocked child proves
 * nothing about. Timing is injected small so a crash loop costs milliseconds, not the shipping backoff. */

const logger = unstubbed<Logger>("logger", { warn: () => {}, error: () => {} });

const TIMING = { backoffStartMs: 40, backoffCapMs: 160, stableMs: 10_000, termGraceMs: 300 };

let supervisor: ServiceProcesses | undefined;
afterEach(() => {
    supervisor?.stopAll();
    supervisor = undefined;
});

const until = async (what: string, predicate: () => boolean, timeoutMs = 5_000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() > deadline) {
            throw new Error(`timed out waiting for ${what}`);
        }
        // oxlint-disable-next-line eslint/no-await-in-loop -- polling a live child IS the wait
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
};

const logsDir = (): string => mkdtempSync(join(tmpdir(), "svc-logs-"));

test("a service runs with its assigned PORT in the environment and its output in its log file", async () => {
    const dir = logsDir();
    supervisor = createServiceProcesses(dir, logger, TIMING);
    await supervisor.start("echo-port", { cwd: dir, command: `echo "listening on $PORT"; sleep 30` });
    const port = supervisor.portOf("echo-port");
    expect(port).toBeGreaterThan(0);
    expect(supervisor.running("echo-port")).toBe(true);
    expect(supervisor.logPathOf("echo-port")).toBe(join(dir, "echo-port.log"));
    // The child appends the line on its own clock; waiting for the content is waiting for the child.
    let log = "";
    await until("the log line to land", () => {
        void readFile(join(dir, "echo-port.log"), "utf8").then((text) => {
            log = text;
        });
        return log.includes(`listening on ${String(port)}`);
    });
});

test("a crashing service is respawned with the exit code on the record and the port kept stable", async () => {
    const dir = logsDir();
    supervisor = createServiceProcesses(dir, logger, TIMING);
    await supervisor.start("crasher", { cwd: dir, command: "exit 7" });
    const port = supervisor.portOf("crasher");
    await until("two respawns", () => (supervisor?.statusOf("crasher")?.restarts ?? 0) >= 2);
    const status = supervisor.statusOf("crasher");
    expect(status?.lastExitCode).toBe(7);
    // The port is assigned once per start(): the gateway poke and the deliver route hold it across respawns.
    expect(supervisor.portOf("crasher")).toBe(port);
    expect(serviceSession("crasher")).toBe("svc-crasher");
});

test("stop kills the whole process group and ends the respawning", async () => {
    const dir = logsDir();
    supervisor = createServiceProcesses(dir, logger, TIMING);
    // The service forks its own child (the `sleep`), the shape of a gateway with a helper process: stop must
    // take the group, not just the leader.
    await supervisor.start("looper", { cwd: dir, command: "sleep 30 & wait" });
    await until("it to run", () => supervisor?.running("looper") === true);
    supervisor.stop("looper");
    expect(supervisor.running("looper")).toBe(false);
    expect(supervisor.statusOf("looper")).toBeUndefined();
    // Long enough that a wrongly-surviving respawn timer would have fired several times over.
    await new Promise((resolve) => setTimeout(resolve, TIMING.backoffCapMs + 100));
    expect(supervisor.statusOf("looper")).toBeUndefined();
});

test("start is a no-op for a tracked key, including one sitting in backoff", async () => {
    const dir = logsDir();
    supervisor = createServiceProcesses(dir, logger, TIMING);
    await supervisor.start("once", { cwd: dir, command: "exit 1" });
    await until("the crash", () => supervisor?.running("once") === false);
    const before = supervisor.statusOf("once");
    await supervisor.start("once", { cwd: dir, command: "exit 1" });
    // Same entry, untouched: the supervisor already owns the retry; a second start must not double-spawn.
    expect(supervisor.statusOf("once")?.since).toBe(before?.since);
});
