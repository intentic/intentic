import { EventQueue } from "./event-queue.js";

test("drains every buffered value in order before ending, including undefined", async () => {
    const queue = new EventQueue<string | undefined>();
    queue.push(undefined);
    queue.push("last");
    queue.end();
    const received: (string | undefined)[] = [];
    for await (const value of queue) {
        received.push(value);
    }
    expect(received).toEqual([undefined, "last"]);
});

test("end drains values arriving before the reader observes the empty queue", async () => {
    const queue = new EventQueue<string>();
    queue.push("accepted");
    queue.end();
    const reader = queue[Symbol.asyncIterator]();
    expect(await reader.next()).toEqual({ value: "accepted", done: false });
    queue.push("late");
    queue.end();
    expect(await reader.next()).toEqual({ value: "late", done: false });
    expect(await reader.next()).toEqual({ value: undefined, done: true });
    queue.push("after draining");
    expect(await reader.next()).toEqual({ value: undefined, done: true });
});

test("wakes a waiting reader on a push and on end", async () => {
    const queue = new EventQueue<string>();
    const reader = queue[Symbol.asyncIterator]();
    const first = reader.next();
    queue.push("live");
    expect(await first).toEqual({ value: "live", done: false });
    const last = reader.next();
    queue.end();
    expect(await last).toEqual({ value: undefined, done: true });
    queue.push("after end");
    expect(await reader.next()).toEqual({ value: undefined, done: true });
});
