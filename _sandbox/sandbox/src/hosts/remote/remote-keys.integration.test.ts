import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { digestOf, fileRemoteKeys, uplinkIdOf } from "./remote-keys.js";

// A temp directory stands in for the container's run directory.
let dir: string;
beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "remote-keys-"));
});
afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
});

test("a device's pair is made once, owner-only, and read back by a daemon that restarted", () => {
    const keys = fileRemoteKeys(join(dir, "remote"));
    expect(keys.has("rog")).toBe(false);
    const made = keys.of("rog");
    expect(Buffer.from(made.uplinkToken, "base64url")).toHaveLength(32);
    expect(Buffer.from(made.mediaKey, "base64url")).toHaveLength(32);
    expect(made.uplinkToken).not.toBe(made.mediaKey);
    expect(statSync(join(dir, "remote", "rog.json")).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "remote")).mode & 0o777).toBe(0o700);
    const restarted = fileRemoteKeys(join(dir, "remote"));
    expect([restarted.has("rog"), restarted.of("rog"), restarted.held()]).toEqual([true, made, ["rog"]]);
    restarted.forget("rog");
    expect([restarted.has("rog"), restarted.held()]).toEqual([false, []]);
    expect(restarted.of("rog")).not.toEqual(made);
});

test("a connection key that is already a name is the uplink id; any other is made one, told apart by its digest", () => {
    expect(uplinkIdOf("rog")).toBe("rog");
    expect(uplinkIdOf("radarsu-server_2")).toBe("radarsu-server_2");
    expect(uplinkIdOf("rog::wsl:archlinux")).toBe(`rog-wsl-archlinux-${digestOf("rog::wsl:archlinux").slice(0, 8)}`);
    expect(uplinkIdOf("rog::wsl:arch.linux")).not.toBe(uplinkIdOf("rog::wsl:arch-linux"));
    const long = uplinkIdOf(`${"a".repeat(60)}::wsl:${"b".repeat(60)}`);
    expect(long).toMatch(/^[A-Za-z0-9_-]{64}$/u);
    // `printf token | sha256sum`, the digest netd computes of what remoted presents (netd's devices.rs).
    expect(digestOf("token")).toBe("3c469e9d6c5875d37a43f353d4f88e61fcf812c66eee3457465a40b0da4153e0");
});
