import { siblingModule, workerCalls, workerPool } from "./worker-calls.js";

// Against a real worker thread: answers find their calls, a refusal costs its call, a crash only the calls in flight.

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

test("a pool spreads calls in flight together across its threads, and grows only while every thread is busy", async () => {
    const pool = workerPool<{ readonly say: string }>(siblingModule(import.meta, "echo-worker.testing"), undefined, 3);
    const together = await Promise.all(Array.from({ length: 3 }, () => pool.call<number>({ say: "thread" })));
    expect(new Set(together).size).toBe(3);
    // One at a time, the least busy thread is always idle, so no fourth thread is started past the pool's size.
    const first = await pool.call<number>({ say: "thread" });
    const second = await pool.call<number>({ say: "thread" });
    expect(together).toContain(first);
    expect(together).toContain(second);
    const crowd = await Promise.all(Array.from({ length: 9 }, () => pool.call<number>({ say: "thread" })));
    expect(new Set(crowd)).toEqual(new Set(together));
    await pool.close();
});

test("a pool lets its extra threads go once they sit idle, and keeps its first", async () => {
    const pool = workerPool<{ readonly say: string }>(siblingModule(import.meta, "echo-worker.testing"), undefined, 3, 100);
    const busy = await Promise.all(Array.from({ length: 3 }, () => pool.call<number>({ say: "thread" })));
    const [first = -1] = busy;
    await new Promise((resolve) => setTimeout(resolve, 300));
    // Only the first survives the idle spell, so calls issued together now land on it and on fresh threads.
    const after = await Promise.all(Array.from({ length: 3 }, () => pool.call<number>({ say: "thread" })));
    expect(after).toContain(first);
    expect(after.filter((id) => busy.includes(id))).toEqual([first]);
    await pool.close();
});
