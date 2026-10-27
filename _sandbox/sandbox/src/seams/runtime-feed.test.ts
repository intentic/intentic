import { onRuntimeChange, publishRuntimeChange, publishRuntimeChangeTo, publishRuntimeMilestone, runtimeGeneration } from "./runtime-feed.js";

// One /events connection whose listener throws must not cost every other connection its frames.
test("a listener that throws is reported to its own logger, and the listeners after it still hear the change", async () => {
    const reported: unknown[] = [];
    const heard: string[][] = [];
    const stops = [
        onRuntimeChange(
            () => {
                throw new Error("a closed stream");
            },
            { warn: (detail: unknown) => void reported.push(detail) },
        ),
        onRuntimeChange((domains) => heard.push([...domains])),
    ];
    try {
        publishRuntimeChange("terminals");
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(heard).toEqual([["terminals"]]);
        expect(reported).toEqual([{ err: new Error("a closed stream"), domains: ["terminals"] }]);
    } finally {
        for (const stop of stops) {
            stop();
        }
    }
});

// Progress ticks fold under the subagents window; a child ending, the change they led up to, does not wait it out.
test("a milestone goes out within a quarter second inside the window chatter is folded under", async () => {
    const heard: { readonly at: number; readonly domains: string[] }[] = [];
    const started = performance.now();
    const stop = onRuntimeChange((domains) => heard.push({ at: performance.now() - started, domains: [...domains] }));
    try {
        publishRuntimeChange("subagents");
        await new Promise((resolve) => setTimeout(resolve, 20));
        // Chatter inside the window waits for its end, a second away.
        publishRuntimeChange("subagents");
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(heard).toHaveLength(1);
        publishRuntimeMilestone("subagents");
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(heard).toHaveLength(2);
        expect(heard[1]?.at).toBeLessThan(500);
        // The window restarts from the milestone's frame: chatter after it folds again.
        publishRuntimeChange("subagents");
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(heard).toHaveLength(2);
    } finally {
        stop();
    }
});

// The wall clock stepping back (an NTP or WSL resync) must not hold a frame until it catches up: the windows run on the
// monotonic clock. setSystemTime outside fake timers pins Date.now a minute in the past while real timers keep running.
test("a wall clock stepped back inside a window still lets the milestone out", async () => {
    let heard = 0;
    const stop = onRuntimeChange(() => {
        heard += 1;
    });
    try {
        publishRuntimeChange("subagents");
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(heard).toBe(1);
        jest.setSystemTime(Date.now() - 60_000);
        publishRuntimeMilestone("subagents");
        await new Promise((resolve) => setTimeout(resolve, 400));
        expect(heard).toBe(2);
    } finally {
        jest.setSystemTime();
        stop();
    }
});

// A domain moved for one person's windows (their drafts) names whose it is; one moved for everyone in the same window is
// everyone's, so no connection misses a change that was also its own.
test("a change published to people goes out once, naming them; one for everyone in the same window names nobody", async () => {
    const heard: { readonly domains: string[]; readonly audience: string[] | undefined }[] = [];
    const stop = onRuntimeChange((domains, audiences) => {
        const audience = audiences.get("drafts");
        heard.push({ domains: [...domains], audience: audience === undefined ? undefined : [...audience].toSorted() });
    });
    try {
        publishRuntimeChangeTo("ada@example.test", "drafts");
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(heard).toEqual([{ domains: ["drafts"], audience: ["ada@example.test"] }]);

        // Inside the window: two people's moves fold into one frame naming both.
        publishRuntimeChangeTo("bob@example.test", "drafts");
        publishRuntimeChangeTo("ada@example.test", "drafts");
        await new Promise((resolve) => setTimeout(resolve, 400));
        expect(heard[1]).toEqual({ domains: ["drafts"], audience: ["ada@example.test", "bob@example.test"] });

        publishRuntimeChangeTo("ada@example.test", "drafts");
        publishRuntimeChange("drafts");
        await new Promise((resolve) => setTimeout(resolve, 400));
        expect(heard[2]).toEqual({ domains: ["drafts"], audience: undefined });
    } finally {
        stop();
    }
});

// A read shared between the windows one frame sends to re-read is keyed by this count, so it must move at the change
// itself, listened to or not, never at the throttled flush.
test("every announced change moves its domain's generation at once, with or without a listener", () => {
    const before = runtimeGeneration("terminals");
    publishRuntimeChange("terminals");
    expect(runtimeGeneration("terminals")).toBe(before + 1);
    publishRuntimeChangeTo("ada@example.test", "terminals");
    expect(runtimeGeneration("terminals")).toBe(before + 2);
});
