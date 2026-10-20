import { createLinkBackoff } from "./link-backoff.js";

// A wait after the far sandbox did not answer ends early when a call on the same link is answered, and only that link's.

test("an answer on the link ends its waits at once; another link's answer does not", async () => {
    const backoff = createLinkBackoff();
    const started = Date.now();
    const mine = backoff.wait("ops", 30_000);
    const theirs = backoff.wait("billing", 50);
    backoff.answered("ops");
    expect(await mine).toBe("woken");
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(await theirs).toBe("elapsed");
});

test("a wait with nothing answered runs its time; an abort ends it as elapsed", async () => {
    const backoff = createLinkBackoff();
    expect(await backoff.wait("ops", 20)).toBe("elapsed");
    const stop = new AbortController();
    const held = backoff.wait("ops", 30_000, stop.signal);
    stop.abort();
    expect(await held).toBe("elapsed");
    // A wait already over is not woken again, and an answer with no wait held is nothing.
    backoff.answered("ops");
});
