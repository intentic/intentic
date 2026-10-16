import type { AttachFrame } from "@intentic/sandbox-contract/events/agent-events";
import { advanceTimersByTimeAsync } from "@intentic/testing/bun";
import { fakeSandboxRpc } from "../../../testing/sandboxRpcFake";
import { ATTACH_SILENCE_MS, followRun, type RunRenderer, type TurnContext } from "./turnStream";

// The daemon's attach, as a suite scripts it: each call takes the next opening off the list.
interface AttachOptions {
    readonly signal?: AbortSignal;
    readonly context?: { readonly heard?: () => void };
}
const attach = jest.fn<(input: unknown, options?: AttachOptions) => Promise<AsyncIterable<AttachFrame>>>();
jest.mock("../sandboxRpc", () => ({
    sandboxRpc: fakeSandboxRpc({
        agent: {
            // SAFETY: the suite scripts attach's answer itself; the client's own option and answer types are waived here only.
            attach: ((input: unknown, options?: AttachOptions) => attach(input, options)) as never,
        },
    }),
}));

const TURN: TurnContext = { run: `run-1`, provider: `claude`, account: undefined, harness: `claude-code` };
const renderer: RunRenderer = { attached: () => TURN, entry: () => undefined };

// An attach that engages (its head arrives), delivers `entries` rows, and then drops without the run's `end`.
const engagedThenDropped = async function* (entries = 0): AsyncGenerator<AttachFrame> {
    yield { kind: `attached`, run: `run-1`, startedAt: 0, seq: 0, rows: [] };
    for (let seq = 1; seq <= entries; seq += 1) {
        yield { kind: `patch`, seq, patch: { op: `text`, index: 0, text: `more` } };
    }
    throw new Error(`socket closed`);
};

beforeEach(() => {
    jest.useFakeTimers();
    attach.mockReset();
});

afterEach(() => {
    jest.useRealTimers();
});

describe(`followRun`, () => {
    it(`ends at once when stopped during the backoff after a failed re-attach, not when the wait runs out`, async () => {
        // The first attach delivered a row, so its drop re-attaches at once; that one fails on the network.
        attach.mockResolvedValueOnce(engagedThenDropped(1)).mockRejectedValue(new TypeError(`Failed to fetch`));
        const controller = new AbortController();
        // Widened by the cast: the callback assigns it, which narrowing from the initializer would not see.
        let ended = `pending` as boolean | undefined | `pending`;
        void followRun(`cnv-1`, `run-1`, renderer, controller, undefined).then((end) => {
            ended = end;
        });
        // Engaged, dropped, re-attached into a network failure: now in the ladder's wait (at least its 500ms floor).
        await advanceTimersByTimeAsync(0);
        expect(attach).toHaveBeenCalledTimes(2);
        controller.abort();
        await advanceTimersByTimeAsync(0);
        expect(ended).toBe(true);
        // Nothing is tried after the stop.
        await advanceTimersByTimeAsync(10_000);
        expect(attach).toHaveBeenCalledTimes(2);
    });

    it(`ends at once when stopped during the wait after an attach that delivered nothing`, async () => {
        attach.mockImplementationOnce(async () => engagedThenDropped()).mockImplementation(async () => (async function* () {})());
        const controller = new AbortController();
        // Widened by the cast: the callback assigns it, which narrowing from the initializer would not see.
        let ended = `pending` as boolean | undefined | `pending`;
        void followRun(`cnv-1`, `run-1`, renderer, controller, undefined).then((end) => {
            ended = end;
        });
        await advanceTimersByTimeAsync(0);
        // First attach engaged and dropped; its empty round is waiting out the ladder.
        expect(ended).toBe(`pending`);
        controller.abort();
        await advanceTimersByTimeAsync(0);
        expect(ended).toBe(true);
    });

    // A connection a sleeping laptop or a proxy left half-open: the head arrived, then nothing, not even the daemon's
    // keep-alive bytes, and no close either. It hangs until its signal is cut.
    const engagedThenSilent = (options?: AttachOptions): AsyncIterable<AttachFrame> =>
        (async function* () {
            yield { kind: `attached`, run: `run-1`, startedAt: 0, seq: 0, rows: [] } satisfies AttachFrame;
            await new Promise((_resolve, reject) => options?.signal?.addEventListener(`abort`, () => reject(new Error(`aborted`)), { once: true }));
        })();

    it(`attaches again when a stream goes silent, instead of hanging on its last row`, async () => {
        attach.mockImplementationOnce(async (_input, options) => engagedThenSilent(options)).mockImplementation(async () =>
            (async function* () {
                yield { kind: `attached`, run: `run-1`, startedAt: 0, seq: 0, rows: [] } satisfies AttachFrame;
                yield { kind: `end` } satisfies AttachFrame;
            })(),
        );
        // SAFETY: widened by the cast, since the callback assigns it, which narrowing from the initializer would not see.
        let ended = `pending` as boolean | undefined | `pending`;
        void followRun(`cnv-1`, `run-1`, renderer, new AbortController(), undefined).then((end) => {
            ended = end;
        });
        await advanceTimersByTimeAsync(ATTACH_SILENCE_MS - 1);
        expect(attach).toHaveBeenCalledTimes(1);
        await advanceTimersByTimeAsync(1);
        // Cut, and attached again at once: a silent connection is a dead one, not an empty round.
        expect(attach).toHaveBeenCalledTimes(2);
        expect(ended).toBe(true);
    });

    it(`keeps a quiet turn whose keep-alives still arrive`, async () => {
        const controller = new AbortController();
        attach.mockImplementationOnce(async (_input, options) => {
            // The daemon's keep-alive comment, every 5 s: bytes the stream's frames never show.
            const keepAlive = setInterval(() => options?.context?.heard?.(), 5_000);
            options?.signal?.addEventListener(`abort`, () => clearInterval(keepAlive));
            return engagedThenSilent(options);
        });
        void followRun(`cnv-1`, `run-1`, renderer, controller, undefined);
        await advanceTimersByTimeAsync(5 * ATTACH_SILENCE_MS);
        expect(attach).toHaveBeenCalledTimes(1);
        controller.abort();
        await advanceTimersByTimeAsync(0);
    });
});
