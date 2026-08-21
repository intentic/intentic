import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// ssh.ts derives knownHostsPath from homedir() at import time, so HOME is pointed at a throwaway dir BEFORE the
// dynamic import: the same shape config.integration.test.ts uses, and for the same reason.
process.env["HOME"] = mkdtempSync(join(tmpdir(), "sync-known-hosts-"));
process.env["USERPROFILE"] = process.env["HOME"];
const { pruneKnownHosts } = await import("./ssh.js");
const { knownHostsPath, baseDir } = await import("./config.js");
const { mkdir, readFile, writeFile } = await import("node:fs/promises");

const write = async (contents: string): Promise<void> => {
    await mkdir(baseDir, { recursive: true });
    await writeFile(knownHostsPath, contents);
};

/* THE ENTRY AN UPGRADE COULD NOT REACH. An earlier agent wrote `HostKeyAlias %h`, which ssh takes literally, so
 * every sandbox's host key landed under one host named "%h", and from then on the first sandbox to connect was
 * the only one accepted, every other pairing refused with "Host key for %h has changed" for good. Fixing the
 * config it came from does nothing for the machines that already have the line; only deleting it does. */
describe("pruneKnownHosts", () => {
    it("removes the literal %h entry an older agent wrote, and says it did", async () => {
        await write(["%h ssh-ed25519 AAAAfirst", "intentic-sync-sandbox-abc-dev ssh-ed25519 AAAAreal", ""].join("\n"));

        expect(await pruneKnownHosts()).toBe(true);
        expect(await readFile(knownHostsPath, "utf8")).toBe("intentic-sync-sandbox-abc-dev ssh-ed25519 AAAAreal\n");
    });

    // Every other line is a host key the user's own transports depend on: a prune that took one of those would
    // trade a locked-out sandbox for a locked-out fleet.
    it("leaves a healthy file exactly as it is, and reports nothing to do", async () => {
        const healthy = ["intentic-sync-sandbox-abc-dev ssh-ed25519 AAAAone", "intentic-sync-sandbox-def-dev ssh-ed25519 AAAAtwo", ""].join("\n");
        await write(healthy);

        expect(await pruneKnownHosts()).toBe(false);
        expect(await readFile(knownHostsPath, "utf8")).toBe(healthy);
    });

    // A machine that has never connected to anything has no file, which is not a fault to report.
    it("is a no-op when there is no known_hosts yet", async () => {
        const { rm } = await import("node:fs/promises");
        await rm(knownHostsPath, { force: true });

        expect(await pruneKnownHosts()).toBe(false);
    });
});
