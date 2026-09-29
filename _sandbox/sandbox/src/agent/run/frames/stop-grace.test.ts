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
