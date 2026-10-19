import { closeNativePort, nativeRequest, setConnectNativeForTests, type NativePortLike } from "./native.js";

const makePort = (): { port: NativePortLike; push: (msg: unknown) => void; disconnect: () => void } => {
    const listeners = new Set<(message: unknown) => void>();
    const disconnectListeners = new Set<() => void>();
    let connected = true;
    const port: NativePortLike = {
        postMessage(message: unknown) {
            queueMicrotask(() => {
                if (!connected) {
                    return;
                }
                const parsed = message as { id?: string; type?: string };
                if (parsed.type === "hello") {
                    for (const cb of listeners) {
                        cb({ type: "hello", id: parsed.id, ok: true, setUp: true, locked: false, remember: true, version: "0" });
                    }
                }
            });
        },
        onMessage: {
            addListener(cb) {
                listeners.add(cb);
            },
            removeListener(cb) {
                listeners.delete(cb);
            },
        },
        onDisconnect: {
            addListener(cb) {
                disconnectListeners.add(cb);
            },
            removeListener(cb: () => void) {
                disconnectListeners.delete(cb);
            },
        },
        disconnect() {
            connected = false;
            for (const cb of disconnectListeners) {
                cb();
            }
        },
    };
    return {
        port,
        push: (msg) => {
            for (const cb of listeners) {
                cb(msg);
            }
        },
        disconnect: () => port.disconnect(),
    };
};

beforeEach(() => {
    closeNativePort();
    setConnectNativeForTests(undefined);
});

test("native requests correlate responses by id", async () => {
    const fake = makePort();
    setConnectNativeForTests(() => fake.port);
    const answer = await nativeRequest({ type: "hello", browser: "Chrome" });
    expect(answer.ok).toBe(true);
    if (answer.ok && answer.type === "hello") {
        expect(answer.remember).toBe(true);
    }
});

test("a slow native answer times out", async () => {
    const fake = makePort();
    setConnectNativeForTests(() => fake.port);
    await expect(nativeRequest({ type: "candidates", host: "github.com" }, { timeoutMs: 20 })).rejects.toThrow(/did not answer/);
    fake.push({ type: "candidates", id: "late", ok: true, items: [] });
});
