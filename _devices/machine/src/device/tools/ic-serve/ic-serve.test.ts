import { advanceTimersByTimeAsync } from "@intentic/testing/bun";
import { z } from "zod";
import { createIcServe, type IcServeSeams, type ServeChild } from "./ic-serve.js";
import { servedRun } from "./ic-read.js";

/* The resident ic's client, against scripted servers: what it answers, when it has no answer and the caller spawns
   ic as before, and when it starts a fresh server. */

afterEach(() => jest.useRealTimers());

const RequestSchema = z.object({ id: z.number(), args: z.array(z.string()) });
const HELLO = JSON.stringify({
    serve: 1,
    verbs: [
        ["sandbox", "swaps", "--json"],
        ["sandbox", "list", "--json"],
    ],
});
const SWAPS = ["sandbox", "swaps", "--json"] as const;

// A scripted `ic serve`: says `hello` (or not) when started, answers each request with `reply`, and records its life.
interface Fake extends ServeChild {
    readonly requests: { id: number; args: string[] }[];
    ended: boolean;
    stopped: boolean;
    exited: boolean;
    readonly exit: () => void;
    readonly say: (line: string) => void;
}

const fakeChild = (hello: string | undefined, reply?: (request: { id: number; args: string[] }) => string | undefined): Fake => {
    const lines: ((line: string) => void)[] = [];
    const exits: (() => void)[] = [];
    const fake: Fake = {
        requests: [],
        ended: false,
        stopped: false,
        exited: false,
        say: (line) => {
            for (const listener of lines) {
                listener(line);
            }
        },
        exit: () => {
            fake.exited = true;
            for (const listener of exits) {
                listener();
            }
        },
        write: (line) => {
            const request = RequestSchema.parse(JSON.parse(line));
            fake.requests.push(request);
            const answer = reply?.(request);
            if (answer !== undefined) {
                queueMicrotask(() => fake.say(answer));
            }
        },
        onLine: (listener) => {
            lines.push(listener);
            if (hello !== undefined && lines.length === 1) {
                queueMicrotask(() => fake.say(hello));
            }
        },
        onExit: (listener) => {
            if (fake.exited) {
                listener();
            } else {
                exits.push(listener);
            }
        },
        end: () => {
            fake.ended = true;
        },
        stop: () => {
            fake.stopped = true;
            queueMicrotask(() => fake.exit());
        },
    };
    return fake;
};

const answering = (request: { id: number; args: string[] }): string =>
    JSON.stringify({
        id: request.id,
        code: 0,
        stdout: `[${JSON.stringify(request.args.join(" "))}]\n`,
        stderr: "",
        output: `[${JSON.stringify(request.args.join(" "))}]\n`,
    });

const world = (children: (() => Fake)[]) => {
    let signature = "ic:1:1";
    const started: Fake[] = [];
    const logs: string[] = [];
    const seams: IcServeSeams = {
        file: async () => ({ path: "/home/a/.intentic/ic/bin/ic", signature }),
        start: async () => {
            const next = children[started.length] ?? children.at(-1);
            if (next === undefined) {
                throw new Error("no child scripted");
            }
            const child = next();
            started.push(child);
            return child;
        },
        log: (line) => logs.push(line),
    };
    return {
        serve: createIcServe(seams),
        started,
        logs,
        replace: (to: string) => {
            signature = to;
        },
    };
};

test("a served verb is answered by one server, started once, with the verb's own bytes and exit code", async () => {
    const { serve, started } = world([() => fakeChild(HELLO, answering)]);
    const first = await serve.ask(SWAPS, 15_000);
    const second = await serve.ask(SWAPS, 15_000);
    expect(first).toEqual({ code: 0, stdout: '["sandbox swaps --json"]\n', stderr: "", output: '["sandbox swaps --json"]\n' });
    expect(second).toEqual(first);
    expect(started).toHaveLength(1);
    expect(started[0]?.requests.map(({ args }) => args)).toEqual([[...SWAPS], [...SWAPS]]);
});

test("an ic that does not serve says no hello: no answer, and that file is asked per call, never started again", async () => {
    jest.useFakeTimers();
    // An ic from before `serve`: clap prints its usage on stderr and exits 2, so its stdout says nothing and it ends.
    const old = (): Fake => {
        const child = fakeChild(undefined);
        queueMicrotask(() => child.exit());
        return child;
    };
    const { serve, started, logs } = world([old]);
    expect(await serve.ask(SWAPS, 15_000)).toBeUndefined();
    expect(await serve.ask(SWAPS, 15_000)).toBeUndefined();
    expect(started).toHaveLength(1);
    expect(logs.join("\n")).toContain("does not serve");

    // A server that never says anything at all is given up after the hello's window.
    const silent = world([() => fakeChild(undefined)]);
    const asked = silent.serve.ask(SWAPS, 15_000);
    await advanceTimersByTimeAsync(10_000);
    expect(await asked).toBeUndefined();
    expect(silent.started[0]?.stopped).toBe(true);
});

test("a verb the server does not name in its hello is not sent to it", async () => {
    const { serve, started } = world([() => fakeChild(HELLO, answering)]);
    expect(await serve.ask(["engine", "disk", "--json"], 15_000)).toBeUndefined();
    expect(started[0]?.requests).toEqual([]);
});

test("a replaced ic file ends the old server and starts the new one", async () => {
    const { serve, started, replace, logs } = world([() => fakeChild(HELLO, answering)]);
    await serve.ask(SWAPS, 15_000);
    replace("ic:2:2");
    expect(await serve.ask(SWAPS, 15_000)).toMatchObject({ code: 0 });
    expect(started).toHaveLength(2);
    expect(started[0]?.ended).toBe(true);
    expect(started[1]?.ended).toBe(false);
    expect(logs.join("\n")).toContain("replaced");
});

test("past the caller's deadline the server is stopped, the answer is a timeout, and the next ask starts a fresh one", async () => {
    jest.useFakeTimers();
    let hang = true;
    const { serve, started } = world([() => fakeChild(HELLO, (request) => (hang ? undefined : answering(request)))]);
    const asked = serve.ask(SWAPS, 15_000);
    await advanceTimersByTimeAsync(14_999);
    expect(started[0]?.stopped).toBe(false);
    await advanceTimersByTimeAsync(1);
    expect(await asked).toBe("timeout");
    expect(started[0]?.stopped).toBe(true);
    hang = false;
    expect(await serve.ask(SWAPS, 15_000)).toMatchObject({ code: 0 });
    expect(started).toHaveLength(2);
});

test("an ask while one is out has no answer here, so it spawns its own ic and never waits behind the other", async () => {
    let answerFirst: () => void = () => undefined;
    const { serve, started } = world([
        () => {
            const child = fakeChild(HELLO, (request) => {
                answerFirst = () => child.say(answering(request));
                return undefined;
            });
            return child;
        },
    ]);
    const first = serve.ask(SWAPS, 15_000);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await serve.ask(["sandbox", "list", "--json"], 15_000)).toBeUndefined();
    answerFirst();
    expect(await first).toMatchObject({ code: 0 });
    expect(started).toHaveLength(1);
});

test("a server that dies under a request gives no answer and is started again; three deaths in a row give it up", async () => {
    const dying = (): Fake => {
        const child = fakeChild(HELLO, () => {
            queueMicrotask(() => child.exit());
            return undefined;
        });
        return child;
    };
    const { serve, started, logs } = world([dying]);
    expect(await serve.ask(SWAPS, 15_000)).toBeUndefined();
    expect(await serve.ask(SWAPS, 15_000)).toBeUndefined();
    expect(started).toHaveLength(2);
    expect(await serve.ask(SWAPS, 15_000)).toBeUndefined();
    expect(logs.join("\n")).toContain("3 times in a row");
    expect(await serve.ask(SWAPS, 15_000)).toBeUndefined();
    expect(started).toHaveLength(3);
});

test("a line on the server's stdout that is not the answer awaited is passed over", async () => {
    const { serve } = world([
        () => {
            const child = fakeChild(HELLO, (request) => {
                queueMicrotask(() => child.say("stray"));
                queueMicrotask(() => child.say(JSON.stringify({ id: request.id + 100, code: 9 })));
                return answering(request);
            });
            return child;
        },
    ]);
    expect(await serve.ask(SWAPS, 15_000)).toMatchObject({ code: 0 });
});

test("a served answer reads as the run a spawned ic would have reported: lines of both streams, no trailing empty line", () => {
    expect(servedRun({ code: 3, stdout: '{"level":"ok"}\n', stderr: "intentic: slow\r\n", output: 'intentic: slow\r\n{"level":"ok"}\n' })).toEqual({
        code: 3,
        output: 'intentic: slow\n{"level":"ok"}',
    });
});
