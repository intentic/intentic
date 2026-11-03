import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Desktop } from "@intentic/desktop-automation";
import type { DeviceScopes } from "@intentic/sandbox-contract/schemas/capabilities";
import { ScopeError } from "../../policy.js";
import { listArtifacts, sandboxRunsDir, stageArtifact } from "./artifacts.js";
import { appLogsAfterWait, appStatusAfterWait } from "./app-wait-tools.js";
import { appLogs, appStatus, appStop, describeExit, startApp } from "./programs.js";
import { descendantsOf, parseRows, survivorsOf } from "./process-tree.js";

// Pushing a build and running it, on a real temp home as the POSIX user running the suite: the bytes go through the
// same chunk/commit protocol the daemon drives, and the program is a real process the supervisor starts and stops.

const home = realpathSync(mkdtempSync(join(tmpdir(), "device-programs-")));
const before = process.env["HOME"];
process.env["HOME"] = home;

afterAll(() => {
    process.env["HOME"] = before;
    rmSync(home, { recursive: true, force: true });
});

const SANDBOX = "https://sandbox-abc123.example.dev";
const off: DeviceScopes = { shell: "off", write: "off", screen: "off", control: "off", sandboxes: "off", destructive: "off", programs: "off" };
const programs: DeviceScopes = { ...off, programs: "on" };
const noScreen = (): Desktop => {
    throw new Error("no desktop in this suite");
};

const sha = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
const uploadId = (): string => randomBytes(16).toString("hex");

// One push as the daemon makes it: pieces of `size`, then the commit.
const push = async (bytes: Buffer, name: string, fileName: string, kind: "file" | "tar" = "file", piece = 5): Promise<string | undefined> => {
    const upload = uploadId();
    for (let offset = 0; offset < bytes.byteLength; offset += piece) {
        await stageArtifact({ op: "chunk", upload, offset, data: bytes.subarray(offset, offset + piece).toString("base64") }, programs, SANDBOX);
    }
    return (await stageArtifact({ op: "commit", upload, name, kind, fileName, size: bytes.byteLength, sha256: sha(bytes) }, programs, SANDBOX)).path;
};

test("every op is refused while Run programs is off, and nothing is written", async () => {
    await expect(stageArtifact({ op: "have", name: "app", sha256: "0".repeat(64), kind: "file", fileName: "app" }, off, SANDBOX)).rejects.toBeInstanceOf(
        ScopeError,
    );
    expect(existsSync(sandboxRunsDir(SANDBOX))).toBe(false);
});

test("a file pushed in pieces is filed under its name and hash, and a second push of it is already there", async () => {
    const bytes = Buffer.from("#!/bin/sh\necho hello from the build\n");
    const path = await push(bytes, "hello", "hello.sh");
    expect(path).toBe(join(sandboxRunsDir(SANDBOX), "hello", sha(bytes).slice(0, 12), "hello.sh"));
    expect(readFileSync(path ?? "")).toEqual(bytes);
    const had = await stageArtifact({ op: "have", name: "hello", sha256: sha(bytes), kind: "file", fileName: "hello.sh" }, programs, SANDBOX);
    expect(had.path).toBe(path);
    expect((await listArtifacts(SANDBOX)).map((build) => build.name)).toContain("hello");
});

test("bytes that do not match what was announced are thrown away, and a gap is refused", async () => {
    const bytes = Buffer.from("the real build");
    const upload = uploadId();
    await stageArtifact({ op: "chunk", upload, offset: 0, data: bytes.toString("base64") }, programs, SANDBOX);
    await expect(
        stageArtifact({ op: "commit", upload, name: "bad", kind: "file", fileName: "bad.bin", size: bytes.byteLength, sha256: "f".repeat(64) }, programs, SANDBOX),
    ).rejects.toThrow("is not what was sent");
    expect(existsSync(join(sandboxRunsDir(SANDBOX), "bad"))).toBe(false);

    const gapped = uploadId();
    await stageArtifact({ op: "chunk", upload: gapped, offset: 0, data: "YWJj" }, programs, SANDBOX);
    await expect(stageArtifact({ op: "chunk", upload: gapped, offset: 10, data: "YWJj" }, programs, SANDBOX)).rejects.toThrow("push again");
});

test("a folder travels as a tar and is unpacked where its path says", async () => {
    const source = join(home, "build");
    mkdirSync(join(source, "lib"), { recursive: true });
    writeFileSync(join(source, "app.sh"), "echo app\n");
    writeFileSync(join(source, "lib", "dep.txt"), "dep\n");
    const archive = join(home, "build.tar");
    const packed = Bun.spawnSync(["tar", "-cf", archive, "-C", source, "."]);
    expect(packed.exitCode).toBe(0);
    const path = await push(readFileSync(archive), "folder", "folder.tar", "tar", 4096);
    expect(readFileSync(join(path ?? "", "lib", "dep.txt"), "utf8")).toBe("dep\n");
});

test("a started program keeps running, its output is logged, and a stop ends it with its children", async () => {
    const bytes = Buffer.from('#!/bin/sh\necho "ready on stdout"\necho "oops on stderr" >&2\nsleep 60 &\nwait\n');
    const path = await push(bytes, "server", "server.sh");
    Bun.spawnSync(["chmod", "+x", path ?? ""]);
    const started = await startApp({ program: path ?? "" }, programs, SANDBOX);
    const id = /as (server-[0-9a-f]{6})/.exec(started)?.[1] ?? "";
    expect(id).not.toBe("");
    const logs = await appLogs(id, 50, undefined, programs, SANDBOX);
    expect(logs).toContain("ready on stdout");
    expect(logs).toContain("oops on stderr");
    expect(await appLogs(id, 50, "oops", programs, SANDBOX)).not.toContain("ready on stdout");
    expect(await appStatus(undefined, programs, SANDBOX, noScreen)).toContain(`▶ ${id}`);
    expect(await appStop(id, false, programs, SANDBOX, "the Run dialog's Stop")).toContain(`Stopped ${id}`);
    expect((await appStatus(id, programs, SANDBOX, noScreen)).split("\n")[0]).toContain(`■ ${id}  server  stopped by the Run dialog's Stop  (started `);
});

// A program that closes when asked can leave behind what it started outside its process group (on Windows, anything
// whose parent ended first): taskkill /T had no parent left to walk from, and the run read as stopped while its child
// kept the port (2026-11-02).
test("a stop ends what the program started even when the program itself closed first", async () => {
    const bytes = Buffer.from(`#!/bin/sh\ntrap 'exit 0' TERM\nsetsid sleep 60 &\necho "child $!"\nwhile :; do sleep 1; done\n`);
    const path = await push(bytes, "leaves", "leaves.sh");
    Bun.spawnSync(["chmod", "+x", path ?? ""]);
    const started = await startApp({ program: path ?? "" }, programs, SANDBOX);
    const id = /as (leaves-[0-9a-f]{6})/.exec(started)?.[1] ?? "";
    const child = Number(/child (\d+)/.exec(await appLogs(id, 10, undefined, programs, SANDBOX))?.[1]);
    expect(child).toBeGreaterThan(0);
    expect(await appStop(id, false, programs, SANDBOX)).toContain(`Stopped ${id}`);
    // Ended: gone, or a zombie nothing reaps (a container whose first process reaps no orphans, as CI's), which
    // kill(pid, 0) still answers for.
    const state = Bun.spawnSync(["ps", "-o", "stat=", "-p", String(child)]).stdout.toString().trim();
    expect(state === "" || state.startsWith("Z")).toBe(true);
}, 30_000);

test("a survivor is the same process the tree held: on Windows under the same parent, elsewhere the same pid", () => {
    const held: [number, number][] = [
        [10, 1],
        [11, 10],
        [12, 11],
        [20, 1],
    ];
    const tree = descendantsOf(held, 10);
    // 11 outlived its parent; 12's pid now belongs to an unrelated program; 20 was never in the tree.
    const after: [number, number][] = [
        [11, 10],
        [12, 99],
        [20, 1],
    ];
    expect(survivorsOf(held, tree, 10, after, true)).toEqual([11]);
    expect(survivorsOf(held, tree, 10, [[11, 1], [12, 1], [20, 1]], false)).toEqual([11, 12]);
});

// waitFor and untilExit answer on the line and on the exit, so an agent asks once rather than calling in a loop
// (2026-10-20); the old app_logs gave whatever was there when it was called.
test("app_logs waits for the line it is told to, and app_status for the end", async () => {
    const path = await push(Buffer.from('#!/bin/sh\nsleep 2\necho "listening on 8080"\nsleep 1\nexit 4\n'), "slow", "slow.sh");
    Bun.spawnSync(["chmod", "+x", path ?? ""]);
    const started = await startApp({ program: path ?? "" }, programs, SANDBOX);
    const id = /as (slow-[0-9a-f]{6})/.exec(started)?.[1] ?? "";
    expect(id).not.toBe("");
    expect(await appLogsAfterWait(id, 50, undefined, programs, SANDBOX, { waitFor: "listening on \\d+", timeoutMs: 10_000 })).toContain("listening on 8080");
    expect(await appStatusAfterWait(id, programs, SANDBOX, noScreen, { untilExit: true, timeoutMs: 10_000 })).toContain("exited with code 4");
    // Asked of a run that has ended, a line that never came says so at once rather than at the timeout.
    expect(await appLogsAfterWait(id, 50, undefined, programs, SANDBOX, { waitFor: "never printed", timeoutMs: 10_000 })).toContain(
        "(waitFor: the program ended without printing a line matching /never printed/i.)",
    );
}, 30_000);

test("a program that falls over at once is answered with how it ended and what it said", async () => {
    const path = await push(Buffer.from('#!/bin/sh\necho "missing config" >&2\nexit 3\n'), "crashes", "crashes.sh");
    Bun.spawnSync(["chmod", "+x", path ?? ""]);
    const said = await startApp({ program: path ?? "" }, programs, SANDBOX);
    expect(said).toContain("exited with code 3");
    expect(said).toContain("missing config");
});

// A hint for the keyring's record that an agent's program is the one asking (shell.ts, AGENT_COMMAND_ENV), set after the
// request's own variables so a request cannot drop it, though the program itself still can.
test("a started program carries INTENTIC_AGENT_COMMAND=1, whatever env the request gave", async () => {
    const path = await push(Buffer.from('#!/bin/sh\necho "mark=$INTENTIC_AGENT_COMMAND extra=$EXTRA"\nexit 0\n'), "marked", "marked.sh");
    Bun.spawnSync(["chmod", "+x", path ?? ""]);
    const said = await startApp({ program: path ?? "", env: { EXTRA: "yes", INTENTIC_AGENT_COMMAND: "0" } }, programs, SANDBOX);
    expect(said).toContain("mark=1 extra=yes");
});

test("a program the sandbox did not push needs Run commands, and a folder points at what is inside it", async () => {
    await expect(startApp({ program: "/bin/true" }, programs, SANDBOX)).rejects.toBeInstanceOf(ScopeError);
    const folder = join(sandboxRunsDir(SANDBOX), "folder");
    await expect(startApp({ program: folder }, programs, SANDBOX)).rejects.toThrow("is a folder");
});

test("a process tree is read from pid/parent rows, and Windows exit codes are said in words", () => {
    const rows = parseRows("  1 0\n 10 1\n 11 10\n 12 11\n 20 1\nnot a row\n");
    expect([...descendantsOf(rows, 10)].toSorted((a, b) => a - b)).toEqual([10, 11, 12]);
    expect(describeExit({ exitCode: 0xc0000135 })).toBe("exited with 0xC0000135: a DLL it needs was not found");
    expect(describeExit({ exitCode: -1073741819 })).toBe("exited with 0xC0000005: access violation (a crash)");
    expect(describeExit({ exitCode: 1 })).toBe("exited with code 1");
    expect(describeExit({})).toContain("unknown");
    expect(describeExit({ stoppedBy: "app_stop from conversation coral-maple-kmq3", signal: "SIGTERM" })).toBe("stopped by app_stop from conversation coral-maple-kmq3");
});

// A forced stop says why, and waits the run's own grace (a target's stopGraceSeconds) rather than a fixed five seconds:
// "it did not close when asked" used to read the same whether the program could hear the asking or not (2026-11-02).
test("a program that ignores the asking is forced after its own grace, and the stop says it was asked", async () => {
    const bytes = Buffer.from(`#!/bin/sh\ntrap '' TERM\necho ignoring\nwhile :; do sleep 1; done\n`);
    const path = await push(bytes, "stubborn", "stubborn.sh");
    Bun.spawnSync(["chmod", "+x", path ?? ""]);
    const started = await startApp({ program: path ?? "", stopGraceSeconds: 1 }, programs, SANDBOX);
    const id = /as (stubborn-[0-9a-f]{6})/.exec(started)?.[1] ?? "";
    await appLogsAfterWait(id, 10, undefined, programs, SANDBOX, { waitFor: "ignoring", untilExit: undefined, timeoutMs: 5000 });
    const began = Date.now();
    const said = await appStop(id, false, programs, SANDBOX);
    expect(said).toContain(`Stopped ${id}, with everything it started. It was forced: it was sent SIGTERM and had not finished after 1 s.`);
    expect(Date.now() - began).toBeLessThan(4500);
    expect(await appStop(id, false, programs, SANDBOX)).toContain("is not running");
}, 30_000);
