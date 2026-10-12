import type { IntenticLine } from "@intentic/sandbox-contract";
import { ORPCError } from "@orpc/client";
import { StreamEndedError, StreamFailedError, untilResult } from "../intenticStream";

// A command stream as the typed client hands it over: the lines in order, then a clean end, or `then` thrown in place
// of the end. `closed` records whether the reader let go of it.
const stream = (lines: readonly IntenticLine[], then?: unknown) => {
    const state = { closed: false, pulled: 0 };
    async function* frames(): AsyncGenerator<IntenticLine> {
        try {
            for (const line of lines) {
                state.pulled += 1;
                yield line;
            }
            if (then !== undefined) {
                throw then;
            }
        } finally {
            state.closed = true;
        }
    }
    return { frames: frames(), state };
};

const failed = (): string => `It failed.`;

// What the read rejected with, checked to be of the expected class so the assertions below read its fields typed.
const rejection = async <E extends Error>(reading: Promise<unknown>, kind: new (...args: never[]) => E): Promise<E> => {
    const thrown = await reading.then(
        () => undefined,
        (error: unknown) => error,
    );
    if (!(thrown instanceof kind)) {
        throw new Error(`expected a ${kind.name}, got ${String(thrown)}`);
    }
    return thrown;
};

describe(`untilResult`, () => {
    it(`returns the result line once the stream ends`, async () => {
        const { frames } = stream([
            { kind: `log`, message: `working` },
            { kind: `result`, pushed: [`A`] },
        ]);
        await expect(untilResult(frames, { failed })).resolves.toEqual({ kind: `result`, pushed: [`A`] });
    });

    it(`returns the last result line when the stream sent several`, async () => {
        const { frames } = stream([
            { kind: `result`, n: 1 },
            { kind: `result`, n: 2 },
        ]);
        await expect(untilResult(frames, { failed })).resolves.toEqual({ kind: `result`, n: 2 });
    });

    it(`hands every line to onLine, the error line included`, async () => {
        const seen: IntenticLine[] = [];
        const lines: IntenticLine[] = [{ kind: `log`, message: `one` }, { kind: `heartbeat` }, { kind: `result`, ok: true }];
        await untilResult(stream(lines).frames, { failed, onLine: (line) => seen.push(line) });
        expect(seen).toEqual(lines);
        seen.length = 0;
        await untilResult(stream([{ kind: `log`, message: `one` }, { kind: `error` }]).frames, { failed, onLine: (line) => seen.push(line) }).catch(
            () => undefined,
        );
        expect(seen).toEqual([{ kind: `log`, message: `one` }, { kind: `error` }]);
    });

    it(`throws the error line's own message`, async () => {
        const { frames } = stream([{ kind: `error`, message: `CLOUDFLARE_API_TOKEN is not set` }]);
        const error = await rejection(untilResult(frames, { failed }), StreamFailedError);
        expect(error.message).toBe(`CLOUDFLARE_API_TOKEN is not set`);
        expect(error.line).toEqual({ kind: `error`, message: `CLOUDFLARE_API_TOKEN is not set` });
    });

    // The drift this replaced: one site ignored such a line and reported success.
    it(`throws the caller's words on an error line without a message`, async () => {
        const silent: IntenticLine[] = [{ kind: `error` }, { kind: `error`, message: `` }, { kind: `error`, message: 42 }];
        for (const line of silent) {
            const error = await rejection(untilResult(stream([line]).frames, { failed }), StreamFailedError);
            expect(error.message).toBe(`It failed.`);
        }
    });

    it(`stops at the first error line, even after a result, and closes the stream`, async () => {
        const { frames, state } = stream([
            { kind: `result`, ok: true },
            { kind: `error`, message: `exit 1` },
            { kind: `log`, message: `never read` },
        ]);
        await expect(untilResult(frames, { failed })).rejects.toThrow(`exit 1`);
        expect(state.pulled).toBe(2);
        await Promise.resolve();
        expect(state.closed).toBe(true);
    });

    // A daemon failure arrives as an ORPCError, which the reader turns into the stream's last error line.
    it(`reads a daemon failure mid-stream as an error line`, async () => {
        const { frames } = stream([{ kind: `log`, message: `working` }], new ORPCError(`INTERNAL_SERVER_ERROR`, { message: `apply failed: dns` }));
        const error = await rejection(untilResult(frames, { failed }), StreamFailedError);
        expect(error.message).toBe(`apply failed: dns`);
    });

    it(`rethrows a transport failure as it was thrown`, async () => {
        const broke = new TypeError(`network error`);
        const { frames } = stream([{ kind: `log`, message: `working` }], broke);
        await expect(untilResult(frames, { failed })).rejects.toBe(broke);
    });

    it(`throws StreamEndedError with the ended words when no result line came`, async () => {
        const ended = await rejection(untilResult(stream([{ kind: `log`, message: `working` }]).frames, { failed, ended: () => `No answer.` }), StreamEndedError);
        expect(ended.message).toBe(`No answer.`);
        const fallback = await rejection(untilResult(stream([]).frames, { failed }), StreamEndedError);
        expect(fallback.message).toBe(`It failed.`);
    });

    it(`rejects with the signal's reason when aborted mid-stream, without waiting for the next line`, async () => {
        const controller = new AbortController();
        let release: () => void = () => undefined;
        async function* hangs(): AsyncGenerator<IntenticLine> {
            yield { kind: `log`, message: `working` };
            await new Promise<void>((resolve) => {
                release = resolve;
            });
            yield { kind: `result`, ok: true };
        }
        const seen: string[] = [];
        const reading = untilResult(hangs(), { failed, signal: controller.signal, onLine: (line) => seen.push(line.kind) });
        await new Promise((resolve) => setTimeout(resolve, 0));
        const reason = new DOMException(`preview cancelled`, `AbortError`);
        controller.abort(reason);
        await expect(reading).rejects.toBe(reason);
        expect(seen).toEqual([`log`]);
        release();
    });

    it(`rejects at once on a signal already aborted, reading nothing`, async () => {
        const controller = new AbortController();
        controller.abort(new DOMException(`gone`, `AbortError`));
        const { frames, state } = stream([{ kind: `result`, ok: true }]);
        await expect(untilResult(frames, { failed, signal: controller.signal })).rejects.toMatchObject({ name: `AbortError`, message: `gone` });
        expect(state.pulled).toBe(0);
    });
});
