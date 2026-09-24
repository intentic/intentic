import { spawn } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { halt } from "./net-probe.js";

// `halt` is how every pidfile-driven tunnel is taken down; forgetting the pidfile of a client that is still running
// would leave a live tunnel with nothing left to find it by, which every card then reports as down.

// A real, long-lived client whose cmdline carries a word `halt` can recognise it by.
const MARK = "halt-probe-client";

test("halt keeps the pidfile and throws when the client outlives a kill that failed, then stops it once kill works", async () => {
    const child = spawn(process.execPath, ["-e", `setTimeout(() => {}, 60_000); // ${MARK}`], { stdio: "ignore" });
    const exited = once(child, "exit");
    const pidFile = join(mkdtempSync(join(tmpdir(), "net-probe-")), "client.pid");
    await writeFile(pidFile, String(child.pid));

    // An empty PATH makes the kill itself fail (no `kill` to spawn) while the client stays up.
    const path = process.env["PATH"];
    process.env["PATH"] = mkdtempSync(join(tmpdir(), "net-probe-nopath-"));
    try {
        await expect(halt(pidFile, MARK)).rejects.toThrow(`could not stop ${MARK} (pid ${String(child.pid)})`);
    } finally {
        process.env["PATH"] = path;
    }
    expect(existsSync(pidFile)).toBe(true);

    await halt(pidFile, MARK);
    expect(existsSync(pidFile)).toBe(false);
    const [code, signal] = await exited;
    expect({ code, signal }).toEqual({ code: null, signal: "SIGTERM" });
});

test("halt on a client already gone just forgets its pidfile", async () => {
    const child = spawn(process.execPath, ["-e", `// ${MARK}`], { stdio: "ignore" });
    await once(child, "exit");
    const pidFile = join(mkdtempSync(join(tmpdir(), "net-probe-")), "client.pid");
    await writeFile(pidFile, String(child.pid));

    await halt(pidFile, MARK);

    expect(existsSync(pidFile)).toBe(false);
});
