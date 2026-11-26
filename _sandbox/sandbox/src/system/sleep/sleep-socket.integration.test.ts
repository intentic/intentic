import { mkdtemp, rm, stat } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pino } from "pino";
import { startQuietWatch, type QuietWatch } from "../quiet-watch.js";
import { quietProbesOf } from "../quiet-watch.testing.js";
import { startSleepSocket } from "./sleep-socket.js";

const logger = pino({ level: "silent" });
let dir: string;
let watch: QuietWatch | undefined;
let server: Awaited<ReturnType<typeof startSleepSocket>> | undefined;

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "sleep-probe-")); });
afterEach(async () => {
    watch?.stop();
    await server?.close();
    watch = undefined;
    server = undefined;
    await rm(dir, { recursive: true, force: true });
});

// The keeper's client: connect and read until EOF. Assertions parse the JSON response; no cached heartbeat is involved.
const ask = (path: string): Promise<string> => new Promise((resolve, reject) => {
    let body = "";
    const client = connect(path);
    client.on("error", reject);
    client.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    client.on("end", () => resolve(body));
});

test("the private socket confirms a new booking and a retiming without waiting for the minute poll", async () => {
    let at = 0;
    watch = startQuietWatch(quietProbesOf({ nextWakeAt: async () => at }), { logger, now: () => 1_000, checkMs: 1e9 });
    await watch.check();
    const path = join(dir, "sleep.sock");
    server = await startSleepSocket(watch, () => 0, logger, path);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    at = 9_000_000;
    const quiet = { quietSince: 1_000, unattendedSince: 1_000, personAt: 0, activeAt: 0 };
    expect(JSON.parse(await ask(path))).toEqual({ liveTurns: 0, at: expect.any(Number), ...quiet, nextWakeAt: 9_000_000 });
    at = 3_000_000;
    expect(JSON.parse(await ask(path))).toEqual({ liveTurns: 0, at: expect.any(Number), ...quiet, nextWakeAt: 3_000_000 });
    at = 0;
    expect(JSON.parse(await ask(path))).toEqual({ liveTurns: 0, at: expect.any(Number), ...quiet });
});

test("a failed fresh clock read returns an error instead of the previous quiet certificate", async () => {
    let failed = false;
    watch = startQuietWatch(quietProbesOf({ nextWakeAt: async () => {
        if (failed) { throw new Error("unreadable"); }
        return 9_000_000;
    } }), { logger, now: () => 1_000, checkMs: 1e9 });
    await watch.check();
    const path = join(dir, "sleep.sock");
    server = await startSleepSocket(watch, () => 0, logger, path);
    failed = true;
    expect(JSON.parse(await ask(path))).toEqual({ error: "could not confirm sleep" });
    expect(watch.read()).toEqual({ nextWakeAt: 9_000_000, personAt: 0, activeAt: 0 });
});

// The host's last word before a sleep for memory (ic `sandbox sleep --unattended`): an editor left alone for half an hour
// does not hold it awake, and somebody back at it does, whatever the minute-old heartbeat said.
test("an editor left alone lets the unattended answer stand; somebody back at it withdraws it in the very answer asked for", async () => {
    const MIN = 60_000;
    let clock = 0;
    let atIt = false;
    watch = startQuietWatch(quietProbesOf({ connected: () => 1, editorActiveAt: (now) => (atIt ? now : 5 * MIN) }), { logger, now: () => clock, checkMs: 1e9 });
    clock = 6 * MIN;
    await watch.check();
    const path = join(dir, "sleep.sock");
    server = await startSleepSocket(watch, () => 0, logger, path);
    clock = 90 * MIN;
    expect(JSON.parse(await ask(path))).toEqual({ liveTurns: 0, at: expect.any(Number), unattendedSince: 6 * MIN, personAt: 90 * MIN, activeAt: 5 * MIN });
    atIt = true;
    clock = 91 * MIN;
    expect(JSON.parse(await ask(path))).toEqual({ liveTurns: 0, at: expect.any(Number), personAt: 91 * MIN, activeAt: 91 * MIN });
});
