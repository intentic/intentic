import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DeviceScopes } from "@intentic/sandbox-contract";
import { ScopeError } from "../../policy.js";
import { runCommand } from "../shell.js";
import { sandboxRunsDir } from "./artifacts.js";
import { appStatus, appStop, startApp } from "./programs.js";

// What app_start and app_stop may do under the device's switches. `suites` gives this run a throwaway HOME, so the runs
// folder is a temp one.

const SANDBOX = "https://sandbox-0a1b2c3d4e5f.example.dev";
const off: DeviceScopes = { shell: "off", write: "off", screen: "off", control: "off", sandboxes: "off", destructive: "off", programs: "off" };
// The default card: "Run commands" on, "Run destructive commands" off.
const shellOnly: DeviceScopes = { ...off, shell: "on", roots: process.env["HOME"] ?? "/tmp" };
const programs: DeviceScopes = { ...off, programs: "on" };
const noScreen = () => {
    throw new Error("no desktop");
};

test("app_start refuses a deleting command that run_command refuses while 'Run destructive commands' is off", async () => {
    const victim = join(process.env["HOME"] ?? "/tmp", "precious");
    mkdirSync(join(victim, "nested"), { recursive: true });
    writeFileSync(join(victim, "nested", "thesis.docx"), "years of work");

    await expect(runCommand({ command: `rm -rf ${victim}` }, shellOnly)).rejects.toBeInstanceOf(ScopeError);
    // The same delete by the other door, directly and through a shell, is refused alike.
    await expect(startApp({ program: "rm", args: ["-rf", victim] }, shellOnly, SANDBOX)).rejects.toBeInstanceOf(ScopeError);
    await expect(startApp({ program: "/bin/sh", args: ["-c", `rm -rf ${victim}`] }, shellOnly, SANDBOX)).rejects.toBeInstanceOf(ScopeError);
    await expect(startApp({ program: "pwsh", args: ["-Command", `Remove-Item -Recurse -Force ${victim}`] }, shellOnly, SANDBOX)).rejects.toBeInstanceOf(ScopeError);
    expect(existsSync(victim)).toBe(true);

    // With the switch on, it is the owner's call, and it runs.
    const said = await startApp({ program: "rm", args: ["-rf", victim] }, { ...shellOnly, destructive: "on" }, SANDBOX);
    expect(said).toContain("exited with code 0");
    expect(existsSync(victim)).toBe(false);
});

test("app_start still starts an ordinary program with the destructive switch off", async () => {
    const said = await startApp({ program: "true" }, shellOnly, SANDBOX);
    expect(said).toContain("exited with code 0");
});

test("app_stop on a run recorded before an agent restart leaves alone the unrelated process that now holds that pid", async () => {
    // An unrelated process of the owner's, a process-group leader (any shell job, any detached app is one).
    const innocent = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
    await new Promise<void>((done) => innocent.once("spawn", () => done()));
    const killedBy = new Promise<string | null>((done) => innocent.once("exit", (_code, signal) => done(signal)));
    const pid = innocent.pid ?? 0;

    // apps.json as a previous agent process left it: a run it started, never seen to end (the machine rebooted, the
    // agent was upgraded, it crashed). The pid has since been handed to the owner's process above, which began days after.
    const record = {
        id: "server-0ld0ld",
        name: "server",
        program: join(sandboxRunsDir(SANDBOX), "server", "aaaaaaaaaaaa", "server.sh"),
        args: [],
        cwd: sandboxRunsDir(SANDBOX),
        pid,
        startedAt: "2026-10-01T00:00:00.000Z",
        log: join(sandboxRunsDir(SANDBOX), ".logs", "server-0ld0ld.log"),
    };
    mkdirSync(sandboxRunsDir(SANDBOX), { recursive: true });
    writeFileSync(join(sandboxRunsDir(SANDBOX), "apps.json"), JSON.stringify([record]));

    // The pid is alive, but its process began long after the run did: it is somebody else's now. The run reads ended...
    expect(await appStatus(record.id, programs, SANDBOX, noScreen)).toContain("ended (its exit code is unknown");
    // ...and stopping it signals nothing.
    expect(await appStop(record.id, true, programs, SANDBOX)).toContain("is not running");
    const survived = await Promise.race([killedBy, new Promise<"alive">((done) => setTimeout(() => done("alive"), 500))]);
    expect(survived).toBe("alive");
    innocent.kill("SIGKILL");
    await killedBy;
});

test("a run an earlier agent started whose pid still holds that very process is still stopped", async () => {
    const own = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
    await new Promise<void>((done) => own.once("spawn", () => done()));
    const killedBy = new Promise<string | null>((done) => own.once("exit", (_code, signal) => done(signal)));
    const record = {
        id: "server-still1",
        name: "server",
        program: join(sandboxRunsDir(SANDBOX), "server", "aaaaaaaaaaaa", "server.sh"),
        args: [],
        cwd: sandboxRunsDir(SANDBOX),
        pid: own.pid ?? 0,
        startedAt: new Date().toISOString(),
        log: join(sandboxRunsDir(SANDBOX), ".logs", "server-still1.log"),
    };
    writeFileSync(join(sandboxRunsDir(SANDBOX), "apps.json"), JSON.stringify([record]));
    expect(await appStatus(record.id, programs, SANDBOX, noScreen)).toContain(`running, pid ${record.pid}`);
    expect(await appStop(record.id, true, programs, SANDBOX)).toContain("Stopped server-still1");
    expect(await killedBy).toBe("SIGKILL");
});
