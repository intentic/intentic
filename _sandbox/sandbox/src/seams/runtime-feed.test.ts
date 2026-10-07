import { onRuntimeChange, publishRuntimeChange } from "./runtime-feed.js";

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
