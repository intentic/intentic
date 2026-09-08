import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WORKSPACE_ROOT } from "@intentic/constants";
import { expect, test } from "vitest";
import { parentPid } from "../platform/resources/proc-stat.js";
import { scanListeningPorts, withOwningSessions } from "./port-scan.js";

// procfs fixture: net/tcp{,6} tables plus /proc/<pid>/{fd,cmdline,cwd}; fd entries are dangling symlinks whose target
// string is the socket marker, as readlink returns on the real thing.
const HEADER = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode";
const row = (local: string, st: string, inode: string): string =>
    `   0: ${local} 00000000:0000 ${st} 00000000:00000000 00:00000000 00000000  1000        0 ${inode} 1 0000000000000000 100 0 0 10 0`;
const row6 = (local: string, st: string, inode: string): string =>
    `   0: ${local} ${"0".repeat(32)}:0000 ${st} 00000000:00000000 00:00000000 00000000  1000        0 ${inode} 1 0000000000000000 100 0 0 10 0`;

const fixture = (): string => {
    const root = mkdtempSync(join(tmpdir(), "port-scan-"));
    mkdirSync(join(root, "net"), { recursive: true });
    writeFileSync(
        join(root, "net", "tcp"),
        [
            HEADER,
            row("0100007F:B26E", "0A", "1001"), // 127.0.0.1:45678 LISTEN — owned by pid 123
            row("00000000:0BB8", "0A", "1002"), // 0.0.0.0:3000 LISTEN — no owning fd anywhere
            row("0100007F:1F40", "01", "1009"), // ESTABLISHED, not a listener
            row("010011AC:1538", "0A", "1010"), // 172.17.0.1:5432 LISTEN, not reachable at 127.0.0.1
        ].join("\n"),
    );
    writeFileSync(
        join(root, "net", "tcp6"),
        [
            HEADER,
            row6(`${"0".repeat(32)}:0BB8`, "0A", "1003"), // [::]:3000 — dual-stack twin of the tcp row
            row6(`${"0".repeat(24)}01000000:270F`, "0A", "1004"), // [::1]:9999 LISTEN — owned by pid 123 too
        ].join("\n"),
    );
    mkdirSync(join(root, "123", "fd"), { recursive: true });
    symlinkSync("socket:[1001]", join(root, "123", "fd", "3"));
    symlinkSync("socket:[1004]", join(root, "123", "fd", "4"));
    writeFileSync(join(root, "123", "cmdline"), "node\0/work/app/node_modules/.bin/vite\0");
    symlinkSync(`${WORKSPACE_ROOT}/app`, join(root, "123", "cwd"));
    return root;
};

test("reports loopback/wildcard LISTEN sockets once per port, attributed to their owning process", async () => {
    const ports = await scanListeningPorts(fixture());
    expect(ports).toEqual([
        { port: 3000, host: "127.0.0.1", forwardable: true }, // no fd matched its inode — still listed, just unattributed
        // A ::1-only bind (bound to `localhost`, e.g. Vite) must be dialed at ::1, not 127.0.0.1.
        { port: 9999, host: "::1", forwardable: true, pid: 123, command: "node /work/app/node_modules/.bin/vite", cwd: "/work/app" },
        { port: 45678, host: "127.0.0.1", forwardable: true, pid: 123, command: "node /work/app/node_modules/.bin/vite", cwd: "/work/app" },
    ]);
});

test("an unreadable proc tree yields an empty scan, not a rejection", async () => {
    await expect(scanListeningPorts(join(tmpdir(), "port-scan-missing"))).resolves.toEqual([]);
});

test("names the Docker embedded DNS bind (127.0.0.11) it can't attribute to any process", async () => {
    const root = mkdtempSync(join(tmpdir(), "port-scan-"));
    mkdirSync(join(root, "net"), { recursive: true });
    // 127.0.0.11:45661: dockerd's resolver, answered outside this PID namespace; unowned but named by address.
    writeFileSync(join(root, "net", "tcp"), [HEADER, row("0B00007F:B25D", "0A", "1005")].join("\n"));
    writeFileSync(join(root, "net", "tcp6"), HEADER);
    // Not forwardable: 127.0.0.11 only answers at its own address, not the dialed 127.0.0.1.
    await expect(scanListeningPorts(root)).resolves.toEqual([{ port: 45661, host: "127.0.0.1", forwardable: false, command: "Docker embedded DNS" }]);
});

test("lists an un-nameable 127/8 alias but flags it not-forwardable", async () => {
    const root = mkdtempSync(join(tmpdir(), "port-scan-"));
    mkdirSync(join(root, "net"), { recursive: true });
    // 127.0.0.5:9500: a loopback alias, unowned, unreachable at 127.0.0.1.
    writeFileSync(join(root, "net", "tcp"), [HEADER, row("0500007F:251C", "0A", "1007")].join("\n"));
    writeFileSync(join(root, "net", "tcp6"), HEADER);
    await expect(scanListeningPorts(root)).resolves.toEqual([{ port: 9500, host: "127.0.0.1", forwardable: false }]);
});

test("falls back to /proc/<pid>/comm when a listening process has an empty cmdline", async () => {
    const root = mkdtempSync(join(tmpdir(), "port-scan-"));
    mkdirSync(join(root, "net"), { recursive: true });
    writeFileSync(join(root, "net", "tcp"), [HEADER, row("0100007F:1F91", "0A", "1006")].join("\n")); // 127.0.0.1:8081
    writeFileSync(join(root, "net", "tcp6"), HEADER);
    mkdirSync(join(root, "200", "fd"), { recursive: true });
    symlinkSync("socket:[1006]", join(root, "200", "fd", "5"));
    writeFileSync(join(root, "200", "cmdline"), ""); // argv cleared — nothing to join
    writeFileSync(join(root, "200", "comm"), "cloudflared\n"); // kernel-maintained executable name, the fallback
    await expect(scanListeningPorts(root)).resolves.toEqual([{ port: 8081, host: "127.0.0.1", forwardable: true, pid: 200, command: "cloudflared" }]);
});

// Traced to the terminal, not the process: the listening pid may be generations below what a person launched, so the
// pane is found by walking parents. comm is parenthesized and may itself contain spaces and parens.
const statFile = (pid: number, comm: string, ppid: number): string => `${pid} (${comm}) S ${ppid} ${pid} ${pid} 0 -1 4194304 0 0`;

test("traces a listener up its ancestry to the tmux pane it is running in", async () => {
    const root = mkdtempSync(join(tmpdir(), "port-scan-"));
    // vite (pid 400) ← turbo (399) ← pnpm (398) ← the pane's shell (397), which tmux reports for `web-3f2a`.
    for (const [pid, comm, ppid] of [
        [400, "node (vite)", 399],
        [399, "turbo", 398],
        [398, "pnpm dev", 397],
        [397, "bash", 1],
    ] as const) {
        mkdirSync(join(root, String(pid)), { recursive: true });
        writeFileSync(join(root, String(pid), "stat"), statFile(pid, comm, ppid));
    }
    const listeners = [
        { port: 4321, host: "127.0.0.1" as const, forwardable: true, pid: 400 },
        // Nothing in its ancestry is a pane: the daemon's own runtime, with no terminal to show it.
        { port: 8787, host: "127.0.0.1" as const, forwardable: true, pid: 397_000 },
        // Unattributable to any process at all: nothing to walk.
        { port: 5440, host: "127.0.0.1" as const, forwardable: true },
    ];
    await expect(withOwningSessions(listeners, new Map([[397, "web-3f2a"]]), root)).resolves.toEqual([
        { port: 4321, host: "127.0.0.1", forwardable: true, pid: 400, session: "web-3f2a" },
        { port: 8787, host: "127.0.0.1", forwardable: true, pid: 397_000 },
        { port: 5440, host: "127.0.0.1", forwardable: true },
    ]);
});

test("a process that IS the pane's own root process owns its port (a panel running its dev server directly)", async () => {
    const root = mkdtempSync(join(tmpdir(), "port-scan-"));
    mkdirSync(join(root, "247"), { recursive: true });
    writeFileSync(join(root, "247", "stat"), statFile(247, "dockerd", 1));
    const listeners = [{ port: 5440, host: "127.0.0.1" as const, forwardable: true, pid: 247 }];
    await expect(withOwningSessions(listeners, new Map([[247, "panel-docker"]]), root)).resolves.toEqual([
        { port: 5440, host: "127.0.0.1", forwardable: true, pid: 247, session: "panel-docker" },
    ]);
});

test("no tmux server annotates nothing, and a stat file that lies about its parent can't loop the walk", async () => {
    const root = mkdtempSync(join(tmpdir(), "port-scan-"));
    // A cycle (500↔501): kernel links never do this, but a raced recycled-pid read could; the walk must end.
    mkdirSync(join(root, "500"), { recursive: true });
    mkdirSync(join(root, "501"), { recursive: true });
    writeFileSync(join(root, "500", "stat"), statFile(500, "node", 501));
    writeFileSync(join(root, "501", "stat"), statFile(501, "node", 500));
    const listeners = [{ port: 3000, host: "127.0.0.1" as const, forwardable: true, pid: 500 }];
    await expect(withOwningSessions(listeners, new Map(), root)).resolves.toEqual(listeners);
    await expect(withOwningSessions(listeners, new Map([[999, "web-1"]]), root)).resolves.toEqual(listeners);
});

test("parentPid reads the ppid past a comm containing spaces and parentheses", () => {
    expect(parentPid(statFile(400, "node (vite)", 399))).toBe(399);
    expect(parentPid(statFile(1, "systemd", 0))).toBeUndefined(); // pid 1 has no parent to walk to
    expect(parentPid("")).toBeUndefined(); // the process died between the readdir and the read
});
