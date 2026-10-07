import { endedAfterStop } from "./stop-grace.js";

// A runtime wedged on a read that never answers, the shape a killed OpenCode server left a stopped Gemini turn in.
async function* wedgedAfter<T>(frames: readonly T[]): AsyncGenerator<T> {
    yield* frames;
    await new Promise<never>(() => {});
}

const collect = async <T>(frames: AsyncIterable<T>): Promise<T[]> => {
    const seen: T[] = [];
    for await (const frame of frames) {
        seen.push(frame);
    }
    return seen;
};

test("a stopped turn whose runtime never winds down ends once the grace runs out", async () => {
    const controller = new AbortController();
    let abandoned = 0;
    const frames = endedAfterStop(wedgedAfter(["a", "b"]), controller.signal, () => (abandoned += 1), 20);
    const done = collect(frames);
    setTimeout(() => controller.abort(), 5);

    await expect(done).resolves.toStrictEqual(["a", "b"]);
    expect(abandoned).toBe(1);
});

test("a stream that is never stopped is waited on for as long as it runs", async () => {
    let abandoned = 0;
    async function* slow(): AsyncGenerator<string> {
        await new Promise((resolve) => setTimeout(resolve, 40));
        yield "late";
    }

    await expect(collect(endedAfterStop(slow(), new AbortController().signal, () => (abandoned += 1), 10))).resolves.toStrictEqual(["late"]);
    expect(abandoned).toBe(0);
});

test("a runtime that winds down within the grace ends on its own, with nothing abandoned", async () => {
    const controller = new AbortController();
    let abandoned = 0;
    async function* obedient(signal: AbortSignal): AsyncGenerator<string> {
        yield "a";
        await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
        yield "wound down";
    }
    const done = collect(endedAfterStop(obedient(controller.signal), controller.signal, () => (abandoned += 1), 1_000));
    setTimeout(() => controller.abort(), 5);

    await expect(done).resolves.toStrictEqual(["a", "wound down"]);
    expect(abandoned).toBe(0);
});

test("a consumer leaving early returns the runtime's stream, as a for-await would", async () => {
    let returned = false;
    async function* source(): AsyncGenerator<string> {
        try {
            yield "a";
            yield "b";
        } finally {
            returned = true;
        }
    }
    for await (const frame of endedAfterStop(source(), undefined, () => {})) {
        expect(frame).toBe("a");
        break;
    }
    expect(returned).toBe(true);
});

// Every read used to race one promise of the grace, pending for as long as nobody stops the turn: each race left a
// reaction on it, and every frame of the turn stayed reachable until the turn ended.
test("a long turn that is never stopped keeps none of the frames already passed on", async () => {
    const reads = 400;
    const passed: WeakRef<object>[] = [];
    const { promise: endTurn, resolve: ending } = Promise.withResolvers<void>();
    async function* turn(): AsyncGenerator<{ readonly payload: number[] }> {
        for (let read = 0; read < reads; read += 1) {
            const frame = { payload: Array.from({ length: 1_000 }, () => read) };
            passed.push(new WeakRef(frame));
            yield frame;
        }
        await endTurn;
    }
    const frames = endedAfterStop(turn(), new AbortController().signal, () => {})[Symbol.asyncIterator]();
    for (let read = 0; read < reads; read += 1) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- the consumer reads frame by frame, as the turn's does
        await frames.next();
    }
    // The turn is still open: the stream waits on its next read.
    const last = frames.next();
    await new Promise((resolve) => setTimeout(resolve, 0));
    Bun.gc(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    Bun.gc(true);

    expect(passed.filter((frame) => frame.deref() !== undefined).length).toBeLessThan(reads / 10);
    ending();
    await expect(last).resolves.toMatchObject({ done: true });
});
