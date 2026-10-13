import { joinedThreads, runRegistry, stopFromChat } from "./chat-runs.js";
import type { Logger } from "./log.js";

const quiet: Logger = { info: () => {}, warn: () => {}, error: () => {} };

const control = () => {
    const stopped: string[] = [];
    return { stopped, run: { stopping: (by: string) => void stopped.push(by), adopt: () => {} } };
};

test("a running turn is found by its conversation and by its place, and forgotten once closed", () => {
    const runs = runRegistry();
    const { run } = control();
    runs.opened("conv-1", "thread-1", run);
    expect(runs.byConversation("conv-1")).toBe(run);
    expect(runs.running("thread-1")).toBe(run);
    expect(runs.conversationAt("thread-1")).toBe("conv-1");
    runs.closed("conv-1", "thread-1");
    expect(runs.byConversation("conv-1")).toBeUndefined();
    expect(runs.running("thread-1")).toBeUndefined();
    expect(runs.conversationAt("thread-1")).toBeUndefined();
});

test("closing an older turn leaves the newer one running in the same place", () => {
    const runs = runRegistry();
    const older = control().run;
    const newer = control().run;
    runs.opened("conv-1", "thread-1", older);
    runs.opened("conv-2", "thread-1", newer);
    runs.closed("conv-1", "thread-1");
    expect(runs.running("thread-1")).toBe(newer);
});

test("joined threads keep the most recent, bounded", () => {
    const joined = joinedThreads(2);
    joined.add("a");
    joined.add("b");
    joined.add("a");
    joined.add("c");
    expect([joined.has("a"), joined.has("b"), joined.has("c")]).toEqual([true, false, true]);
});

test("Stop: the daemon decides, a stopped turn's card names who pressed it, and every answer is a sentence", async () => {
    const runs = runRegistry();
    const { run, stopped } = control();
    runs.opened("conv-1", "thread-1", run);
    const author = { id: "U1", name: "mark" };
    expect(await stopFromChat({ stop: async () => ({ stopped: true }) }, runs, { conversationId: "conv-1", author }, "Mark", quiet)).toBe("Stopping it now.");
    expect(stopped).toEqual(["Mark"]);
    expect(await stopFromChat({ stop: async () => ({ stopped: false, reason: "Only the team can stop it." }) }, runs, { conversationId: "conv-1", author }, "Mark", quiet)).toBe(
        "Only the team can stop it.",
    );
    expect(await stopFromChat({ stop: () => Promise.reject(new Error("ECONNREFUSED")) }, runs, { conversationId: "conv-1", author }, "Mark", quiet)).toContain(
        "couldn't reach the sandbox",
    );
    expect(stopped).toEqual(["Mark"]);
});
