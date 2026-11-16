import { createFailureTracker } from "./failure-backoff.js";

// random() = 1 takes the top of each jittered rung, so the waits read as plain doublings.
const tracker = (at: { now: number }, flapMs = 60_000) =>
    createFailureTracker({ backoff: { floorMs: 1000, capMs: 8000 }, flapMs, now: () => at.now, random: () => 1 });

test("each failure in a row doubles the wait up to the cap, and a success resets it", () => {
    const at = { now: 0 };
    const failures = tracker(at);
    expect(failures.due("registry")).toBe(true);
    expect(failures.failed("registry", "fetch failed").retryAt).toBe(2000);
    expect(failures.due("registry")).toBe(false);
    at.now = 2000;
    expect(failures.due("registry")).toBe(true);
    expect(failures.failed("registry", "fetch failed").retryAt).toBe(2000 + 4000);
    at.now = 6000;
    expect(failures.failed("registry", "fetch failed").retryAt).toBe(6000 + 8000);
    at.now = 14_000;
    expect(failures.failed("registry", "fetch failed").retryAt).toBe(14_000 + 8000);
    failures.succeeded("registry");
    expect(failures.due("registry")).toBe(true);
    expect(failures.failed("registry", "fetch failed").retryAt).toBe(14_000 + 2000);
});

test("a reason is written once per outage, however it alternates, and the recovery once", () => {
    const at = { now: 0 };
    const failures = tracker(at);
    expect(failures.failed("acct", "403 org").log).toBe(true);
    expect(failures.failed("acct", "429").log).toBe(true);
    expect(failures.failed("acct", "403 org")).toMatchObject({ log: false, repeated: 1 });
    expect(failures.failed("acct", "429")).toMatchObject({ log: false, repeated: 2 });
    at.now = 500;
    expect(failures.succeeded("acct")).toEqual({ state: "429", repeated: 2, since: 0 });
    expect(failures.succeeded("acct")).toBeUndefined();
});

test("a failure soon after a recovery continues the outage; one after the flap window is news again", () => {
    const at = { now: 0 };
    const failures = tracker(at, 60_000);
    failures.failed("repo", "fetch failed");
    expect(failures.succeeded("repo")).toMatchObject({ state: "fetch failed" });
    at.now = 30_000;
    expect(failures.failed("repo", "fetch failed").log).toBe(false);
    // Nothing new was said, so its end is not news either.
    expect(failures.succeeded("repo")).toBeUndefined();
    at.now = 30_000 + 60_000;
    expect(failures.failed("repo", "fetch failed").log).toBe(true);
});

test("a permanent failure is not retried until its input changes", () => {
    const at = { now: 0 };
    const failures = tracker(at);
    expect(failures.failed("token", "403 org", { permanent: true, input: "t1" }).retryAt).toBeUndefined();
    at.now = 10 ** 9;
    expect(failures.due("token", "t1")).toBe(false);
    expect(failures.due("token", "t2")).toBe(true);
    expect(failures.due("token", "t2")).toBe(true);
});

test("without a backoff only permanent failures hold anything back, and forget drops a key", () => {
    const failures = createFailureTracker({ now: () => 0 });
    failures.failed("k", "500");
    expect(failures.due("k")).toBe(true);
    failures.failed("k", "403", { permanent: true });
    expect(failures.due("k")).toBe(false);
    failures.forget("k");
    expect(failures.due("k")).toBe(true);
    expect(failures.failed("k", "403").log).toBe(true);
});
