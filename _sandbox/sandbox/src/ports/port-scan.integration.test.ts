import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { parentPid, portKind, scanListeningPorts, withOwningSessions } from "./port-scan.js";

// A procfs fixture tree: net/tcp{,6} tables plus /proc/<pid>/{fd,cmdline,cwd}. The fd entries are dangling
// symlinks whose TARGET STRING is the socket marker — exactly what readlink returns on the real thing.
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
            row("0100007F:1F40", "01", "1009"), // ESTABLISHED — not a listener
            row("010011AC:1538", "0A", "1010"), // 172.17.0.1:5432 LISTEN — not reachable at 127.0.0.1
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
    symlinkSync("/work/app", join(root, "123", "cwd"));
    return root;
};

test("reports loopback/wildcard LISTEN sockets once per port, attributed to their owning process", async () => {
    const ports = await scanListeningPorts(fixture());
    expect(ports).toEqual([
        { port: 3000, host: "127.0.0.1", forwardable: true }, // no fd matched its inode — still listed, just unattributed
        // A ::1-only bind (a server that bound `localhost`, like Vite) must be dialed at ::1, not 127.0.0.1.
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
    // 127.0.0.11:45661 LISTEN — libnetwork's embedded resolver. dockerd answers it from outside this PID
    // namespace, so no /proc/*/fd owns inode 1005 and the pid walk comes up empty — but the address names it.
    writeFileSync(join(root, "net", "tcp"), [HEADER, row("0B00007F:B25D", "0A", "1005")].join("\n"));
    writeFileSync(join(root, "net", "tcp6"), HEADER);
    // Named, but flagged not-forwardable: 127.0.0.11 only answers at its own address, not the dialed 127.0.0.1.
    await expect(scanListeningPorts(root)).resolves.toEqual([{ port: 45661, host: "127.0.0.1", forwardable: false, command: "Docker embedded DNS" }]);
});

test("lists an un-nameable 127/8 alias but flags it not-forwardable", async () => {
    const root = mkdtempSync(join(tmpdir(), "port-scan-"));
    mkdirSync(join(root, "net"), { recursive: true });
    // 127.0.0.5:9500 LISTEN, no owning fd — a loopback alias we can neither name nor reach at 127.0.0.1.
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

/* WHO IS OCCUPYING THE PORT — traced to the terminal, not to the process.
 *
 * The pid holding the socket is three generations below anything a person launched (`pnpm dev` → turbo → vite),
 * so the pane is found by walking parents. `/proc/<pid>/stat`'s comm field is deliberately hostile here: it is
 * parenthesized, and it may itself contain spaces and parens. */
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
        // Nothing in ITS ancestry is a pane: the daemon's own runtime, which no terminal can show or stop.
        { port: 8787, host: "127.0.0.1" as const, forwardable: true, pid: 397_000 },
        // Unattributable to any process at all — nothing to walk.
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
    // A cycle: 500's parent is 501, whose parent is 500. Kernel links never do this; a raced read of a recycled
    // pid could, and the walk has to end either way.
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

test("portKind: repo cwds and terminal processes are workspace; sandbox machinery and unknowns are system", () => {
    // A cwd inside a repo wins outright — even for a binary that is otherwise sandbox machinery.
    expect(portKind({ command: "node /work/intentic/_editor/web/node_modules/.bin/vite", cwd: "/work/intentic/_editor/web" }, "/work")).toBe(
        "workspace",
    );
    expect(portKind({ command: "opencode serve --port=4096", cwd: "/work/myrepo" }, "/work")).toBe("workspace");
    // Known sandbox binaries at the workspace root are system.
    expect(portKind({ command: "opencode serve --hostname=127.0.0.1 --port=4096", cwd: "/work" }, "/work")).toBe("system");
    expect(portKind({ command: "cli-proxy-api --config /history/translator/config.yaml", cwd: "/work" }, "/work")).toBe("system");
    // docker-proxy publishes a USER container's port — workspace, wherever it runs from.
    expect(portKind({ command: "/usr/bin/docker-proxy -proto tcp -host-port 5440", cwd: "/" }, "/work")).toBe("workspace");
    // Anything else run from the workspace root is a user terminal process (shells open there).
    expect(portKind({ command: "python -m http.server 8000", cwd: "/work" }, "/work")).toBe("workspace");
    // The synthesized Docker-DNS label (no cwd) files under system like other unattributed infrastructure.
    expect(portKind({ command: "Docker embedded DNS" }, "/work")).toBe("system");
    // Unattributable listeners default to system.
    expect(portKind({}, "/work")).toBe("system");
});
