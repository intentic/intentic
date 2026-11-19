import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PERSON_RESERVE_BYTES, type RoomAnswer, waitWords } from "../memory-room.mjs";
import { belowFloor, biggestProcesses, floorWords, holdAtFloor, notStartedWords, START_FLOOR_BYTES } from "./memory-floor.mjs";

// (2026-11-19, the shinobi-society audit) "[memory-room] … still short of memory after 120s (0.1 GiB free) — starting
// anyway" was followed by the memory guard's SIGKILL; it killed 12 processes in 8 of 14 build sessions read closely.
// The floor's own functions first, then the `memory-room` command queue-run runs before every heavy command, against a
// stand-in for the daemon's room socket that answers as told: it starts what has room, starts what is short but above
// the floor, and holds what is below the floor until its ceiling, then exits 75 so queue-run does not start it.

const GIB = 1024 ** 3;
const CLI = join(import.meta.dirname, "..", "memory-room.mjs");
const short = (freeBytes: number | undefined, over: Partial<RoomAnswer> = {}): RoomAnswer => ({
    verdict: "refuse",
    waitedMs: 120_000,
    needBytes: 8 * GIB,
    freeBytes,
    reservedBytes: 0,
    source: "daemon",
    diagnosis: "Sandbox memory is low: 15.9 of 16.0 GiB used",
    ...over,
});

test("only a held command with less than a person's turn free is below the floor; an unmeasured sandbox never is", () => {
    expect(START_FLOOR_BYTES).toBe(PERSON_RESERVE_BYTES);
    expect(belowFloor(short(0.1 * GIB))).toBe(true);
    expect(belowFloor(short(1.5 * GIB))).toBe(false);
    expect(belowFloor(short(undefined))).toBe(false);
    expect(belowFloor({ verdict: "run", freeBytes: 0 })).toBe(false);
});

describe("holding a command below the floor", () => {
    // A clock the asks move: each ask takes the seconds it was given, after a first wait of two minutes.
    const harness = (answers: RoomAnswer[]) => {
        let clock = 120_000;
        const said: string[] = [];
        const asked: number[] = [];
        return {
            said,
            asked,
            options: {
                label: "cargo",
                say: (line: string) => said.push(line),
                startedAt: 0,
                now: () => clock,
                biggest: () => [{ pid: 42, name: "rustc", bytes: 3.2 * GIB, owner: "c-abc" }],
                sleep: async (ms: number) => void (clock += ms),
                ask: async (seconds: number) => {
                    asked.push(seconds);
                    clock += seconds * 1000;
                    return answers.shift() ?? short(0.1 * GIB);
                },
            },
        };
    };

    test("it keeps waiting, saying what holds the memory, and starts once there is room", async () => {
        const run = harness([short(0.2 * GIB), { ...short(9 * GIB), verdict: "run" }]);
        const ended = await holdAtFloor({ ...run.options, answer: short(0.1 * GIB, { waitedFor: "first" }), ceilingSeconds: 900 });
        expect(ended).toMatchObject({ verdict: "run", waitedMs: 240_000, waitedFor: "first" });
        expect(ended.notStarted).toBeUndefined();
        expect(run.asked).toEqual([60, 60]);
        expect(run.said).toHaveLength(2);
        expect(run.said[0]).toContain("[memory-room] cargo: holding it: 0.1 GiB free (Sandbox memory is low: 15.9 of 16.0 GiB used), under the 1.0 GiB");
        expect(run.said[0]).toContain("gives up without starting in 13m00s");
        expect(run.said[0]).toContain("rustc (pid 42, 3.2 GiB, conversation c-abc)");
    });

    test("above the floor, short of what it asked, it starts with what there is, as before", async () => {
        const run = harness([]);
        const ended = await holdAtFloor({ ...run.options, answer: short(2 * GIB), ceilingSeconds: 900 });
        expect(ended.notStarted).toBeUndefined();
        expect(run.asked).toEqual([]);
        expect(waitWords("cargo", ended)).toBe(
            "[memory-room] cargo: still short of memory after 120s (2.0 GiB free, above the 1.0 GiB floor it needs to start) — starting with what there is. Still: Sandbox memory is low: 15.9 of 16.0 GiB used.",
        );
    });

    test("still below the floor at its ceiling, it gives up without starting", async () => {
        const run = harness([]);
        const ended = await holdAtFloor({ ...run.options, answer: short(0.1 * GIB), ceilingSeconds: 270 });
        expect(ended).toMatchObject({ notStarted: true, waitedMs: 270_000 });
        expect(run.asked).toEqual([60, 60, 30]);
        expect(notStartedWords("cargo", ended, ended.waitedMs)).toBe(
            "[memory-room] cargo: not started: after 4m30s the sandbox still had 0.1 GiB free, under the 1.0 GiB a heavy command needs to start without being killed (Sandbox memory is low: 15.9 of 16.0 GiB used). Run it again once memory is free.",
        );
    });

    test("an ask that answers at once is not asked again in a loop", async () => {
        const run = harness([]);
        run.options.ask = async (seconds: number) => {
            run.asked.push(seconds);
            return short(0.1 * GIB);
        };
        await holdAtFloor({ ...run.options, answer: short(0.1 * GIB), ceilingSeconds: 132 });
        // 12 s of ceiling left, a 5 s pause after each instant answer: three asks, not thousands.
        expect(run.asked).toHaveLength(3);
    });
});

test("the words name the floor, the room asked for and the way out", () => {
    const line = floorWords("vitest", short(0.5 * GIB), { waitedMs: 30_000, ceilingMs: 900_000 });
    expect(line).toMatch(/it asks for 8\.0 GiB\)\. It starts by itself once there is room, and gives up without starting in 14m30s\. To make room: stop a background job or server you started, or send this to one of the owner's machines with `remote-run -- <command>` if one is connected\.$/u);
});

test("the biggest processes are read off procfs, largest first, with the conversation each runs for", async () => {
    const proc = await mkdtemp(join(tmpdir(), "memory-floor-proc-"));
    try {
        const add = async (pid: number, name: string, kib: number, owner?: string) => {
            await mkdir(join(proc, String(pid)));
            await writeFile(join(proc, String(pid), "status"), `Name:\t${name}\nVmRSS:\t${kib} kB\n`);
            await writeFile(join(proc, String(pid), "environ"), owner === undefined ? "PATH=/bin\0" : `PATH=/bin\0INTENTIC_TURN_OWNER=${owner}\0`);
        };
        await add(10, "node", 1024);
        await add(11, "rustc", 4 * 1024 * 1024, "c-1");
        await add(12, "cc1plus", 2 * 1024 * 1024);
        await mkdir(join(proc, "self"));
        expect(biggestProcesses(2, proc)).toEqual([
            { pid: 11, name: "rustc", bytes: 4 * GIB, owner: "c-1" },
            { pid: 12, name: "cc1plus", bytes: 2 * GIB, owner: undefined },
        ]);
    } finally {
        await rm(proc, { recursive: true, force: true });
    }
});

describe("the memory-room command", () => {
    let dir: string;
    let server: Server | undefined;
    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), "memory-floor-cli-"));
    });
    afterEach(async () => {
        await new Promise((resolve) => (server === undefined ? resolve(undefined) : server.close(resolve)));
        server = undefined;
        await rm(dir, { recursive: true, force: true });
    });

    // A room socket whose every `/room` answer is `answer`.
    const daemon = async (answer: object): Promise<string> => {
        const socket = join(dir, "room.sock");
        server = createServer((_request, response) => {
            response.writeHead(200, { "content-type": "application/json" });
            response.end(JSON.stringify(answer));
        });
        await new Promise<void>((resolve) => server?.listen(socket, resolve));
        return socket;
    };

    const gate = (socket: string, args: readonly string[]): Promise<{ code: number | null; stdout: string; stderr: string }> =>
        new Promise((resolve) => {
            const child = spawn(process.execPath.endsWith("bun") ? "node" : process.execPath, [CLI, "--class", "toolchain", "--label", "cargo", ...args], {
                env: { ...process.env, INTENTIC_ROOM_SOCKET: socket },
            });
            let stdout = "";
            let stderr = "";
            child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
            child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
            child.on("close", (code) => resolve({ code, stdout, stderr }));
        });

    test("room: it starts, and says what its admission holds for the command's launcher", async () => {
        const socket = await daemon({ verdict: "run", waitedMs: 0, needBytes: 8 * GIB, freeBytes: 9 * GIB, reservedBytes: 7 * GIB });
        const run = await gate(socket, ["--wait", "0", "--size", "cargo-build", "--admitted"]);
        expect(run).toMatchObject({ code: 0, stdout: `${7 * GIB}\n`, stderr: "" });
    });

    test("short but above the floor at its deadline: it starts with what there is, and holds nothing for it", async () => {
        const run = await gate(await daemon(short(2 * GIB, { waitedMs: 50 })), ["--wait", "0", "--ceiling", "900", "--admitted"]);
        expect(run.code).toBe(0);
        expect(run.stdout).toBe("0\n");
        expect(run.stderr).toContain("[memory-room] cargo: still short of memory after");
        expect(run.stderr).toContain("— starting with what there is.");
    });

    test("below the floor up to its ceiling: held, told what to do, and not started", async () => {
        const run = await gate(await daemon(short(0.1 * GIB, { waitedMs: 50 })), ["--wait", "0", "--ceiling", "1"]);
        expect(run.code).toBe(75);
        expect(run.stderr).toContain("[memory-room] cargo: holding it: 0.1 GiB free (Sandbox memory is low: 15.9 of 16.0 GiB used), under the 1.0 GiB a heavy command needs to start");
        expect(run.stderr).toMatch(/\[memory-room\] cargo: not started: after \d+s the sandbox still had 0\.1 GiB free/u);
        // An answer that comes at once is followed by a pause before the next ask (memory-floor.mjs MIN_ROUND_MS).
    }, 20_000);
});
