import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PushSubscription } from "@intentic/sandbox-contract";
import { afterEach, expect, test, vi } from "vitest";
import { filePushStore } from "./push-store.js";
import { turnAwaiting, turnFinished } from "./notifications.js";

const tempDirs: string[] = [];
afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
        await rm(dir, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
});

const storePath = async (): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), "intentic-push-"));
    tempDirs.push(dir);
    return join(dir, "push.json");
};

const subscription = (endpoint: string): PushSubscription => ({ endpoint, keys: { p256dh: "p256dh-key", auth: "auth-secret" } });

test("the VAPID keypair is generated once and reused across store instances", async () => {
    const path = await storePath();
    const first = await filePushStore(path).keys();
    expect(first.publicKey).not.toBe("");
    expect(first.privateKey).not.toBe("");

    // A fresh store over the same file must NOT mint a new pair: every live browser subscription is bound to
    // the public key it was created with, so rotating would silently orphan every device.
    expect(await filePushStore(path).keys()).toEqual(first);
});

test("the private key is written 0600 — it can forge notifications to the owner's devices", async () => {
    const path = await storePath();
    await filePushStore(path).keys();
    const { mode } = await (await import("node:fs/promises")).stat(path);
    expect(mode & 0o777).toBe(0o600);
});

test("subscriptions round-trip and survive a reload", async () => {
    const path = await storePath();
    const store = filePushStore(path);
    await store.add(subscription("https://push.example/a"));
    await store.add(subscription("https://push.example/b"));

    expect((await filePushStore(path).list()).map((entry) => entry.endpoint)).toEqual(["https://push.example/a", "https://push.example/b"]);
});

test("re-subscribing the same endpoint replaces its row rather than duplicating it", async () => {
    const path = await storePath();
    const store = filePushStore(path);
    await store.add(subscription("https://push.example/a"));
    await store.add({ endpoint: "https://push.example/a", keys: { p256dh: "rotated", auth: "rotated" } });

    const list = await store.list();
    // Two rows would mean two notifications per event for one browser.
    expect(list).toHaveLength(1);
    expect(list[0]?.keys.p256dh).toBe("rotated");
});

test("concurrent subscribes do not lose one another", async () => {
    const path = await storePath();
    const store = filePushStore(path);
    // Read-modify-write on one file: without serialization the later write clobbers the earlier row.
    await Promise.all([
        store.add(subscription("https://push.example/a")),
        store.add(subscription("https://push.example/b")),
        store.add(subscription("https://push.example/c")),
    ]);
    expect(await filePushStore(path).list()).toHaveLength(3);
});

test("unsubscribe removes only the named endpoint", async () => {
    const path = await storePath();
    const store = filePushStore(path);
    await store.add(subscription("https://push.example/a"));
    await store.add(subscription("https://push.example/b"));
    await store.remove("https://push.example/a");
    expect((await store.list()).map((entry) => entry.endpoint)).toEqual(["https://push.example/b"]);
});

test("a corrupt store file is replaced rather than crashing the daemon", async () => {
    const path = await storePath();
    await (await import("node:fs/promises")).writeFile(path, "{ not json");
    // Losing subscriptions is recoverable (each browser re-subscribes); refusing to boot is not.
    const keys = await filePushStore(path).keys();
    expect(keys.publicKey).not.toBe("");
    expect(JSON.parse(await readFile(path, "utf8")).subscriptions).toEqual([]);
});

test("a finished turn notification carries the prompt, trimmed at a word boundary", () => {
    const prompt = `${"word ".repeat(40)}tail`;
    const notification = turnFinished("conv-1", prompt, { ok: true });
    expect(notification.title).toBe("Turn finished");
    expect(notification.body.endsWith("…")).toBe(true);
    expect(notification.body.length).toBeLessThanOrEqual(91);
    // No mid-word cut.
    expect(notification.body).not.toMatch(/wor…$/);
    expect(notification.url).toBe("/?conversation=conv-1");
});

test("a failed turn reports the error, not the prompt", () => {
    const notification = turnFinished("conv-1", "do the thing", { ok: false, error: "provider rejected the model" });
    expect(notification.title).toBe("Turn failed");
    expect(notification.body).toBe("provider rejected the model");
});

test("finished and awaiting notifications collapse per conversation, and only awaiting is sticky", () => {
    // A chatty turn asking three permissions must leave ONE notification, not three.
    expect(turnAwaiting("conv-1", "permission").tag).toBe(turnAwaiting("conv-1", "question").tag);
    expect(turnAwaiting("conv-1", "plan").requireInteraction).toBe(true);
    // Different conversations stay distinct.
    expect(turnAwaiting("conv-2", "plan").tag).not.toBe(turnAwaiting("conv-1", "plan").tag);
    // A "finished" notice may auto-dismiss; a blocked agent's request may not.
    expect(turnFinished("conv-1", "x", { ok: true }).requireInteraction).toBeUndefined();
    expect(turnFinished("conv-1", "x", { ok: true }).tag).not.toBe(turnAwaiting("conv-1", "plan").tag);
});
