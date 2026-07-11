import { expect, test } from "vitest";
import type { SshExecutor, SshSession, SshTarget } from "./ssh.js";
import { connectWithRetry, inMemoryHostKeyStore, verifyHostKey } from "./ssh.js";

test("an unseen host is trusted on first use and its key is pinned", async () => {
    const store = inMemoryHostKeyStore();
    expect(await verifyHostKey(store, "203.0.113.10", 22, "KEY_A")).toBe("ok");
    expect(await store.get("203.0.113.10", 22)).toBe("KEY_A");
});

test("a pinned host presenting the same key is accepted", async () => {
    const store = inMemoryHostKeyStore();
    await verifyHostKey(store, "203.0.113.10", 22, "KEY_A");
    expect(await verifyHostKey(store, "203.0.113.10", 22, "KEY_A")).toBe("ok");
});

test("a pinned host presenting a different key is a mismatch and the pin is unchanged", async () => {
    const store = inMemoryHostKeyStore();
    await verifyHostKey(store, "203.0.113.10", 22, "KEY_A");
    expect(await verifyHostKey(store, "203.0.113.10", 22, "KEY_B")).toBe("mismatch");
    expect(await store.get("203.0.113.10", 22)).toBe("KEY_A");
});

test("the same address on a different port is a distinct host", async () => {
    const store = inMemoryHostKeyStore();
    await verifyHostKey(store, "203.0.113.10", 22, "KEY_A");
    expect(await verifyHostKey(store, "203.0.113.10", 2222, "KEY_B")).toBe("ok");
});

const target: SshTarget = { address: "ssh-abc.intentic.dev", user: "deploy", privateKey: "key", port: 22 };
// A distinguishable session so a test can assert connectWithRetry returns the live one.
const session = { exec: async () => ({ stdout: "", stderr: "", code: 0 }), dispose: async () => {} } as SshSession;

test("connectWithRetry returns the session once a booting host accepts SSH", async () => {
    let attempts = 0;
    const executor: SshExecutor = {
        connect: async () => {
            attempts += 1;
            if (attempts < 3) {
                throw new Error("read ECONNRESET");
            }
            return session;
        },
    };
    expect(await connectWithRetry(executor, target, { timeoutMs: 1000, intervalMs: 1 })).toBe(session);
    expect(attempts).toBe(3);
});

test("connectWithRetry propagates the last connect error once the deadline passes", async () => {
    let attempts = 0;
    const executor: SshExecutor = {
        connect: async () => {
            attempts += 1;
            throw new Error(`ECONNRESET #${attempts}`);
        },
    };
    await expect(connectWithRetry(executor, target, { timeoutMs: 20, intervalMs: 5 })).rejects.toThrow(/ECONNRESET #\d+/);
    expect(attempts).toBeGreaterThan(1);
});

test("connectWithRetry logs a retry line while the host is still booting", async () => {
    let attempts = 0;
    const logs: string[] = [];
    const executor: SshExecutor = {
        connect: async () => {
            attempts += 1;
            if (attempts < 2) {
                throw new Error("no such host");
            }
            return session;
        },
    };
    await connectWithRetry(executor, target, { timeoutMs: 1000, intervalMs: 1, log: (message) => logs.push(message) });
    expect(logs.some((message) => message.includes("ssh-abc.intentic.dev:22") && message.includes("retrying"))).toBe(true);
});

test("connectWithRetry connects first-try against a reachable host without logging", async () => {
    const logs: string[] = [];
    const executor: SshExecutor = { connect: async () => session };
    expect(await connectWithRetry(executor, target, { log: (message) => logs.push(message) })).toBe(session);
    expect(logs).toEqual([]);
});
