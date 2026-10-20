import { onRuntimeChange, publishRuntimeChange, publishRuntimeMilestone } from "./runtime-feed.js";

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
    const started = Date.now();
    const stop = onRuntimeChange((domains) => heard.push({ at: Date.now() - started, domains: [...domains] }));
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
