import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PushSubscription } from "@intentic/sandbox-contract";
import type { Logger } from "pino";
import { afterEach, expect, test, vi } from "vitest";
import webpush, { WebPushError } from "web-push";
import { createPushSender } from "./push.js";
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

const silentLogger = { debug: () => undefined, warn: () => undefined } as unknown as Logger;

// Stubs every send, refusing the endpoints named in `refusals` with the given status.
const stubSends = (refusals: Record<string, number>): void => {
    vi.spyOn(webpush, "setVapidDetails").mockImplementation(() => undefined);
    vi.spyOn(webpush, "sendNotification").mockImplementation(async (target) => {
        const status = refusals[target.endpoint];
        if (status !== undefined) {
            throw new WebPushError("refused", status, {}, "", target.endpoint);
        }
        return { statusCode: 201, body: "", headers: {} };
    });
};

const sample = { title: "intentic", body: "done", tag: "t" };

test("a 403 drops the subscription — a recreated sandbox's stale endpoints must not be retried forever", async () => {
    const path = await storePath();
    const store = filePushStore(path);
    await store.add(subscription("https://push.example/stale"));
    await store.add(subscription("https://push.example/live"));
    // 403 is the push service saying "this endpoint was minted for a different VAPID key". Our key never
    // rotates back, so the row is dead — and keeping it would let the settings toggle keep claiming "on".
    stubSends({ "https://push.example/stale": 403 });

    await createPushSender(store, silentLogger).notify(sample);

    expect((await store.list()).map((entry) => entry.endpoint)).toEqual(["https://push.example/live"]);
});

test("a transient 500 keeps the subscription and does not fail the caller", async () => {
    const path = await storePath();
    const store = filePushStore(path);
    await store.add(subscription("https://push.example/flaky"));
    stubSends({ "https://push.example/flaky": 500 });

    // A turn must complete identically whether the push service is up, down, or slow.
    await expect(createPushSender(store, silentLogger).notify(sample)).resolves.toBeUndefined();
    expect(await store.list()).toHaveLength(1);
});

test("one dead endpoint does not stop the others being notified", async () => {
    const path = await storePath();
    const store = filePushStore(path);
    await store.add(subscription("https://push.example/gone"));
    await store.add(subscription("https://push.example/live"));
    stubSends({ "https://push.example/gone": 410 });

    await createPushSender(store, silentLogger).notify(sample);

    expect(vi.mocked(webpush.sendNotification)).toHaveBeenCalledTimes(2);
    expect((await store.list()).map((entry) => entry.endpoint)).toEqual(["https://push.example/live"]);
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
