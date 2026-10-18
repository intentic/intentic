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
    expect(JSON.parse(await ask(path))).toEqual({ liveTurns: 0, at: expect.any(Number), quietSince: 1_000, nextWakeAt: 9_000_000, personAt: 0 });
    at = 3_000_000;
    expect(JSON.parse(await ask(path))).toEqual({ liveTurns: 0, at: expect.any(Number), quietSince: 1_000, nextWakeAt: 3_000_000, personAt: 0 });
    at = 0;
    expect(JSON.parse(await ask(path))).toEqual({ liveTurns: 0, at: expect.any(Number), quietSince: 1_000, personAt: 0 });
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
    expect(watch.read()).toEqual({ nextWakeAt: 9_000_000, personAt: 0 });
});
