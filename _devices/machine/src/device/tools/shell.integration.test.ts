import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sleep } from "@intentic/base/async";
import type { DeviceScopes } from "@intentic/sandbox-contract";
import { runCommand } from "./shell.js";

// Real processes through the login shell, on POSIX, where a command's process group is what a timeout stops. Every
// command is harmless, and whatever one leaves running is killed by the test that started it.

const root = mkdtempSync(join(tmpdir(), "device-shell-"));
const grant: DeviceScopes = { shell: "on", write: "off", screen: "off", control: "off", sandboxes: "off", destructive: "off", roots: root };

afterAll(() => {
    rmSync(root, { recursive: true, force: true });
});

// The shell exits at once, but the sleep it left holds both pipes for a minute: waiting for them to close is how
// `npm run dev &` used to hold a call until the device call's 15-minute deadline.
test("a process left in the background does not hold the call open, and what came before it comes back", async () => {
    const started = Date.now();
    const result = await runCommand({ command: "echo started; sleep 60 & echo $!" }, grant);
    const [said, pid] = result.stdout.text.trim().split("\n");
    try {
        expect(said).toBe("started");
        expect(result.exitCode).toBe(0);
        expect(result.lingering).toBe(true);
        // A hang bound, far from both the second of grace this takes and the minute it used to.
        expect(Date.now() - started).toBeLessThan(15_000);
        // The call stops waiting for it; it does not kill it.
        expect(() => process.kill(Number(pid), 0)).not.toThrow();
    } finally {
        process.kill(Number(pid), "SIGKILL");
    }
});

test("a timeout stops the whole group, down to a grandchild that ignores SIGTERM", async () => {
    const beat = join(root, "heartbeat");
    const result = await runCommand(
        { command: `sh -c 'trap "" TERM; while :; do echo beat >> "${beat}"; sleep 0.1; done' & wait`, timeoutMs: 1_000 },
        grant,
    );
    expect(result.timedOut).toBe(true);
    const size = statSync(beat).size;
    expect(size).toBeGreaterThan(0);
    await sleep(600);
    // Nothing is left to write it: the grandchild went with the group, not only the shell that started it.
    expect(statSync(beat).size).toBe(size);
});

test("output far past what an answer holds keeps its start and its end, and counts what it left out", async () => {
    const result = await runCommand({ command: "yes | head -c 20000000" }, grant);
    const marker = `\n… [${20_000_000 - 100_000} characters cut] …\n`;
    expect(result.exitCode).toBe(0);
    expect(result.lingering).toBe(false);
    expect(result.stdout.dropped).toBe(20_000_000 - 100_000);
    expect(result.stdout.text.length).toBe(100_000 + marker.length);
    expect(result.stdout.text.slice(50_000, 50_000 + marker.length)).toBe(marker);
    expect(result.stdout.text.slice(0, 4)).toBe("y\ny\n");
});

// Two writes a third of a second apart arrive as two chunks; decoded one at a time, each half is a replacement character.
test("a character split across two writes arrives whole", async () => {
    const result = await runCommand({ command: String.raw`printf '\303'; sleep 0.3; printf '\251\n'` }, grant);
    expect(result.stdout.text).toBe("é\n");
});
