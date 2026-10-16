import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { z } from "zod";
import { unstubbed } from "@intentic/testing";
import type { CodexEvent, CodexRunner, CodexTurn, JsonValue } from "./codex-app-server.js";

// One event list per resumed turn; the last repeats if asked again. `steered[n]` is what turn n's steering channel
// delivered, drained before the turn's first yielded event so nothing races an assertion.
export const fakeCodexRunner = (...turns: readonly (readonly CodexEvent[])[]) => {
    const calls: CodexTurn[] = [];
    const steered: string[][] = [];
    const runner: CodexRunner = async function* (turn) {
        calls.push(turn);
        const delivered: string[] = [];
        steered.push(delivered);
        const steering = turn.steering;
        if (steering !== undefined) {
            void (async () => {
                for await (const text of steering) {
                    delivered.push(text);
                }
            })();
        }
        yield* turns[Math.min(calls.length - 1, turns.length - 1)] ?? [];
    };
    return { runner, calls, steered };
};

// An in-memory stdio child: protocol tests exercise the connector without starting Codex.
export const fakeCodexProcess = () => {
    const events = new EventEmitter();
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let kills = 0;
    const child: ChildProcessWithoutNullStreams = unstubbed<ChildProcessWithoutNullStreams>("codex child", {
        stdin,
        stdout,
        stderr,
        once: (event, listener) => {
            events.once(event, listener);
            return child;
        },
        killed: false,
        kill: () => {
            kills += 1;
            return true;
        },
    });
    const requests: { method: string; params: unknown }[] = [];
    stdin.on("data", (chunk: Buffer) => {
        const frame = z.object({ id: z.number().optional(), method: z.string(), params: z.unknown() }).parse(JSON.parse(chunk.toString()));
        requests.push({ method: frame.method, params: frame.params });
        if (frame.id !== undefined) {
            stdout.write(`${JSON.stringify({ id: frame.id, result: {} })}\n`);
        }
    });
    return {
        child,
        requests,
        kills: () => kills,
        notify: (method: string, params: JsonValue) => stdout.write(`${JSON.stringify({ method, params })}\n`),
    };
};
