import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyHostKey } from "@intentic/providers";
import { Server, utils } from "ssh2";
import { createKnownHostsStore, pinnedSshExecutor } from "./known-hosts.js";

const tempDir = () => mkdtemp(join(tmpdir(), "intentic-known-hosts-"));

test("a pinned key persists across store instances backed by the same file", async () => {
    const dir = await tempDir();
    try {
        await createKnownHostsStore(dir).set("203.0.113.10", 22, "KEY_A");
        // A fresh instance reads the lockfile written by the first.
        expect(await createKnownHostsStore(dir).get("203.0.113.10", 22)).toBe("KEY_A");
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("verifyHostKey over the file store pins on first use, matches, then catches a changed key", async () => {
    const dir = await tempDir();
    try {
        const store = createKnownHostsStore(dir);
        expect(await verifyHostKey(store, "203.0.113.10", 22, "KEY_A")).toBe("ok");
        // A new instance (new run) reading the committed lockfile still verifies.
        expect(await verifyHostKey(createKnownHostsStore(dir), "203.0.113.10", 22, "KEY_A")).toBe("ok");
        expect(await verifyHostKey(createKnownHostsStore(dir), "203.0.113.10", 22, "KEY_B")).toBe("mismatch");
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("get returns undefined when no lockfile exists yet", async () => {
    const dir = await tempDir();
    try {
        expect(await createKnownHostsStore(dir).get("203.0.113.10", 22)).toBeUndefined();
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

// adopt once dialed with a trust-on-first-use executor while every other command pinned; the shared constructor must
// refuse a host whose key differs from the lockfile's before any auth (and so any secret) crosses the wire.
test("pinnedSshExecutor refuses a host presenting a key other than the pinned one", async () => {
    const dir = await tempDir();
    const server = new Server({ hostKeys: [utils.generateKeyPairSync("ed25519").private] }, (client) => {
        client.on("authentication", (ctx) => ctx.reject());
        client.on("error", () => {});
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    try {
        await createKnownHostsStore(dir).set("127.0.0.1", port, "AAAAC3NzaC1lZDI1NTE5AAAAIPINNEDBUTNOTTHISONE");
        const executor = pinnedSshExecutor(dir);
        const target = { address: "127.0.0.1", port, user: "root", privateKey: utils.generateKeyPairSync("ed25519").private };
        await expect(executor.connect(target)).rejects.toThrow(`host key mismatch for 127.0.0.1:${port}`);
        await executor.dispose?.();
    } finally {
        server.close();
        await rm(dir, { recursive: true, force: true });
    }
});
