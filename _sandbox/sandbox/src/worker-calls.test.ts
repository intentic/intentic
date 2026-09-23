import { expect, test } from "bun:test";
import { siblingModule, workerCalls } from "./worker-calls.js";

// Pins the channel's promises against a real worker thread: answers find their own calls, a refusal costs only its
// call, a crash costs the calls in flight and not the next one, and news reaches the caller.

const echo = (onNews?: (news: string) => void) =>
    workerCalls<{ readonly say: string }, string>(siblingModule(import.meta, "echo-worker.testing"), undefined, onNews);

test("each answer finds its own call, however many are in flight", async () => {
    const calls = echo();
    const answers = await Promise.all(["a", "b", "c"].map((say) => calls.call<string>({ say })));
    expect(answers).toEqual(["echo:a", "echo:b", "echo:c"]);
    await calls.close();
});

test("a refusal rejects its own call and leaves the thread serving", async () => {
    const calls = echo();
    await expect(calls.call({ say: "refuse" })).rejects.toThrow("refused");
    expect(await calls.call<string>({ say: "still here" })).toBe("echo:still here");
    await calls.close();
});

test("a thread that dies fails the calls in flight, and the next call gets a fresh one", async () => {
    const calls = echo();
    await expect(calls.call({ say: "die" })).rejects.toThrow("exited");
    expect(await calls.call<string>({ say: "again" })).toBe("echo:again");
    await calls.close();
});

test("news the thread posts reaches the caller before the answer that follows it", async () => {
    const heard: string[] = [];
    const calls = echo((news) => heard.push(news));
    expect(await calls.call<string>({ say: "news" })).toBe("echo:news");
    expect(heard).toEqual(["fresh"]);
    await calls.close();
});
