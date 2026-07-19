import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { portKind, scanListeningPorts } from "./port-scan.js";

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
        { port: 3000, host: "127.0.0.1" }, // no fd matched its inode — still listed, just unattributed
        // A ::1-only bind (a server that bound `localhost`, like Vite) must be dialed at ::1, not 127.0.0.1.
        { port: 9999, host: "::1", pid: 123, command: "node /work/app/node_modules/.bin/vite", cwd: "/work/app" },
        { port: 45678, host: "127.0.0.1", pid: 123, command: "node /work/app/node_modules/.bin/vite", cwd: "/work/app" },
    ]);
});

test("an unreadable proc tree yields an empty scan, not a rejection", async () => {
    await expect(scanListeningPorts(join(tmpdir(), "port-scan-missing"))).resolves.toEqual([]);
});

test("portKind: repo cwds and terminal processes are workspace; sandbox machinery and unknowns are system", () => {
    // A cwd inside a repo wins outright — even for a binary that is otherwise sandbox machinery.
    expect(portKind({ command: "node /work/intentic/_apps/web/node_modules/.bin/vite", cwd: "/work/intentic/_apps/web" }, "/work")).toBe("workspace");
    expect(portKind({ command: "opencode serve --port=4096", cwd: "/work/myrepo" }, "/work")).toBe("workspace");
    // Known sandbox binaries at the workspace root are system.
    expect(portKind({ command: "opencode serve --hostname=127.0.0.1 --port=4096", cwd: "/work" }, "/work")).toBe("system");
    expect(portKind({ command: "cli-proxy-api --config /history/translator/config.yaml", cwd: "/work" }, "/work")).toBe("system");
    // docker-proxy publishes a USER container's port — workspace, wherever it runs from.
    expect(portKind({ command: "/usr/bin/docker-proxy -proto tcp -host-port 5440", cwd: "/" }, "/work")).toBe("workspace");
    // Anything else run from the workspace root is a user terminal process (shells open there).
    expect(portKind({ command: "python -m http.server 8000", cwd: "/work" }, "/work")).toBe("workspace");
    // Unattributable listeners default to system.
    expect(portKind({}, "/work")).toBe("system");
});
