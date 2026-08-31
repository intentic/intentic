import { expect, test } from "vitest";

import { parseDuration, ReadinessTimeoutError, waitReady } from "./readiness.js";

test("parseDuration parses second durations", () => {
    expect(parseDuration("120s")).toBe(120000);
    expect(parseDuration("90s")).toBe(90000);
    expect(parseDuration("60s")).toBe(60000);
});

test("parseDuration rejects unsupported formats", () => {
    expect(() => parseDuration("5m")).toThrow();
    expect(() => parseDuration("abc")).toThrow();
});

test("waitReady resolves once the probe succeeds", async () => {
    let calls = 0;
    await waitReady(
        "svc",
        "https://x/health",
        { timeout: "60s" },
        async () => {
            calls += 1;
            return calls >= 3;
        },
        1,
    );
    expect(calls).toBe(3);
});

test("waitReady throws ReadinessTimeoutError when the probe never succeeds before the deadline", async () => {
    const error = await waitReady("svc", "https://x/health", { timeout: "0s" }, async () => false, 1).then(
        () => undefined,
        (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(ReadinessTimeoutError);
    const timeout = error as ReadinessTimeoutError;
    expect(timeout.id).toBe("svc");
    expect(timeout.url).toBe("https://x/health");
    expect(timeout.timeoutMs).toBe(0);
    expect(timeout.message).toContain(timeout.url);
    expect(timeout.message).toContain(timeout.id);
    expect(timeout.message).toMatch(/0ms/);
});
