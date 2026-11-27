import { tmpdir } from "node:os";
import { join } from "node:path";
import { waitFor } from "@intentic/testing/bun";
import { createExtensionRuntime } from "./runtime.js";
import type { SleepNotice } from "./server.js";
import { FAKE_PUBLIC_URL, FAKE_WAKE_SECRET } from "./sleep-fake.js";
import { type FakeExtension, fakeExtensionApi } from "./testing.js";

// `api.sleep` (sleep-reach.ts) through the SDK's own fake daemon (testing.ts, sleep-fake.ts): a wake URL only for a route
// the manifest says wakes, before-sleep handlers told at once and answered ready, and what a boot follows.

const opened: FakeExtension[] = [];
afterEach(async () => {
    await Promise.all(opened.splice(0).map((each) => each.dispose()));
});

const LISTENER = { provider: "chatty" };

// The runtime opens its before-sleep watch a moment after the first handler registers.
const watching = (extension: FakeExtension) =>
    waitFor(() => expect(extension.calls.map((call) => call.line)).toContain("POST /extension/sleep/watch"));
const fake = async (): Promise<FakeExtension> => {
    const made = await fakeExtensionApi({
        manifest: {
            publisher: "acme",
            name: "chatty",
            contributes: {
                listener: LISTENER,
                publicRoutes: [
                    { path: "*/events", methods: ["POST"], automation: true, wakes: true },
                    { path: "hook", methods: ["POST"], wakes: true },
                    { path: "status", methods: ["GET"] },
                ],
            },
        },
    });
    opened.push(made);
    return made;
};

test("a wake URL names one of its own `wakes` routes, the automation filled in and the wake secret in its query", async () => {
    const extension = await fake();
    expect(await extension.api.sleep.wakeUrl("*/events", { automationId: "auto-7" })).toBe(
        `${FAKE_PUBLIC_URL}/door/acme.chatty/auto-7/events?wake=${FAKE_WAKE_SECRET}`,
    );
    expect(await extension.api.sleep.wakeUrl("hook")).toBe(`${FAKE_PUBLIC_URL}/door/acme.chatty/hook?wake=${FAKE_WAKE_SECRET}`);
    await expect(extension.api.sleep.wakeUrl("status")).rejects.toThrow(/^daemon answered 400 for POST \/extension\/sleep\/wake-url: .*status.* declares `wakes: true`/u);
    await expect(extension.api.sleep.wakeUrl("*/events")).rejects.toThrow(/is an automation's: name it/u);
    expect(extension.sleep.wakeUrls).toHaveLength(2);
});

test("every before-sleep handler is told at once, under one deadline, and the sandbox hears it is ready", async () => {
    const extension = await fake();
    const heard: SleepNotice[] = [];
    let finish: () => void = () => undefined;
    const slow = new Promise<void>((resolve) => {
        finish = resolve;
    });
    extension.api.sleep.beforeSleep((notice) => {
        heard.push(notice);
        return slow;
    });
    extension.api.sleep.beforeSleep((notice) => void heard.push(notice));
    await watching(extension);
    const sleeping = extension.sleep.now();
    await waitFor(() => expect(heard).toHaveLength(2));
    expect(heard[0]?.deadline).toBe(heard[1]?.deadline);
    expect(heard[0]?.deadline ?? 0).toBeGreaterThan(Date.now());
    finish();
    expect(await sleeping).toBe(1);
});

test("a handler that throws is said in the log and still lets the sandbox sleep", async () => {
    const extension = await fake();
    extension.api.sleep.beforeSleep(() => {
        throw new Error("telegram said no");
    });
    await watching(extension);
    expect(await extension.sleep.now()).toBe(1);
    expect(extension.logs).toContain("a before-sleep handler threw: telegram said no");
});

test("with every handler disposed nothing is watching, so a sleep waits on nobody", async () => {
    const extension = await fake();
    const handler = extension.api.sleep.beforeSleep(() => undefined);
    await watching(extension);
    handler.dispose();
    await waitFor(async () => expect(await extension.sleep.now()).toBe(0));
});

test("a boot says what it follows, and a daemon from before these doors says neither", async () => {
    const extension = await fake();
    expect(await extension.api.sleep.boot()).toEqual({ afterSleep: false, requestWake: false });
    extension.sleep.boot = { afterSleep: true, requestWake: true };
    expect(await extension.api.sleep.boot()).toEqual({ afterSleep: true, requestWake: true });
    const older = createExtensionRuntime({
        id: "acme.chatty",
        daemonUrl: "http://daemon.internal",
        token: "token",
        permissions: [],
        // Never touched: this runtime is asked only what this boot follows.
        workspaceRoot: join(tmpdir(), "absent-workspace"),
        extensionDir: join(tmpdir(), "absent-extension"),
        stateDir: join(tmpdir(), "absent-state"),
        cacheDir: join(tmpdir(), "absent-cache"),
        log: () => undefined,
        fetch: async () => new Response("not found", { status: 404 }),
    });
    expect(await older.api.sleep.boot()).toEqual({ afterSleep: false, requestWake: false });
    older.close();
});

test("what the platform heard for its connections while the sandbox slept is handed over once", async () => {
    const extension = await fake();
    const message = { service: "discord", connection: "discord-team", channelId: "100", messageId: "1", guildId: "9", at: 1_800_000_000_000 };
    extension.sleep.heard = [message];
    expect(await extension.api.sleep.heard()).toEqual([message]);
    expect(await extension.api.sleep.heard()).toEqual([]);
});
