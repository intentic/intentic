import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyHostKey } from "@intentic/providers";
import { expect, test } from "vitest";
import { createKnownHostsStore } from "./known-hosts.js";

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
